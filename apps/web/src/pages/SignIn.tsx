import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { AppConfig } from '../lib/config.ts';
import {
  associateTotp,
  asChoice,
  choosePasskey,
  choosePassword,
  CognitoError,
  completePasskeyRegistration,
  confirmForgotPassword,
  forgotPassword,
  listPasskeys,
  otpauthUri,
  respond,
  start,
  startPasskeyRegistration,
  startWithPassword,
  verifyTotpSetup,
  type Step,
} from '../lib/cognito.ts';
import { lastEmail, rememberEmail, storeTokens, type Session } from '../lib/auth.ts';
import { cancelled, createPasskey, getPasskey, passkeysSupported } from '../lib/webauthn.ts';
import { AuthFrame } from '../components/Shell.tsx';
import { Button, Card, Field, Notice } from '../components/ui.tsx';

/**
 * Blueprint's own sign-in (design 6.1), on Cognito's user-pool API rather
 * than the hosted UI: email, then a passkey or password; a new password and
 * an authenticator on first sign-in; a 6-digit code every time after that.
 * Accounts are by invitation, so there is no sign-up.
 */

type Screen =
  | { kind: 'email' }
  | Exclude<Step, { kind: 'done' }>
  | { kind: 'forgot'; sent: boolean }
  | { kind: 'offerPasskey'; session: Session }
  | { kind: 'working'; label: string };

export type SignInReason = 'signedOut' | 'expired' | 'reauth' | undefined;

const HEADINGS: Record<NonNullable<SignInReason> | 'default', [string, string]> = {
  default: ['Sign in', 'Welcome to Blueprint'],
  signedOut: ['Signed out', 'See you soon'],
  expired: ['Session ended', 'Welcome back'],
  reauth: ['Confirm it’s you', 'One more check'],
};

