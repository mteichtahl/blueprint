import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ArtistSummary, type Me } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { Button, Card, Field, Notice, Wordmark } from '../components/ui.tsx';
import { PlanTab } from './Plan.tsx';
import { ArtistFiles, Library } from './Library.tsx';
import { AllTodos, ArtistTodos } from './Todos.tsx';

const ROLE_LABEL: Record<Me['role'], string> = {
  'bmg-admin': 'BMG admin',
  'bmg-staff': 'BMG staff',
  artist: 'Artist',
};

type View = 'overview' | 'artists' | 'todos' | 'library' | 'plan' | 'my-todos' | 'my-library';
const BMG_NAV: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'artists', label: 'Artists' },
  { id: 'todos', label: 'Tasks & to-dos' },
  { id: 'library', label: 'Library' },
];
const ARTIST_NAV: { id: View; label: string }[] = [
  { id: 'overview', label: 'Home' },
  { id: 'plan', label: 'My plan' },
  { id: 'my-todos', label: 'To-do' },
  { id: 'my-library', label: 'Library' },
];
/** Shown greyed out until their Phase 3 PRs land. */
const COMING = ['Messages', 'Review queue'];

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
  const isBmg = me.role !== 'artist';
  const nav = isBmg ? BMG_NAV : ARTIST_NAV;
  const [view, setView] = useState<View>('overview');
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [openArtist, setOpenArtist] = useState<ArtistSummary | null>(null);
  const loadArtists = useCallback(async () => {
    if (!isBmg) return;
    setArtists((await api<{ artists: ArtistSummary[] }>(cfg, token, 'GET', '/artists')).artists);
  }, [cfg, token, isBmg]);
  useEffect(() => void loadArtists(), [loadArtists]);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[264px_1fr]">
      <aside className="hidden bg-primary p-5 text-primary-foreground md:block">
        <Wordmark light />
        <nav className="mt-8 space-y-1 text-sm" aria-label="Main">
          {nav.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setView(item.id);
                setOpenArtist(null);
              }}
              className={`block w-full rounded-md px-3 py-2 text-left ${view === item.id ? 'bg-white/10 font-semibold' : 'hover:bg-white/5'}`}
              aria-current={view === item.id ? 'page' : undefined}
            >
              {item.label}
            </button>
          ))}
          {COMING.map((item) => (
            <div key={item} className="rounded-md px-3 py-2 opacity-40" title="Coming soon">
              {item}
            </div>
          ))}
        </nav>
      </aside>
      <div>
        <header className="sticky top-0 flex h-16 items-center justify-between border-b border-border bg-background/90 px-6 backdrop-blur">
          <span className="flex items-center gap-3 md:hidden">
            <Wordmark />
            <select
              className="h-9 rounded-md border border-input bg-white px-2 text-sm"
              value={view}
              aria-label="Go to"
              onChange={(e) => {
                setView(e.target.value as View);
                setOpenArtist(null);
              }}
            >
              {nav.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </span>
          <span className="text-sm text-muted-foreground">{ROLE_LABEL[me.role]}</span>
          <Button variant="ghost" onClick={onSignOut}>
            Sign out
          </Button>
        </header>
        <main className="mx-auto max-w-5xl space-y-6 p-6">
          {view === 'artists' &&
            (openArtist ? (
              <ArtistWorkspace
                cfg={cfg}
                token={token}
                artist={openArtist}
                onBack={() => setOpenArtist(null)}
              />
            ) : (
              <Roster artists={artists} onOpen={setOpenArtist} />
            ))}
          {view === 'todos' && <AllTodos cfg={cfg} token={token} artists={artists} />}
          {view === 'library' && (
            <>
              <h1 className="font-title text-3xl">Document library</h1>
              <Library cfg={cfg} token={token} isBmg artists={artists} />
            </>
          )}
          {view === 'my-library' && me.artistId && (
            <>
              <h1 className="font-title text-3xl">Library</h1>
              <ArtistFiles cfg={cfg} token={token} artistId={me.artistId} isBmg={false} />
              <h2 className="pt-4 font-title text-2xl">Shared by Blueprint</h2>
              <Library cfg={cfg} token={token} isBmg={false} artists={[]} />
            </>
          )}
          {view === 'plan' && me.artistId && (
            <>
              <h1 className="font-title text-3xl">My plan</h1>
              <PlanTab cfg={cfg} token={token} artistId={me.artistId} canEdit={false} />
            </>
          )}
          {view === 'my-todos' && me.artistId && (
            <>
              <h1 className="font-title text-3xl">To-do</h1>
              <ArtistTodos cfg={cfg} token={token} artistId={me.artistId} isBmg={false} />
            </>
          )}
          {view === 'overview' && (
            <>
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
              </Card>
              {me.role === 'bmg-admin' && (
                <InviteArtist
                  cfg={cfg}
                  token={token}
                  onReauth={onReauth}
                  onInvited={() => void loadArtists()}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function InviteArtist({
  cfg,
  token,
  onReauth,
  onInvited,
}: {
  cfg: AppConfig;
  token: string;
  onReauth: () => void;
  onInvited: () => void;
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
      onInvited();
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

function Roster({
  artists,
  onOpen,
}: {
  artists: ArtistSummary[];
  onOpen: (a: ArtistSummary) => void;
}) {
  return (
    <Card title="Artists">
      {artists.length === 0 ? (
        <p className="text-sm text-muted-foreground">No artists yet. Invite one from Overview.</p>
      ) : (
        <ul className="divide-y divide-border">
          {artists.map((a) => (
            <li key={a.artistId}>
              <button
                className="flex w-full items-center justify-between py-3 text-left hover:opacity-80"
                onClick={() => onOpen(a)}
              >
                <span className="font-semibold">{a.displayName}</span>
                <span className="rounded-md bg-secondary px-2 py-0.5 text-xs font-semibold">
                  {a.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const TABS = ['Plan', 'To-do', 'Library'] as const;

/** Artist workspace (BMG view): header plus tabs. Chat, submissions, gigs and stats arrive in later PRs. */
function ArtistWorkspace({
  cfg,
  token,
  artist,
  onBack,
}: {
  cfg: AppConfig;
  token: string;
  artist: ArtistSummary;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Plan');
  return (
    <div className="space-y-4">
      <button className="text-sm text-muted-foreground hover:underline" onClick={onBack}>
        ← All artists
      </button>
      <h1 className="font-title text-3xl">{artist.displayName}</h1>
      <div className="flex gap-1 border-b border-border" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === t ? 'border-accent' : 'border-transparent text-muted-foreground'}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'Plan' && <PlanTab cfg={cfg} token={token} artistId={artist.artistId} canEdit />}
      {tab === 'To-do' && <ArtistTodos cfg={cfg} token={token} artistId={artist.artistId} isBmg />}
      {tab === 'Library' && (
        <ArtistFiles cfg={cfg} token={token} artistId={artist.artistId} isBmg />
      )}
    </div>
  );
}
