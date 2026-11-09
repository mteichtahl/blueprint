import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ArtistSummary,
  type Me,
  type PlanResponse,
  type SubmissionSummary,
  type Todo,
} from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import type { FileItem } from '../lib/files.ts';
import { overallProgress, phaseProgress } from '../lib/plan.ts';
import { hasPendingCallback } from '../lib/connectors.ts';
import { BmgConnectors, MyConnectors } from './Connectors.tsx';
import { ArtistStats, Insights } from './Insights.tsx';
import {
  ArtistShell,
  BmgShell,
  PhoneHeader,
  useTheme,
  type NavSection,
} from '../components/Shell.tsx';
import {
  Avatar,
  Bar,
  Button,
  Card,
  DataTable,
  Field,
  Icon,
  Notice,
  PageHeader,
  shortDate,
  Tag,
} from '../components/ui.tsx';
import { Assistant } from '../components/Assistant.tsx';
import { Bell } from '../components/Bell.tsx';
import { useNotifications, type AppNotification } from '../lib/notifications.ts';
import { useDeepLink } from '../lib/push.ts';
import { ArtistFiles, Library } from './Library.tsx';
import { Profile } from './Profile.tsx';
import { ArtistChats, BmgChat, useInbox, type ConversationSummary } from './Messages.tsx';
import { markdownToText } from '../lib/markdown.ts';
import { PlanStages, PlanTab } from './PlanLazy.tsx';
import { ArtistSubmissions, PRIORITY_TAG, ReviewQueue } from './Review.tsx';
import { AllTodos, ArtistTodos } from './Todos.tsx';
import { Events } from './Events.tsx';
import { Prompts } from './Prompts.tsx';
import { Newsroom } from './Newsroom.tsx';
import { AllGigs, ArtistGigs } from './Gigs.tsx';
import { ArtistWorkspace } from './Workspace.tsx';

const ROLE_LABEL: Record<Me['role'], string> = {
  'bmg-admin': 'BMG admin',
  'bmg-staff': 'BMG staff',
  artist: 'Artist',
};

export interface HomeProps {
  cfg: AppConfig;
  token: string;
  me: Me;
  userName: string;
  onSignOut: () => void;
  onReauth: () => void;
}