export function SignIn({
  cfg,
  reason,
  onSignedIn,
}: {
  cfg: AppConfig;
  reason?: SignInReason;
  onSignedIn: (s: Session) => void;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: 'email' });
  const [email, setEmail] = useState(lastEmail());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    reason === 'reauth' ? 'This action needs a recent sign-in. Please sign in again.' : null,
  );
  const [eyebrow, title] = HEADINGS[reason ?? 'default'];

  /** Runs a step, showing progress and any error, then moves to what Cognito asks next. */
  async function run(label: string, fn: () => Promise<Step | void>, back?: Screen) {
    const before = screen;
    setError(null);
    setScreen({ kind: 'working', label });
    try {
      const next = await fn();
      if (next) await advance(next);
    } catch (e) {
      if (cancelled(e))
        setError('The passkey request was cancelled. Try again, or use your password.');
      else setError(e instanceof Error ? e.message : String(e));
      // A failed or cancelled answer uses up Cognito's session: start the account's sign-in again.
      if (
        (e instanceof CognitoError || cancelled(e)) &&
        before.kind !== 'email' &&
        before.kind !== 'forgot'
      ) {
        try {
          const fresh = asChoice(await start(cfg, email));
          if (fresh.kind === 'choose') return setScreen(fresh);
        } catch {
          // fall through to the email screen
        }
        return setScreen({ kind: 'email' });
      }
      setScreen(back ?? before);
    }
  }

  async function advance(step: Step) {
    if (step.kind !== 'done') {
      if (step.kind === 'passkey') {
        // The passkey prompt comes straight up; the device does the rest.
        const credential = await getPasskey(step.options);
        return advance(
          await respond(cfg, 'WEB_AUTHN', step.session, {
            USERNAME: email,
            CREDENTIAL: JSON.stringify(credential),
          }),
        );
      }
      return setScreen(step);
    }
    rememberEmail(email);
    const session = await storeTokens(step.tokens);
    // Offer a passkey to people who signed in another way and have none yet.
    if (passkeysSupported() && !offerDismissed(email)) {
      const count = await listPasskeys(cfg, session.accessToken).catch(() => 1);
      if (count === 0) return setScreen({ kind: 'offerPasskey', session });
    }
    onSignedIn(session);
  }

  const startOver = () => {
    setError(null);
    setScreen({ kind: 'email' });
  };

  return (
    <AuthFrame eyebrow={eyebrow} title={title} sub="Your artist development workspace.">
      <Card>
        {screen.kind === 'email' && (
          <EmailStep
            email={email}
            setEmail={setEmail}
            notice={notice}
            onSubmit={() => {
              setNotice(null);
              void run('Checking your account…', async () =>
                asChoice(await start(cfg, email.trim().toLowerCase())),
              );
            }}
          />
        )}

        {screen.kind === 'choose' && (
          <ChooseStep
            email={email}
            passkey={screen.passkey && passkeysSupported()}
            onChange={startOver}
            onPasskey={() =>
              void run('Waiting for your passkey…', () =>
                screen.passkeyOptions
                  ? Promise.resolve({
                      kind: 'passkey' as const,
                      session: screen.session,
                      options: screen.passkeyOptions,
                    })
                  : choosePasskey(cfg, screen.session, email),
              )
            }
            onPassword={(password) =>
              void run('Signing in…', () =>
                screen.passkeyOptions
                  ? startWithPassword(cfg, email, password)
                  : choosePassword(cfg, screen.session, email, password),
              )
            }
            onForgot={() => {
              setError(null);
              setScreen({ kind: 'forgot', sent: false });
            }}
          />
        )}

        {screen.kind === 'newPassword' && (
          <NewPasswordStep
            onSubmit={(password) =>
              void run('Saving your password…', () =>
                respond(cfg, 'NEW_PASSWORD_REQUIRED', screen.session, {
                  USERNAME: email,
                  NEW_PASSWORD: password,
                }),
              )
            }
          />
        )}

        {screen.kind === 'mfaSetup' && (
          <MfaSetupStep
            cfg={cfg}
            email={email}
            session={screen.session}
            onError={(m) => setError(m)}
            onVerified={(session) =>
              void run('Finishing set-up…', () =>
                respond(cfg, 'MFA_SETUP', session, { USERNAME: email }),
              )
            }
          />
        )}

        {screen.kind === 'mfaCode' && (
          <CodeStep
            onSubmit={(code) =>
              void run('Checking your code…', () =>
                respond(cfg, 'SOFTWARE_TOKEN_MFA', screen.session, {
                  USERNAME: email,
                  SOFTWARE_TOKEN_MFA_CODE: code,
                }),
              )
            }
            onCancel={startOver}
          />
        )}

        {screen.kind === 'forgot' && (
          <ForgotStep
            email={email}
            setEmail={setEmail}
            sent={screen.sent}
            onSend={() =>
              void run(
                'Sending a code…',
                async () => {
                  await forgotPassword(cfg, email.trim().toLowerCase());
                  setScreen({ kind: 'forgot', sent: true });
                },
                { kind: 'forgot', sent: false },
              )
            }
            onReset={(code, password) =>
              void run(
                'Saving your new password…',
                async () => {
                  await confirmForgotPassword(cfg, email.trim().toLowerCase(), code, password);
                  setNotice('Password changed. Sign in with your new password.');
                  setScreen({ kind: 'email' });
                },
                { kind: 'forgot', sent: true },
              )
            }
            onBack={startOver}
          />
        )}

        {screen.kind === 'offerPasskey' && (
          <OfferPasskeyStep
            cfg={cfg}
            session={screen.session}
            onDone={(dismissed) => {
              if (dismissed) dismissOffer(email);
              onSignedIn(screen.session);
            }}
          />
        )}

        {screen.kind === 'working' && (
          <p role="status" aria-live="polite" className="m-0 py-6 text-center text-[15px]">
            {screen.label}
          </p>
        )}

        {error && <Notice tone="error">{error}</Notice>}
      </Card>
      <span className="src text-center">
        Accounts are by invitation from Blueprint. Two-step verification is required for everyone.
      </span>
    </AuthFrame>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────

function Heading({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <>
      <h2 className="t m-0 text-[22px]">{title}</h2>
      {sub && <p className="m-0 text-[15px] text-muted-foreground">{sub}</p>}
    </>
  );
}

function EmailStep({
  email,
  setEmail,
  notice,
  onSubmit,
}: {
  email: string;
  setEmail: (v: string) => void;
  notice: string | null;
  onSubmit: () => void;
}) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Heading title="Sign in" sub="Enter the email Blueprint invited you with." />
      {notice && <Notice tone="success">{notice}</Notice>}
      <Field
        label="Email"
        type="email"
        autoComplete="username webauthn"
        inputMode="email"
        autoFocus
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Button type="submit" variant="cta" className="min-h-[50px] w-full" disabled={!email.trim()}>
        Continue
      </Button>
    </form>
  );
}

