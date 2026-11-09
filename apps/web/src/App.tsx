import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './lib/api.ts';
import { auth, currentUser, signOut } from './lib/auth.ts';
import { loadConfig, type AppConfig } from './lib/config.ts';
import { Notice } from './components/ui.tsx';
import { Consent } from './pages/Consent.tsx';
import { Home } from './pages/Home.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { StepUp } from './pages/StepUp.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'signedOut'; cfg: AppConfig }
  | { kind: 'ready'; cfg: AppConfig; token: string; me: Me; userName: string };

/**
 * Sign-in → (step-up for social sign-ins) → consent on first use → workspace.
 * Every check is enforced by the API; the app only follows its answers.
 */
export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const refresh = useCallback(async (cfg: AppConfig) => {
    const user = await currentUser(cfg);
    if (!user) return setState({ kind: 'signedOut', cfg });
    const me = await api<Me>(cfg, user.access_token, 'GET', '/me');
    const p = user.profile;
    const userName =
      [p.given_name, p.family_name].filter(Boolean).join(' ') ||
      p.name ||
      (p.email ?? '').split('@')[0] ||
      'there';
    setState({ kind: 'ready', cfg, token: user.access_token, me, userName });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await loadConfig();
        if (window.location.pathname === '/auth/callback') {
          await auth(cfg).signinRedirectCallback();
          window.history.replaceState({}, '', '/');
        }
        await refresh(cfg);
      } catch (e) {
        setState({ kind: 'error', message: (e as Error).message });
      }
    })();
  }, [refresh]);

  if (state.kind === 'loading') {
    return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  }
  if (state.kind === 'error') {
    return (
      <main className="mx-auto max-w-md p-8">
        <Notice tone="error">{state.message}</Notice>
      </main>
    );
  }
  if (state.kind === 'signedOut') {
    return (
      <SignIn
        signedOut={window.location.pathname === '/signed-out'}
        onSignIn={() => void auth(state.cfg).signinRedirect()}
      />
    );
  }

  const { cfg, token, me, userName } = state;
  const reload = () => void refresh(cfg);
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
    <Home
      cfg={cfg}
      token={token}
      me={me}
      userName={userName}
      onSignOut={() => void signOut(cfg)}
      // Admin actions need a sign-in within 5 minutes (design 6.3); prompt=login forces a fresh one.
      onReauth={() => void auth(cfg).signinRedirect({ prompt: 'login' })}
    />
  );
}