/** BMG staff get the desktop app; artists get the phone app (screens doc). */
export function Home(props: HomeProps) {
  return props.me.role === 'artist' ? <ArtistApp {...props} /> : <BmgApp {...props} />;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ═════════════════════════════ BMG desktop ═════════════════════════════

function BmgApp({ cfg, token, me, userName, onSignOut, onReauth }: HomeProps) {
  const [theme, setTheme] = useTheme();
  // Back from a vendor's sign-in page: open Connectors to finish connecting.
  const [view, setView] = useState(hasPendingCallback() ? 'connectors' : 'overview');
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [openReviews, setOpenReviews] = useState<SubmissionSummary[]>([]);
  const [gigHelp, setGigHelp] = useState(0);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    const [roster, queue, help] = await Promise.all([
      api<{ artists: ArtistSummary[] }>(cfg, token, 'GET', '/artists'),
      api<{ submissions: SubmissionSummary[] }>(cfg, token, 'GET', '/review-queue?status=open'),
      api<{ gigs: unknown[] }>(cfg, token, 'GET', '/gigs?filter=help').catch(() => ({ gigs: [] })),
    ]);
    setArtists(roster.artists);
    setOpenReviews(queue.submissions);
    setGigHelp(help.gigs.length);
  }, [cfg, token]);
  useEffect(() => void load().catch(() => undefined), [load]);

  const inbox = useInbox(cfg, token, me);
  const notes = useNotifications(cfg, token, me.sub);
  const [chatTarget, setChatTarget] = useState<string | null>(null);
  const openChat = (id: string | null) => {
    setChatTarget(id);
    setView('messages');
  };
  const LINK_VIEWS: Record<string, string> = {
    review: 'review',
    library: 'library',
    submit: 'review',
    gigs: 'gigs',
    connectors: 'connectors',
  };
  const goTo = (link: string) =>
    link.startsWith('chat:')
      ? openChat(link.slice('chat:'.length) || null)
      : setView(LINK_VIEWS[link] ?? 'overview');
  useDeepLink(goTo);
  const openNotification = (n: AppNotification) => {
    void notes.markRead([n.id]);
    goTo(n.link);
  };
  const unread = inbox.unreadChats;
  const reviewsFor = (id: string) => openReviews.filter((s) => s.artistId === id).length;
  const sections: NavSection[] = [
    { items: [{ id: 'overview', label: 'Overview', icon: 'home' }] },
    {
      label: 'ARTIST WORKSPACES',
      items: [
        ...artists.slice(0, 8).map((a) => ({
          id: `artist:${a.artistId}`,
          label: a.displayName,
          avatar: a.displayName,
          badge: reviewsFor(a.artistId) || undefined,
        })),
        {
          id: 'gigs',
          label: 'Artist gigs',
          icon: 'mic',
          badge: gigHelp ? `${gigHelp} need help` : undefined,
          badgeTone: 'w',
        },
        {
          id: 'artists',
          label: 'Artists & applications',
          icon: 'users',
          badge: artists.length,
          badgeTone: 'w',
        },
        { id: 'templates', label: 'Plan templates', icon: 'template' },
      ],
    },
    {
      label: 'SHARED WITH ARTISTS',
      items: [
        {
          id: 'messages',
          label: 'Chat',
          icon: 'chat',
          coral: true,
          badge: unread || undefined,
        },
        { id: 'todos', label: 'Tasks & to-dos', icon: 'todo' },
        { id: 'library', label: 'Document library', icon: 'folder' },
        {
          id: 'review',
          label: 'Review queue',
          icon: 'music',
          badge: openReviews.length || undefined,
          badgeTone: 'w',
        },
        { id: 'insights', label: 'Insights', icon: 'chart' },
      ],
    },
    {
      label: 'BMG ONLY',
      items: [
        { id: 'events', label: 'Events', icon: 'calendar' },
        { id: 'newsroom', label: 'Newsroom', icon: 'mail' },
        { id: 'connectors', label: 'Connectors', icon: 'plug' },
        { id: 'access', label: 'Access & permissions', icon: 'lock', soon: true },
        { id: 'prompts', label: 'AI prompts', icon: 'sparkle' },
      ],
    },
  ];

  const openArtist = view.startsWith('artist:')
    ? artists.find((a) => `artist:${a.artistId}` === view)
    : undefined;

  return (
    <BmgShell
      sections={sections}
      current={view}
      onNavigate={setView}
      userName={userName}
      roleLabel={ROLE_LABEL[me.role]}
      theme={theme}
      onTheme={setTheme}
      onSignOut={onSignOut}
      onProfile={() => setView('profile')}
      onAsk={() => setAsking(true)}
      bell={
        <Bell
          items={notes.items}
          unread={notes.unread}
          onOpen={openNotification}
          onMarkAll={() => void notes.markRead('all')}
        />
      }
      topActions={
        me.role === 'bmg-admin' && (
          <Button size="sm" variant="ghost" onClick={() => setView('artists')}>
            Invite artist
          </Button>
        )
      }
    >
      {view === 'overview' && (
        <StudioHq
          cfg={cfg}
          token={token}
          userName={userName}
          artists={artists}
          openReviews={openReviews}
          conversations={inbox.conversations ?? []}
          onNavigate={setView}
        />
      )}
      {view === 'artists' && (
        <ArtistsPage
          cfg={cfg}
          token={token}
          me={me}
          artists={artists}
          onOpen={(id) => setView(`artist:${id}`)}
          onReauth={onReauth}
          onInvited={() => void load()}
        />
      )}
      {openArtist && (
        <ArtistWorkspace
          cfg={cfg}
          token={token}
          me={me}
          artist={openArtist}
          onNavigate={setView}
          onOpenChat={openChat}
        />
      )}
      {view === 'insights' && (
        <>
          <PageHeader
            eyebrow="Shared with artists · Insights"
            title="Insights"
            sub="Website, socials and newsletter in one place. Numbers update every hour from the connected apps."
          />
          <Insights cfg={cfg} token={token} onManage={() => setView('connectors')} />
        </>
      )}
      {view === 'connectors' && (
        <>
          <PageHeader
            eyebrow="BMG only · Connectors"
            title="Connected apps"
            sub="The services Blueprint's app reads from and sends to. Artists connect their own accounts separately."
          />
          <BmgConnectors
            cfg={cfg}
            token={token}
            isAdmin={me.role === 'bmg-admin'}
            onReauth={onReauth}
          />
        </>
      )}
      {view === 'profile' && (
        <>
          <PageHeader eyebrow="Your account" title="Profile & preferences" />
          <Profile
            cfg={cfg}
            token={token}
            me={me}
            userName={userName}
            theme={theme}
            onTheme={setTheme}
            onSignOut={onSignOut}
          />
        </>
      )}
      {view === 'templates' && (
        <>
          <PageHeader
            eyebrow="Artist workspaces"
            title="Plan templates"
            sub="Custom stages for one or more artists, on top of the built-in phase library."
          />
          <PlanStages cfg={cfg} token={token} artists={artists} />
        </>
      )}
      {view === 'messages' && (
        <>
          <PageHeader
            eyebrow="Shared with artists"
            title="Chat"
            sub="Direct chats with artists, groups and announcements."
          />
          <BmgChat
            cfg={cfg}
            token={token}
            me={me}
            artists={artists}
            onNavigate={setView}
            initialConversationId={chatTarget}
          />
        </>
      )}
      {view === 'todos' && (
        <>
          <PageHeader
            eyebrow="Shared with artists"
            title="Tasks & to-dos"
            sub="Every artist's to-dos in one place, with quick filters."
          />
          <AllTodos cfg={cfg} token={token} artists={artists} />
        </>
      )}
      {view === 'review' && (
        <>
          <PageHeader
            eyebrow="Shared with artists"
            title="Review queue"
            sub="Sorted by priority, then date needed. Feedback turns into the artist's to-dos."
          />
          <ReviewQueue cfg={cfg} token={token} artists={artists} onChanged={() => void load()} />
        </>
      )}
      {view === 'gigs' && (
        <>
          <PageHeader
            eyebrow="Artist workspaces"
            title="Artist gigs"
            sub="Gigs artists share with Blueprint, with help requests first."
          />
          <AllGigs
            cfg={cfg}
            token={token}
            artists={artists}
            onOpenArtist={(id) => setView(`artist:${id}`)}
          />
        </>
      )}
      {view === 'events' && <Events cfg={cfg} token={token} />}
      {view === 'newsroom' && (
        <>
          <PageHeader
            eyebrow="BMG only · Newsroom"
            title="Weekly newsletter"
            sub="Drafted every Sunday at 6:00 am. Nothing is sent until an admin approves it."
          />
          <Newsroom cfg={cfg} token={token} isAdmin={me.role === 'bmg-admin'} onReauth={onReauth} />
        </>
      )}
      {view === 'prompts' && (
        <>
          <PageHeader
            eyebrow="BMG only · Settings"
            title="AI prompts"
            sub="Every instruction the AI follows. Edit a draft, publish it, or roll back to any earlier version."
          />
          <Prompts cfg={cfg} token={token} isAdmin={me.role === 'bmg-admin'} onReauth={onReauth} />
        </>
      )}
      {view === 'library' && (
        <>
          <PageHeader
            eyebrow="Shared with artists"
            title="Document library"
            sub="Upload once, then choose per file who sees it."
          />
          <Library
            cfg={cfg}
            token={token}
            isBmg
            isAdmin={me.role === 'bmg-admin'}
            artists={artists}
          />
        </>
      )}
      <Assistant
        cfg={cfg}
        token={token}
        open={asking}
        onClose={() => setAsking(false)}
        userName={userName}
        roleLabel={ROLE_LABEL[me.role]}
        lookingAt={openArtist ? openArtist.displayName : 'Studio HQ'}
        suggestions={[
          'What needs my attention this week?',
          'Which artists have gigs asking for help?',
          'Which artists opted in to AI?',
        ]}
      />
    </BmgShell>
  );
}

