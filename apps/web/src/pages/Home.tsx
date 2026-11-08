import { useState } from 'react';
import { api, ApiError, type Me } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { Button, Card, Field, Notice, Wordmark } from '../components/ui.tsx';

const ROLE_LABEL: Record<Me['role'], string> = {
  'bmg-admin': 'BMG admin',
  'bmg-staff': 'BMG staff',
  artist: 'Artist',
};

const NAV = [
  'Overview',
  'Messages',
  'Review queue',
  'Library',
  'Artists',
  'Events',
  'Insights',
  'Newsroom',
];

/** App shell (design: 264px navy sidebar, sticky top bar). Workspace screens arrive in the next Phase 3 PRs. */
export function Home({
  cfg,
  token,
  me,
  onSignOut,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  onSignOut: () => void;
  onReauth: () => void;
}) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[264px_1fr]">
      <aside className="hidden bg-primary p-5 text-primary-foreground md:block">
        <Wordmark light />
        <nav className="mt-8 space-y-1 text-sm">
          {NAV.map((item, i) => (
            <div
              key={item}
              className={`rounded-md px-3 py-2 ${i === 0 ? 'bg-white/10 font-semibold' : 'opacity-60'}`}
              aria-current={i === 0 ? 'page' : undefined}
            >
              {item}
            </div>
          ))}
        </nav>
      </aside>
      <div>
        <header className="sticky top-0 flex h-16 items-center justify-between border-b border-border bg-background/90 px-6 backdrop-blur">
          <span className="md:hidden">
            <Wordmark />
          </span>
          <span className="text-sm text-muted-foreground">{ROLE_LABEL[me.role]}</span>
          <Button variant="ghost" onClick={onSignOut}>
            Sign out
          </Button>
        </header>
        <main className="mx-auto max-w-5xl space-y-6 p-6">
          <h1 className="font-title text-3xl">
            {me.role === 'artist' ? 'Your workspace' : 'Studio HQ'}
          </h1>
          <Card title="You're signed in">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[160px_1fr]">
              <dt className="text-muted-foreground">Role</dt>
              <dd>{ROLE_LABEL[me.role]}</dd>
              {me.artistId && (
                <>
                  <dt className="text-muted-foreground">Artist id</dt>
                  <dd className="font-mono text-xs">{me.artistId}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Two-step verification</dt>
              <dd>
                {me.mfaLevel === 'cognito'
                  ? 'Cognito (passkey or authenticator)'
                  : 'App step-up (social sign-in)'}
              </dd>
              <dt className="text-muted-foreground">AI assistance</dt>
              <dd>{me.consent?.aiOptIn ? 'On' : 'Off'}</dd>
            </dl>
            <p className="mt-4 text-sm text-muted-foreground">
              The workspace screens (plans, to-dos, review queue, files, messages) are being built
              next.
            </p>
          </Card>
          {me.role === 'bmg-admin' && <InviteArtist cfg={cfg} token={token} onReauth={onReauth} />}
        </main>
      </div>
    </div>
  );
}

function InviteArtist({
  cfg,
  token,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  onReauth: () => void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [result, setResult] = useState<{
    tone: 'success' | 'error';
    text: string;
    reauth?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function invite() {
    setBusy(true);
    setResult(null);
    try {
      const res = await api<{ artistId: string }>(cfg, token, 'POST', '/artists', {
        email,
        displayName,
      });
      setResult({
        tone: 'success',
        text: `Invited ${displayName} (${res.artistId}). Their key is being created.`,
      });
      setEmail('');
      setDisplayName('');
    } catch (e) {
      const reauth = e instanceof ApiError && e.status === 403 && /step-up/.test(e.message);
      setResult({
        tone: 'error',
        text: reauth ? 'For security, sign in again to invite artists.' : (e as Error).message,
        reauth,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Invite an artist">
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void invite();
        }}
      >
        <Field
          label="Artist name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          maxLength={120}
        />
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="cta" disabled={busy}>
            Send invite
          </Button>
          {result?.reauth && (
            <Button type="button" variant="ghost" onClick={onReauth}>
              Sign in again
            </Button>
          )}
        </div>
      </form>
      {result && (
        <div className="mt-4">
          <Notice tone={result.tone}>{result.text}</Notice>
        </div>
      )}
    </Card>
  );
}