function ChooseStep({
  email,
  passkey,
  onChange,
  onPasskey,
  onPassword,
  onForgot,
}: {
  email: string;
  passkey: boolean;
  onChange: () => void;
  onPasskey: () => void;
  onPassword: (password: string) => void;
  onForgot: () => void;
}) {
  const [password, setPassword] = useState('');
  return (
    <div className="flex flex-col gap-3">
      <Heading title="Welcome back" />
      <div className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-[15px]">
        <span className="min-w-0 flex-1 truncate font-semibold">{email}</span>
        <button type="button" className="text-sm font-bold underline" onClick={onChange}>
          Change
        </button>
      </div>
      {passkey && (
        <>
          <Button variant="cta" className="min-h-[50px] w-full" onClick={onPasskey}>
            Sign in with a passkey
          </Button>
          <p className="-mt-1 text-sm text-muted-foreground">
            Face ID, Touch ID, Windows Hello or your security key. No code needed.
          </p>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="h-px flex-1 bg-input" />
            or use your password
            <span className="h-px flex-1 bg-input" />
          </div>
        </>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) onPassword(password);
        }}
      >
        <input type="email" hidden readOnly autoComplete="username" value={email} />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          autoFocus={!passkey}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button
          type="submit"
          variant={passkey ? 'default' : 'cta'}
          className="min-h-[50px] w-full"
          disabled={!password}
        >
          Sign in with password
        </Button>
        <p className="-mt-1 text-sm text-muted-foreground">
          Then enter the 6-digit code from your authenticator app.
        </p>
      </form>
      <button type="button" className="self-start text-sm font-bold underline" onClick={onForgot}>
        Forgot your password?
      </button>
    </div>
  );
}

/** Same rules as the user pool (identity-stack.ts). */
export function passwordProblems(p: string): string[] {
  const out: string[] = [];
  if (p.length < 12) out.push('at least 12 characters');
  if (!/[a-z]/.test(p)) out.push('a lower-case letter');
  if (!/[A-Z]/.test(p)) out.push('an upper-case letter');
  if (!/\d/.test(p)) out.push('a number');
  if (!/[^A-Za-z0-9]/.test(p)) out.push('a symbol');
  return out;
}

function NewPasswordFields({
  onSubmit,
  submitLabel,
  extra,
}: {
  onSubmit: (password: string) => void;
  submitLabel: string;
  extra?: React.ReactNode;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const problems = passwordProblems(password);
  const mismatch = again.length > 0 && again !== password;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0 && !mismatch && again) onSubmit(password);
      }}
    >
      {extra}
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={
          password && problems.length
            ? `Still needs ${problems.join(', ')}.`
            : 'At least 12 characters, with upper and lower case letters, a number and a symbol.'
        }
      />
      <Field
        label="Type it again"
        type="password"
        autoComplete="new-password"
        required
        value={again}
        onChange={(e) => setAgain(e.target.value)}
        hint={mismatch ? 'The two passwords don’t match.' : undefined}
      />
      <Button
        type="submit"
        variant="cta"
        className="min-h-[50px] w-full"
        disabled={problems.length > 0 || mismatch || !again}
      >
        {submitLabel}
      </Button>
    </form>
  );
}

function NewPasswordStep({ onSubmit }: { onSubmit: (password: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <Heading
        title="Choose your password"
        sub="Welcome! Replace the temporary password from your invitation with your own."
      />
      <NewPasswordFields onSubmit={onSubmit} submitLabel="Save password" />
    </div>
  );
}

function MfaSetupStep({
  cfg,
  email,
  session,
  onVerified,
  onError,
}: {
  cfg: AppConfig;
  email: string;
  session: string;
  onVerified: (session: string) => void;
  onError: (message: string) => void;
}) {
  const [setup, setSetup] = useState<{ secret: string; session: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const res = await associateTotp(cfg, session);
        const qr = await QRCode.toDataURL(otpauthUri(res.secret, email), {
          margin: 1,
          width: 184,
          color: { dark: '#011935', light: '#FFFFFF' },
        });
        setSetup({ ...res, qr });
      } catch (e) {
        onError((e as Error).message);
      }
    })();
  }, [cfg, session, email, onError]);

  if (!setup) return <p className="m-0 py-6 text-center text-[15px]">Preparing your set-up…</p>;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          onVerified(await verifyTotpSetup(cfg, setup.session, code));
        } catch (err) {
          onError((err as Error).message);
          setCode('');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Heading
        title="Set up two-step verification"
        sub="Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then enter the 6-digit code it shows."
      />
      <div className="flex flex-wrap items-center gap-4">
        <img
          src={setup.qr}
          width={184}
          height={184}
          alt="QR code for your authenticator app"
          className="rounded-lg border border-input"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
          <a className="font-semibold underline" href={otpauthUri(setup.secret, email)}>
            On this phone? Open in your authenticator
          </a>
          <span className="text-muted-foreground">Or add this key by hand:</span>
          <code className="break-all rounded bg-secondary px-2 py-1 font-mono text-xs">
            {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
          </code>
        </div>
      </div>
      <CodeField code={code} setCode={setCode} />
      <Button
        type="submit"
        variant="cta"
        className="min-h-[50px] w-full"
        disabled={busy || code.length !== 6}
      >
        {busy ? 'Checking…' : 'Verify and continue'}
      </Button>
    </form>
  );
}