/** Studio HQ overview: the cards that have live data today. */
function StudioHq({
  cfg,
  token,
  userName,
  artists,
  openReviews,
  conversations,
  onNavigate,
}: {
  cfg: AppConfig;
  token: string;
  userName: string;
  artists: ArtistSummary[];
  openReviews: SubmissionSummary[];
  conversations: ConversationSummary[];
  onNavigate: (v: string) => void;
}) {
  const [plans, setPlans] = useState<Record<string, PlanResponse>>({});
  const [files, setFiles] = useState<FileItem[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));

  useEffect(() => {
    void Promise.all(
      artists.slice(0, 6).map((a) =>
        api<PlanResponse>(cfg, token, 'GET', `/artists/${a.artistId}/plan`)
          .then((p) => [a.artistId, p] as const)
          .catch(() => undefined),
      ),
    ).then((rows) =>
      setPlans(Object.fromEntries(rows.filter((r): r is readonly [string, PlanResponse] => !!r))),
    );
  }, [cfg, token, artists]);
  useEffect(() => {
    api<{ files: FileItem[] }>(cfg, token, 'GET', '/library/files')
      .then((r) => setFiles(r.files.filter((f) => f.status === 'available')))
      .catch(() => setFiles([]));
    api<{ todos: Todo[] }>(cfg, token, 'GET', '/todos')
      .then((r) => setTodos(r.todos))
      .catch(() => setTodos([]));
  }, [cfg, token]);

  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const overdue = todos.filter((t) => t.due && t.due < today).length;
  const dueSoon = todos.filter((t) => t.due && t.due >= today && t.due <= week).length;
  const go = (v: string) => (
    <button type="button" className="w-full" onClick={() => onNavigate(v)}>
      {v === 'review'
        ? 'Open queue'
        : v === 'library'
          ? 'Open library'
          : v === 'todos'
            ? 'Tasks & to-dos'
            : 'Artists & applications'}
    </button>
  );

  return (
    <>
      <PageHeader
        eyebrow="Studio HQ"
        title={`${greeting()}, ${userName.split(' ')[0]}`}
        sub={new Date().toLocaleDateString('en-AU', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
      />

      <div className="flex flex-wrap items-stretch gap-5">
        <Card
          className="flex-[1_1_320px]"
          title="Artist workspaces"
          action={<span className="src">Phases from each plan</span>}
          footer={go('artists')}
        >
          {artists.length === 0 && <p className="src">No artists yet. Invite your first one.</p>}
          {artists.slice(0, 4).map((a) => {
            const p = plans[a.artistId]?.plan ? plans[a.artistId] : undefined;
            const now = p
              ? phaseProgress(p.plan)
                  .filter((x) => x.status === 'now')
                  .map((x) => x.name)
                  .join(' · ')
              : '';
            const pct = p ? overallProgress(p.plan) : 0;
            const n = openReviews.filter((s) => s.artistId === a.artistId).length;
            return (
              <button
                key={a.artistId}
                type="button"
                onClick={() => onNavigate(`artist:${a.artistId}`)}
                className="tile gap-2 rounded-[10px] p-3 text-left hover:shadow-md"
              >
                <span className="flex items-center gap-3">
                  <Avatar name={a.displayName} />
                  <span className="min-w-0 flex-1">
                    <b className="block">{a.displayName}</b>
                    <span className="src">
                      {now ? `Now: ${now}` : p?.exists ? 'Plan set' : 'No plan yet'}
                    </span>
                  </span>
                  {n > 0 && <Tag tone="c">{n} to review</Tag>}
                </span>
                <span className="flex items-center text-sm text-muted-foreground">
                  <span className="flex-1">Plan progress</span>
                  <b className="text-foreground">{pct}%</b>
                </span>
                <Bar pct={pct} />
              </button>
            );
          })}
        </Card>

        <Card
          className="flex-[1_1_320px]"
          title="Chat"
          action={
            conversations.some((c) => c.unreadCount > 0) && (
              <Tag tone="k">{conversations.filter((c) => c.unreadCount > 0).length} unread</Tag>
            )
          }
          footer={go('messages')}
        >
          {conversations.slice(0, 3).map((c) => (
            <div key={c.conversationId} className="flex items-center gap-3">
              {c.type === 'announcement' ? (
                <span className="av bg-[#E6E9ED] text-[11px] text-[#011935]">ALL</span>
              ) : (
                <Avatar name={c.title} />
              )}
              <span className="min-w-0 flex-1">
                <b className="block">{c.title}</b>
                <span className="src block truncate">{c.preview ?? 'No messages yet'}</span>
              </span>
              {c.unreadCount > 0 && <Tag tone="k">{c.unreadCount}</Tag>}
            </div>
          ))}
        </Card>

        <Card className="flex-[1_1_320px]" title="Tasks & to-dos" footer={go('todos')}>
          <div className="big">
            {todos.length}{' '}
            <span className="text-[22px] tracking-normal text-muted-foreground">open</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="tile">
              <span className="src">Overdue</span>
              <b className="t text-xl">{overdue}</b>
            </div>
            <div className="tile">
              <span className="src">Due this week</span>
              <b className="t text-xl">{dueSoon}</b>
            </div>
            <div className="tile">
              <span className="src">From feedback</span>
              <b className="t text-xl">{todos.filter((t) => t.source === 'feedback').length}</b>
            </div>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[15px]">
            {todos.slice(0, 3).map((t) => (
              <li key={t.todoId} className="flex items-center gap-3">
                <span className="flex-1 truncate">{t.title}</span>
                <span className="src">{names[t.artistId] ?? ''}</span>
                {t.due && <Tag tone={t.due < today ? 'c' : 's'}>{shortDate(t.due)}</Tag>}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="flex flex-wrap items-stretch gap-5">
        <Card
          className="flex-[2_1_560px] pb-0"
          title="Review queue"
          action={
            <>
              <span className="src">Artist uploads waiting on your feedback</span>
              <Button size="sm" variant="cta" onClick={() => onNavigate('review')}>
                Open queue
              </Button>
            </>
          }
        >
          {openReviews.length === 0 ? (
            <p className="src pb-5">Nothing waiting for review.</p>
          ) : (
            <>
              <DataTable>
                <thead>
                  <tr>
                    <th scope="col">Upload</th>
                    <th scope="col">Artist</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {openReviews.slice(0, 5).map((s) => (
                    <tr key={s.submissionId}>
                      <td>
                        <b className="block">{s.title}</b>
                        <span className="src capitalize">{s.type.replace('-', ' ')}</span>
                      </td>
                      <td>
                        <span className="flex items-center gap-2">
                          <Avatar name={names[s.artistId] ?? 'Artist'} size={28} />
                          {names[s.artistId] ?? 'Artist'}
                        </span>
                      </td>
                      <td>
                        <Tag tone={PRIORITY_TAG[s.priority][0]}>{PRIORITY_TAG[s.priority][1]}</Tag>
                      </td>
                      <td>{shortDate(s.neededBy)}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              <div className="flex items-center py-3 text-[15px]">
                <b>{openReviews.length}</b>&nbsp;
                <span className="text-muted-foreground">waiting</span>
              </div>
            </>
          )}
        </Card>

        <Card
          className="flex-[1_1_320px]"
          title="Document library"
          action={
            <Button size="sm" variant="ghost" onClick={() => onNavigate('library')}>
              Upload &amp; share
            </Button>
          }
          footer={go('library')}
        >
          {files.length === 0 && <p className="src">The library is empty.</p>}
          {files.slice(0, 4).map((f) => (
            <div key={f.fileId} className="li">
              <span className="appsq !bg-secondary !text-foreground">
                <Icon name="file" size={14} strokeWidth={2.4} />
              </span>
              <span className="flex-1 truncate">{f.name}</span>
              <span className="src">
                {f.sharing === 'all-artists'
                  ? 'All artists'
                  : f.sharing === 'selected'
                    ? `${f.sharedWithArtistIds.length} artist${f.sharedWithArtistIds.length === 1 ? '' : 's'}`
                    : 'BMG only'}
              </span>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

/** Artists & applications: roster with terms and AI status, plus invite. */
function ArtistsPage({
  cfg,
  token,
  me,
  artists,
  onOpen,
  onReauth,
  onInvited,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artists: ArtistSummary[];
  onOpen: (id: string) => void;
  onReauth: () => void;
  onInvited: () => void;
}) {
  return (
    <>
      <PageHeader eyebrow="Artist workspaces" title="Artists & applications" />
      <div className="flex flex-wrap items-start gap-5">
        <Card
          className="flex-[2_1_520px] pb-0"
          title="Roster"
          action={<span className="src">{artists.length} artists</span>}
        >
          {artists.length === 0 ? (
            <p className="src pb-5">No artists yet.</p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Artist</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {artists.map((a) => (
                  <tr key={a.artistId}>
                    <td>
                      <span className="flex items-center gap-3">
                        <Avatar name={a.displayName} size={32} />
                        <b>{a.displayName}</b>
                      </span>
                    </td>
                    <td>
                      <Tag tone={a.status === 'active' ? 'n' : 's'}>{a.status || 'Invited'}</Tag>
                    </td>
                    <td>{shortDate(a.createdAt)}</td>
                    <td className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => onOpen(a.artistId)}>
                        Open workspace
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
        {me.role === 'bmg-admin' && (
          <div className="flex-[1_1_320px]">
            <InviteArtist cfg={cfg} token={token} onReauth={onReauth} onInvited={onInvited} />
          </div>
        )}
      </div>
    </>
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
      await api<{ artistId: string }>(cfg, token, 'POST', '/artists', { email, displayName });
      setResult({
        tone: 'success',
        text: `Invited ${displayName}. Their login and private key are being created.`,
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
        className="flex flex-col gap-4"
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
        <div className="flex items-center gap-3">
          <Button type="submit" variant="cta" disabled={busy}>
            Send invite
          </Button>
          {result?.reauth && (
            <Button type="button" variant="ghost" onClick={onReauth}>
              Sign in again
            </Button>
          )}
        </div>
        <span className="src">
          This creates their login. They choose a passkey or password on first sign-in.
        </span>
      </form>
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
    </Card>
  );
}

// ═════════════════════════════ Artist phone app ═════════════════════════════

type ArtistView =
  | 'home'
  | 'chat'
  | 'todo'
  | 'gigs'
  | 'library'
  | 'submit'
  | 'plan'
  | 'profile'
  | 'connectors'
  | 'stats';

function ArtistApp({ cfg, token, me, userName, onSignOut }: HomeProps) {
  const [theme, setTheme] = useTheme();
  const [asking, setAsking] = useState(false);
  const notes = useNotifications(cfg, token, me.sub);
  const [chatTarget, setChatTarget] = useState<string | null>(null);
  useDeepLink((link) => {
    if (link.startsWith('chat:')) setChatTarget(link.slice('chat:'.length) || null);
    setView(
      link.startsWith('chat:') ? 'chat' : link === 'submit' || link === 'library' ? link : 'home',
    );
  });
  const [view, setView] = useState<ArtistView>(hasPendingCallback() ? 'connectors' : 'home');
  const artistId = me.artistId!;
  const first = userName.split(' ')[0];
  const tabs = [
    { id: 'home', label: 'Home', icon: 'home' as const },
    { id: 'chat', label: 'Chat', icon: 'chat' as const },
    { id: 'todo', label: 'To-do', icon: 'todo' as const },
    { id: 'gigs', label: 'Gigs', icon: 'mic' as const },
    { id: 'library', label: 'Library', icon: 'folder' as const },
  ];
  const headers: Record<ArtistView, { eyebrow: string; title: string }> = {
    home: { eyebrow: 'Blueprint', title: `Hi ${first}` },
    chat: { eyebrow: 'Blueprint', title: 'Chat' },
    profile: { eyebrow: 'Profile & preferences', title: userName },
    todo: { eyebrow: 'To-do', title: 'This week' },
    library: { eyebrow: 'Library & assets', title: 'Your files' },
    submit: { eyebrow: 'Submit for review', title: 'Send to Blueprint' },
    plan: { eyebrow: 'My plan', title: 'Your plan' },
    gigs: { eyebrow: 'Gigs', title: 'My gigs' },
    connectors: { eyebrow: 'Profile', title: 'My connectors' },
    stats: { eyebrow: 'Socials', title: 'My stats' },
  };
  const back =
    view === 'submit' ||
    view === 'plan' ||
    view === 'profile' ||
    view === 'connectors' ||
    view === 'stats';

  return (
    <ArtistShell
      tabs={tabs}
      current={back ? 'home' : view}
      onNavigate={(id) => setView(id as ArtistView)}
      {...(me.consent?.aiOptIn ? { onAsk: () => setAsking(true) } : {})}
      header={
        <PhoneHeader
          eyebrow={headers[view].eyebrow}
          title={headers[view].title}
          right={
            back ? (
              <button
                type="button"
                className="text-sm font-bold text-[#D3D8DE]"
                onClick={() => setView('home')}
              >
                ← Home
              </button>
            ) : (
              <span className="flex items-center gap-1">
                <Bell
                  light
                  items={notes.items}
                  unread={notes.unread}
                  onMarkAll={() => void notes.markRead('all')}
                  onOpen={(n) => {
                    void notes.markRead([n.id]);
                    if (n.link.startsWith('chat:'))
                      setChatTarget(n.link.slice('chat:'.length) || null);
                    setView(
                      n.link.startsWith('chat:')
                        ? 'chat'
                        : n.link === 'submit'
                          ? 'submit'
                          : n.link === 'library'
                            ? 'library'
                            : n.link === 'connectors'
                              ? 'connectors'
                              : 'home',
                    );
                  }}
                />
                <button
                  type="button"
                  aria-label="Profile & preferences"
                  onClick={() => setView('profile')}
                >
                  <Avatar name={userName} size={34} className="!bg-cta !text-white" />
                </button>
              </span>
            )
          }
        />
      }
    >
      {view === 'home' && <ArtistHome cfg={cfg} token={token} me={me} onNavigate={setView} />}
      {view === 'chat' && (
        <ArtistChats
          cfg={cfg}
          token={token}
          me={me}
          onNavigate={(v) => setView(v as ArtistView)}
          initialConversationId={chatTarget}
        />
      )}
      {view === 'todo' && <ArtistTodos cfg={cfg} token={token} artistId={artistId} isBmg={false} />}
      {view === 'library' && (
        <>
          <ArtistFiles cfg={cfg} token={token} artistId={artistId} isBmg={false} />
          <div className="eyebrow pt-2 text-muted-foreground">Shared by Blueprint</div>
          <Library cfg={cfg} token={token} isBmg={false} artists={[]} />
        </>
      )}
      {view === 'submit' && (
        <ArtistSubmissions cfg={cfg} token={token} artistId={artistId} isBmg={false} />
      )}
      {view === 'plan' && <PlanTab cfg={cfg} token={token} artistId={artistId} canEdit={false} />}
      {view === 'gigs' && <ArtistGigs cfg={cfg} token={token} artistId={artistId} />}
      {view === 'connectors' && <MyConnectors cfg={cfg} token={token} artistId={artistId} />}
      {view === 'stats' && (
        <>
          <ArtistStats cfg={cfg} token={token} artistId={artistId} name={userName} compact />
          <Button variant="ghost" onClick={() => setView('connectors')}>
            My connectors
          </Button>
        </>
      )}
      {view === 'profile' && (
        <Profile
          cfg={cfg}
          token={token}
          me={me}
          userName={userName}
          theme={theme}
          onTheme={setTheme}
          onSignOut={onSignOut}
          compact
        />
      )}
      {me.consent?.aiOptIn && (
        <Assistant
          cfg={cfg}
          token={token}
          open={asking}
          onClose={() => setAsking(false)}
          userName={userName}
          roleLabel="Artist"
          lookingAt={headers[view].title}
          suggestions={[
            "What's due this week?",
            'How is my plan going?',
            'Help me plan my next gig',
          ]}
        />
      )}
      {view === 'profile' && (
        <Button variant="ghost" onClick={() => setView('connectors')}>
          My connectors
        </Button>
      )}
    </ArtistShell>
  );
}

function ArtistHome({
  cfg,
  token,
  me,
  onNavigate,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  onNavigate: (v: ArtistView) => void;
}) {
  const artistId = me.artistId!;
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [shared, setShared] = useState<FileItem[]>([]);
  const [subs, setSubs] = useState<SubmissionSummary[]>([]);
  useEffect(() => {
    api<PlanResponse>(cfg, token, 'GET', `/artists/${artistId}/plan`)
      .then(setPlan)
      .catch(() => setPlan(null));
    api<{ todos: Todo[] }>(cfg, token, 'GET', `/artists/${artistId}/todos`)
      .then((r) => setTodos(r.todos))
      .catch(() => setTodos([]));
    api<{ files: FileItem[] }>(cfg, token, 'GET', '/library/files')
      .then((r) => setShared(r.files))
      .catch(() => setShared([]));
    api<{ submissions: SubmissionSummary[] }>(cfg, token, 'GET', `/artists/${artistId}/submissions`)
      .then((r) => setSubs(r.submissions))
      .catch(() => setSubs([]));
  }, [cfg, token, artistId]);
  const changed = subs.filter((s) => s.status === 'open' && s.changedByBmgAt);
  const reviewed = subs.filter((s) => s.status === 'reviewed').slice(0, 2);

  return (
    <>
      {changed.map((s) => (
        <Notice key={s.submissionId}>Blueprint changed the priority or date of “{s.title}”.</Notice>
      ))}
      {plan?.exists && (
        <section className="card gap-2.5">
          <div className="flex items-center gap-2">
            <span className="eyebrow">My plan</span>
            <button
              type="button"
              className="ml-auto text-sm font-bold underline"
              onClick={() => onNavigate('plan')}
            >
              Open
            </button>
          </div>
          {plan.plan.outcome && (
            <b className="line-clamp-3 text-[15px] leading-snug">
              {markdownToText(plan.plan.outcome)}
            </b>
          )}
          {phaseProgress(plan.plan)
            .filter((p) => p.status === 'now')
            .slice(0, 2)
            .map((p) => (
              <div key={p.id} className="flex flex-col gap-1.5">
                <span className="flex text-sm">
                  <span className="flex-1">{p.name}</span>
                  <b>{p.pct}%</b>
                </span>
                <Bar pct={p.pct} color="#D9534F" />
              </div>
            ))}
        </section>
      )}
      <section className="card gap-2.5">
        <div className="flex items-center gap-2">
          <span className="eyebrow">To-do</span>
          <button
            type="button"
            className="ml-auto text-sm font-bold underline"
            onClick={() => onNavigate('todo')}
          >
            All
          </button>
        </div>
        {todos.length === 0 && <p className="src">You're all caught up.</p>}
        {todos.slice(0, 3).map((t) => (
          <div key={t.todoId} className="flex items-center gap-3 text-[15px]">
            <span className="flex-1">{t.title}</span>
            {t.due && <Tag tone="s">{shortDate(t.due)}</Tag>}
          </div>
        ))}
      </section>
      {reviewed.length > 0 && (
        <section className="card gap-2.5">
          <span className="eyebrow">Feedback</span>
          {reviewed.map((s) => (
            <button
              key={s.submissionId}
              type="button"
              className="flex items-center gap-3 text-left text-[15px]"
              onClick={() => onNavigate('submit')}
            >
              <Tag tone="n">Reviewed</Tag>
              <span className="flex-1">{s.title}</span>
            </button>
          ))}
        </section>
      )}
      <section className="card gap-2.5">
        <div className="flex items-center gap-2">
          <span className="eyebrow">Shared with me</span>
          <button
            type="button"
            className="ml-auto text-sm font-bold underline"
            onClick={() => onNavigate('library')}
          >
            Library
          </button>
        </div>
        {shared.length === 0 && <p className="src">Nothing shared yet.</p>}
        {shared.slice(0, 3).map((f) => (
          <div key={f.fileId} className="flex items-center gap-3 text-[15px]">
            <Tag tone="s">{(f.name.split('.').pop() ?? 'File').slice(0, 4).toUpperCase()}</Tag>
            <span className="truncate">{f.name}</span>
          </div>
        ))}
      </section>
      <section className="card gap-2.5">
        <div className="flex items-center gap-2">
          <span className="eyebrow">Socials</span>
          <button
            type="button"
            className="ml-auto text-sm font-bold underline"
            onClick={() => onNavigate('stats')}
          >
            My stats
          </button>
        </div>
        <button
          type="button"
          className="text-left text-[15px]"
          onClick={() => onNavigate('connectors')}
        >
          Connect Instagram, TikTok, Spotify and your calendar →
        </button>
      </section>
      <Button
        variant="cta"
        className="min-h-[50px] w-full tracking-[.04em]"
        onClick={() => onNavigate('submit')}
      >
        Upload music or lyrics for review
      </Button>
    </>
  );
}
