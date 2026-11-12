import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Me } from './lib/api.ts';
import {
  currentSession,
  profileOf,
  refresh,
  signOut,
  storeTokens,
  type Session,
} from './lib/auth.ts';
import { finishSocial, isSocialCallback } from './lib/social.ts';
import { loadConfig, type AppConfig } from './lib/config.ts';
import { captureCallback } from './lib/connectors.ts';
import { Notice, WaveLoader } from './components/ui.tsx';
import { WhatsNew } from './components/WhatsNew.tsx';
import { Consent } from './pages/Consent.tsx';
import { Home } from './pages/Home.tsx';
import { NewsletterSignup } from './pages/NewsletterSignup.tsx';
import { SignIn, type SignInReason } from './pages/SignIn.tsx';
import { StepUp } from './pages/StepUp.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'signedOut'; cfg: AppConfig; reason?: SignInReason; problem?: string }
  | { kind: 'public' }
  | { kind: 'ready'; cfg: AppConfig; token: string; me: Me; userName: string };

function nameOf(s: Session): string {
  const p = profileOf(s);
  return (
    [p.given_name, p.family_name].filter(Boolean).join(' ') ||
    p.name ||
    (p.email ?? '').split('@')[0] ||
    'there'
  );
}

/**
 * Sign-in (Blueprint's own screens) → (step-up for social sign-ins) → consent
 * on first use → workspace. Every check is enforced by the API; the app only
 * follows its answers.
 */
export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const enter = useCallback(async (cfg: AppConfig, session: Session) => {
    const me = await api<Me>(cfg, session.accessToken, 'GET', '/me');
    setState({ kind: 'ready', cfg, token: session.accessToken, me, userName: nameOf(session) });
    // Swap in a fresh access token a minute before this one expires.
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        void refresh(cfg).then((next) =>
          next ? enter(cfg, next) : setState({ kind: 'signedOut', cfg, reason: 'expired' }),
        );
      },
      Math.max(session.expiresAt - Date.now() - 60_000, 5_000),
    );
  }, []);

  const resume = useCallback(
    async (cfg: AppConfig) => {
      const session = await currentSession(cfg);
      if (!session) return setState({ kind: 'signedOut', cfg });
      await enter(cfg, session);
    },
    [enter],
  );

  useEffect(() => {
    void (async () => {
      try {
        // The public newsletter sign-up page needs no account.
        if (/^\/newsletter\/?$/.test(window.location.pathname)) return setState({ kind: 'public' });
        // A connector's sign-in returns here; keep its code for the Connectors page.
        captureCallback();
        const cfg = await loadConfig();
        // Back from Google, Apple or Facebook (design D2): swap the code for tokens.
        const url = new URL(window.location.href);
        if (isSocialCallback(url)) {
          window.history.replaceState({}, '', '/');
          const done = await finishSocial(cfg, url);
          if ('redirecting' in done) return;
          if ('error' in done) return setState({ kind: 'signedOut', cfg, problem: done.error });
          await enter(cfg, await storeTokens(done.tokens));
          return;
        }
        if (/^\/signed-out/.test(window.location.pathname)) {
          window.history.replaceState({}, '', '/');
        }
        await resume(cfg);
      } catch (e) {
        setState({ kind: 'error', message: (e as Error).message });
      }
    })();
    return () => clearTimeout(timer.current);
  }, [resume, enter]);

  if (state.kind === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <WaveLoader size={88} />
      </div>
    );
  }
  if (state.kind === 'public') return <NewsletterSignup />;
  if (state.kind === 'error') {
    return (
      <main className="mx-auto max-w-md p-8">
        <Notice tone="error">{state.message}</Notice>
      </main>
    );
  }
  if (state.kind === 'signedOut') {
    const { cfg } = state;
    return (
      <SignIn
        cfg={cfg}
        reason={state.reason}
        {...(state.problem ? { problem: state.problem } : {})}
        onSignedIn={(session) =>
          void enter(cfg, session).catch((e: Error) =>
            setState({ kind: 'error', message: e.message }),
          )
        }
      />
    );
  }

  const { cfg, token, me, userName } = state;
  const reload = () => void resume(cfg);
  const leave = (reason: SignInReason) => {
    clearTimeout(timer.current);
    void signOut(cfg).then(() => setState({ kind: 'signedOut', cfg, reason }));
  };
  if (me.stepUpRequired) return <StepUp cfg={cfg} token={token} onVerified={reload} />;
  if (!me.consent)
    return (
      <Consent
        cfg={cfg}
        token={token}
        isArtist={me.role === 'artist'}
        firstName={userName.split(' ')[0]!}
        onDone={reload}
      />
    );
  return (
    <>
      <Home
        cfg={cfg}
        token={token}
        me={me}
        userName={userName}
        onSignOut={() => leave('signedOut')}
        // Admin actions need a sign-in within 5 minutes (design 6.3): sign in again on our screens.
        onReauth={() => leave('reauth')}
      />
      {/* Once per release, after sign-in and consent (CHANGELOG.md). */}
      <WhatsNew />
    </>
  );
}