function CodeField({ code, setCode }: { code: string; setCode: (c: string) => void }) {
  return (
    <Field
      label="6-digit code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d{6}"
      maxLength={6}
      autoFocus
      required
      value={code}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
    />
  );
}

function CodeStep({
  onSubmit,
  onCancel,
}: {
  onSubmit: (code: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 6) onSubmit(code);
      }}
    >
      <Heading
        title="Two-step verification"
        sub="Enter the 6-digit code from your authenticator app."
      />
      <CodeField code={code} setCode={setCode} />
      <Button
        type="submit"
        variant="cta"
        className="min-h-[50px] w-full"
        disabled={code.length !== 6}
      >
        Verify
      </Button>
      <button type="button" className="self-start text-sm font-bold underline" onClick={onCancel}>
        Use a different account
      </button>
    </form>
  );
}

function ForgotStep({
  email,
  setEmail,
  sent,
  onSend,
  onReset,
  onBack,
}: {
  email: string;
  setEmail: (v: string) => void;
  sent: boolean;
  onSend: () => void;
  onReset: (code: string, password: string) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  return (
    <div className="flex flex-col gap-3">
      <Heading
        title="Reset your password"
        sub={
          sent
            ? 'If that email has an account, we’ve sent it a 6-digit code. Enter it with your new password.'
            : 'We’ll email you a code to set a new password.'
        }
      />
      {!sent ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <Field
            label="Email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button
            type="submit"
            variant="cta"
            className="min-h-[50px] w-full"
            disabled={!email.trim()}
          >
            Send code
          </Button>
        </form>
      ) : (
        <NewPasswordFields
          submitLabel="Set new password"
          onSubmit={(password) => onReset(code, password)}
          extra={<CodeField code={code} setCode={setCode} />}
        />
      )}
      <button type="button" className="self-start text-sm font-bold underline" onClick={onBack}>
        Back to sign in
      </button>
    </div>
  );
}

const OFFER_KEY = 'bmg.passkeyOffer.dismissed';
function offerDismissed(email: string): boolean {
  try {
    return (localStorage.getItem(OFFER_KEY) ?? '').split(',').includes(email);
  } catch {
    return false;
  }
}
function dismissOffer(email: string) {
  try {
    const list = (localStorage.getItem(OFFER_KEY) ?? '').split(',').filter(Boolean);
    localStorage.setItem(OFFER_KEY, [...new Set([...list, email])].join(','));
  } catch {
    // ignore
  }
}

/** After sign-in: create a passkey for faster sign-ins (design 6.1). */
function OfferPasskeyStep({
  cfg,
  session,
  onDone,
}: {
  cfg: AppConfig;
  session: Session;
  onDone: (dismissed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const options = await startPasskeyRegistration(cfg, session.accessToken);
      const credential = await createPasskey(options);
      await completePasskeyRegistration(cfg, session.accessToken, credential);
      setCreated(true);
    } catch (e) {
      setError(
        cancelled(e)
          ? 'No passkey was created. You can try again, or skip for now.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  if (created) {
    return (
      <div className="flex flex-col gap-3">
        <Heading
          title="Passkey created"
          sub="Next time, sign in with your fingerprint, face or device PIN."
        />
        <Button variant="cta" className="min-h-[50px] w-full" onClick={() => onDone(false)}>
          Continue
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Heading
        title="Sign in faster next time"
        sub="Create a passkey on this device. It uses your fingerprint, face or device PIN, so there’s no password or code to type."
      />
      <Button
        variant="cta"
        className="min-h-[50px] w-full"
        disabled={busy}
        onClick={() => void create()}
      >
        {busy ? 'Waiting for your device…' : 'Create a passkey'}
      </Button>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => onDone(false)}>
          Not now
        </Button>
        <Button variant="ghost" onClick={() => onDone(true)}>
          Don’t ask again on this device
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
