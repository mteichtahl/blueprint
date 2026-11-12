import { useCallback, useEffect, useState } from 'react';
import { AvatarProvider, useOwnAvatar } from '../components/avatars.tsx';
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
import { Contacts } from './Contacts.tsx';
import { Venues } from './Venues.tsx';
import { ArtistStats, Insights } from './Insights.tsx';
import {
  ArtistShell,
  BmgShell,
  PhoneHeader,
  ProfileMenu,
  useTheme,
  type NavSection,
} from '../components/Shell.tsx';
import {
  Avatar,
  Bar,
  Button,
  Card,
  Chips,
  DataTable,
  Field,
  Notice,
  PageHeader,
  RowCard,
  shortDate,
  Tag,
} from '../components/ui.tsx';
import { Assistant } from '../components/Assistant.tsx';
import { Bell } from '../components/Bell.tsx';
import { useNotifications, type AppNotification } from '../lib/notifications.ts';
import { useDeepLink } from '../lib/push.ts';
import { AssetLibrary } from './Assets.tsx';
import { BrandKit } from './BrandKit.tsx';
import { AccessPage } from './Access.tsx';
import { Invitations } from './Invitations.tsx';
import { ArtistFiles, Library, LIBRARY_KIND_OPTIONS, type LibraryKind } from './Library.tsx';
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
import { ArtistWorkspace, type WorkspaceTarget } from './Workspace.tsx';
import { MeetingsPage, RecorderProvider, RecordingBar, type MeetingsTarget } from './Meetings.tsx';
import { FileThumb } from '../components/FileThumb.tsx';

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
  return (
    <AvatarProvider cfg={props.cfg} token={props.token}>
      {props.me.role === 'artist' ? <ArtistApp {...props} /> : <BmgApp {...props} />}
    </AvatarProvider>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// ═════════════════════════════ BMG desktop ═════════════════════════════

function BmgApp({ cfg, token, me, userName, onSignOut, onReauth }: HomeProps) {
  const [theme, setTheme] = useTheme();
  const [jobTitle, setJobTitle] = useState(me.jobTitle ?? '');
  const [avatar, setAvatar] = useState(me.avatar ?? null);
  useOwnAvatar(me.sub, me.artistId, avatar);
  // Back from a vendor's sign-in page: open Connectors to finish connecting.
  const [view, setView] = useState(hasPendingCallback() ? 'connectors' : 'overview');
  // Bumped after an invite, so the invitations list reloads.
  const [invitesKey, setInvitesKey] = useState(0);
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  // Which workspace section to open (a plan notification opens Plan, rev 12;
  // a document or "Where it's used" link opens its place, rev 8).
  const [wsTarget, setWsTarget] = useState<WorkspaceTarget | undefined>();
  const openWorkspace = (artistId: string, t: Omit<WorkspaceTarget, 'n'>) => {
    setWsTarget((was) => ({ ...t, n: (was?.n ?? 0) + 1 }));
    setView(`artist:${artistId}`);
  };
  // A submission opened from a link shows in the review queue.
  const [reviewTarget, setReviewTarget] = useState<{
    artistId: string;
    submissionId: string;
  } | null>(null);
  const [openReviews, setOpenReviews] = useState<SubmissionSummary[]>([]);
  const [gigHelp, setGigHelp] = useState(0);
  const [todosOverdue, setTodosOverdue] = useState(0);
  const [asking, setAsking] = useState(false);
  // A document opened from a Studio HQ card shows its page in the library (rev 8).
  const [libraryFile, setLibraryFile] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [roster, queue, help, openTodos] = await Promise.all([
      api<{ artists: ArtistSummary[] }>(cfg, token, 'GET', '/artists'),
      api<{ submissions: SubmissionSummary[] }>(cfg, token, 'GET', '/review-queue?status=open'),
      api<{ gigs: unknown[] }>(cfg, token, 'GET', '/gigs?filter=help').catch(() => ({ gigs: [] })),
      api<{ todos: Todo[] }>(cfg, token, 'GET', '/todos').catch(() => ({ todos: [] })),
    ]);
    setArtists(roster.artists);
    setOpenReviews(queue.submissions);
    setGigHelp(help.gigs.length);
    const today = new Date().toISOString().slice(0, 10);
    setTodosOverdue(openTodos.todos.filter((t) => !t.done && !!t.due && t.due < today).length);
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
    todos: 'todos',
    profile: 'profile',
  };
  const [meetingsTarget, setMeetingsTarget] = useState<MeetingsTarget>({ kind: 'list' });
  const openMeetings = (t: MeetingsTarget) => {
    setMeetingsTarget(t);
    setView('meetings');
  };
  const goTo = (link: string) => {
    if (link.startsWith('chat:')) return openChat(link.slice('chat:'.length) || null);
    // A meeting's notification: `meeting:<space>/<meetingId>` (rev 11).
    const meeting = /^meeting:([^/]+)\/(.+)$/.exec(link);
    if (meeting) return openMeetings({ kind: 'open', space: meeting[1]!, meetingId: meeting[2]! });
    // An artist's plan, for its owner: `plan:<artistId>` (rev 12).
    const planOf = /^plan:(art_[a-z0-9]+)$/.exec(link);
    if (planOf) return openWorkspace(planOf[1]!, { tab: 'plan' });
    // Rev 8: a document, a submission, a brand kit or an asset library.
    const doc = /^doc:(library|art_[a-z0-9]+)\/([a-z0-9]+)$/.exec(link);
    if (doc?.[1] === 'library') {
      setLibraryFile(doc[2]!);
      return setView('library');
    }
    if (doc) return openWorkspace(doc[1]!, { tab: 'library', fileId: doc[2]! });
    const sub = /^submission:(art_[a-z0-9]+)\/([A-Za-z0-9_-]+)$/.exec(link);
    if (sub) {
      setReviewTarget({ artistId: sub[1]!, submissionId: sub[2]! });
      return setView('review');
    }
    const brand = /^brand:(art_[a-z0-9]+)$/.exec(link);
    if (brand) return openWorkspace(brand[1]!, { tab: 'brand' });
    const assets = /^assets:(art_[a-z0-9]+)$/.exec(link);
    if (assets) return openWorkspace(assets[1]!, { tab: 'library', libKind: 'assets' });
    setView(LINK_VIEWS[link] ?? 'overview');
  };
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
          avatarArtistId: a.artistId,
          badge: reviewsFor(a.artistId) || undefined,
        })),
        {
          id: 'gigs',
          label: 'Artist gigs',
          icon: 'mic',
          badge: gigHelp ? `${gigHelp} need help` : undefined,
          badgeTone: 'w',
          urgent: { waiting: gigHelp, priority: 4 },
        },
        {
          id: 'artists',
          label: 'Artists & applications',
          icon: 'users',
          badge: artists.length,
          badgeTone: 'w',
        },
        ...(me.role === 'bmg-admin'
          ? [{ id: 'invite', label: 'Invite artist', icon: 'userPlus' as const }]
          : []),
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
          urgent: { waiting: unread, priority: 1 },
        },
        {
          id: 'todos',
          label: 'Tasks & to-dos',
          icon: 'todo',
          badge: todosOverdue ? `${todosOverdue} overdue` : undefined,
          urgent: { waiting: todosOverdue, priority: 2 },
          alwaysOnTop: true,
        },
        { id: 'library', label: 'Document library', icon: 'folder' },
        {
          id: 'review',
          label: 'Review queue',
          icon: 'music',
          badge: openReviews.length || undefined,
          badgeTone: 'w',
          urgent: { waiting: openReviews.length, priority: 3 },
        },
        { id: 'insights', label: 'Insights', icon: 'chart' },
        { id: 'contacts', label: 'Contacts', icon: 'users' },
        { id: 'venues', label: 'Venues', icon: 'mic' },
      ],
    },
    {
      label: 'BMG ONLY',
      items: [
        { id: 'meetings', label: 'Meetings', icon: 'record' },
        { id: 'events', label: 'Events', icon: 'calendar' },
        { id: 'newsroom', label: 'Newsroom', icon: 'mail' },
        { id: 'connectors', label: 'Connectors', icon: 'plug' },
        { id: 'access', label: 'Access & permissions', icon: 'lock' },
        { id: 'prompts', label: 'AI prompts', icon: 'sparkle' },
      ],
    },
  ];

  const openArtist = view.startsWith('artist:')
    ? artists.find((a) => `artist:${a.artistId}` === view)
    : undefined;

  return (
    <RecorderProvider cfg={cfg} token={token}>
      <BmgShell
        sections={sections}
        current={view}
        onNavigate={(v) => {
          if (v === 'meetings') setMeetingsTarget({ kind: 'list' });
          setWsTarget(undefined);
          setReviewTarget(null);
          setView(v);
        }}
        userName={userName}
        roleLabel={jobTitle || ROLE_LABEL[me.role]}
        theme={theme}
        onTheme={setTheme}
        onSignOut={onSignOut}
        onProfile={() => setView('profile')}
        avatar={avatar}
        onAsk={() => setAsking(true)}
        bell={
          <Bell
            items={notes.items}
            unread={notes.unread}
            onOpen={openNotification}
            onMarkAll={() => void notes.markRead('all')}
          />
        }
      >
        {!(view === 'meetings' && meetingsTarget.kind === 'recorder') && (
          <RecordingBar onOpen={() => openMeetings({ kind: 'recorder' })} />
        )}
        {view === 'meetings' && (
          <>
            <PageHeader
              eyebrow="BMG only · Meeting notes"
              title="Meetings"
              sub="Record a meeting with everyone’s agreement. It’s transcribed and filed in the Library, ready for a summary and plan suggestions."
            />
            <MeetingsPage
              cfg={cfg}
              token={token}
              me={me}
              artists={artists}
              target={meetingsTarget}
              onTarget={setMeetingsTarget}
            />
          </>
        )}
        {view === 'overview' && (
          <StudioHq
            cfg={cfg}
            token={token}
            userName={userName}
            meSub={me.sub}
            artists={artists}
            openReviews={openReviews}
            conversations={inbox.conversations ?? []}
            onNavigate={setView}
            onOpenFile={(id) => {
              setLibraryFile(id);
              setView('library');
            }}
            onOpenChat={openChat}
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
            {...(wsTarget ? { target: wsTarget } : {})}
            onNavigate={setView}
            onOpenChat={openChat}
            onRecordMeeting={() => openMeetings({ kind: 'new', artistId: openArtist.artistId })}
            onOpenMeeting={(m) =>
              openMeetings({ kind: 'open', space: m.space, meetingId: m.meetingId })
            }
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
        {view === 'access' && (
          <>
            <PageHeader
              eyebrow="BMG only · Settings"
              title="Access & permissions"
              sub="What artist accounts can do, and who is on the Blueprint team."
            />
            <AccessPage cfg={cfg} token={token} me={me} artists={artists} onReauth={onReauth} />
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
              me={{ ...me, jobTitle, avatar }}
              userName={userName}
              theme={theme}
              onTheme={setTheme}
              onSignOut={onSignOut}
              onReauth={onReauth}
              onJobTitle={setJobTitle}
              onAvatar={setAvatar}
            />
          </>
        )}
        {view === 'invite' && me.role === 'bmg-admin' && (
          <>
            <PageHeader
              eyebrow="Artist workspaces"
              title="Invite artist"
              sub="Sets up their login, private key and artist workspace. Follow each invitation here until they sign in."
            />
            <div className="flex flex-wrap items-start gap-5">
              <div className="w-full max-w-[520px] flex-[1_1_320px]">
                <InviteArtist
                  cfg={cfg}
                  token={token}
                  onReauth={onReauth}
                  onInvited={() => {
                    setInvitesKey((k) => k + 1);
                    void load();
                  }}
                />
              </div>
              <div className="min-w-0 flex-[2_1_420px]">
                <Invitations cfg={cfg} token={token} refreshKey={invitesKey} onReauth={onReauth} />
              </div>
            </div>
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
            <ReviewQueue
              cfg={cfg}
              token={token}
              artists={artists}
              open={reviewTarget}
              onClosed={() => setReviewTarget(null)}
              onChanged={() => void load()}
            />
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
        {view === 'contacts' && (
          <>
            <PageHeader
              eyebrow="Shared with artists"
              title="Contacts"
              sub="Everyone Blueprint and its artists work with. Artists can pick and add; you manage the list."
            />
            <Contacts cfg={cfg} token={token} isBmg />
          </>
        )}
        {view === 'venues' && (
          <>
            <PageHeader
              eyebrow="Shared with artists"
              title="Venues"
              sub="Capacity, backline, and who to call. Managers and bookers live in Contacts."
            />
            <Venues cfg={cfg} token={token} isBmg />
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
            <Newsroom
              cfg={cfg}
              token={token}
              isAdmin={me.role === 'bmg-admin'}
              onReauth={onReauth}
            />
          </>
        )}
        {view === 'prompts' && (
          <>
            <PageHeader
              eyebrow="BMG only · Settings"
              title="AI prompts"
              sub="Every instruction the AI follows. Edit a draft, publish it, or roll back to any earlier version."
            />
            <Prompts
              cfg={cfg}
              token={token}
              isAdmin={me.role === 'bmg-admin'}
              onReauth={onReauth}
            />
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
              openFileId={libraryFile}
              onClosed={() => setLibraryFile(null)}
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
    </RecorderProvider>
  );
}

/** Studio HQ overview: the cards that have live data today. */
function StudioHq({
  cfg,
  token,
  userName,
  meSub,
  artists,
  openReviews,
  conversations,
  onNavigate,
  onOpenFile,
  onOpenChat,
}: {
  cfg: AppConfig;
  token: string;
  userName: string;
  meSub: string;
  artists: ArtistSummary[];
  openReviews: SubmissionSummary[];
  conversations: ConversationSummary[];
  onNavigate: (v: string) => void;
  /** Open a document's detail page (rev 8). */
  onOpenFile: (fileId: string) => void;
  /** Open Chat straight on one conversation. */
  onOpenChat: (conversationId: string) => void;
}) {
  const [plans, setPlans] = useState<Record<string, PlanResponse>>({});
  // "My plans" (rev 12): the artists whose plan this person owns.
  const [whose, setWhose] = useState<'all' | 'mine'>('all');
  const shownArtists =
    whose === 'mine' ? artists.filter((a) => a.planOwner?.sub === meSub) : artists;
  const needOwner = artists.filter((a) => a.planOwnerNeeded).length;
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
            : v === 'messages'
              ? 'Open chat'
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
          action={
            <span className="flex flex-wrap items-center gap-2">
              {needOwner > 0 && (
                <Tag tone="c">
                  {needOwner} need{needOwner === 1 ? 's' : ''} an owner
                </Tag>
              )}
              <Chips
                label="Whose plans"
                value={whose}
                onChange={setWhose}
                options={[
                  { id: 'all', label: 'All' },
                  { id: 'mine', label: 'My plans' },
                ]}
              />
            </span>
          }
          footer={go('artists')}
        >
          {artists.length === 0 && <p className="src">No artists yet. Invite your first one.</p>}
          {artists.length > 0 && shownArtists.length === 0 && (
            <p className="src">You don&apos;t own any artist plans yet.</p>
          )}
          {shownArtists.slice(0, 4).map((a) => {
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
                  <Avatar name={a.displayName} artistId={a.artistId} />
                  <span className="min-w-0 flex-1">
                    <b className="block">{a.displayName}</b>
                    <span className="src">
                      {now ? `Now: ${now}` : p?.exists ? 'Plan set' : 'No plan yet'}
                    </span>
                    {a.hasPlan && (
                      <span className="src block">
                        {a.planOwnerNeeded
                          ? 'Plan needs an owner'
                          : a.planOwner
                            ? `Owner: ${a.planOwner.displayName}`
                            : ''}
                      </span>
                    )}
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
            // P1: the whole row opens that conversation in Chat.
            <button
              type="button"
              key={c.conversationId}
              className="-mx-2 flex min-h-11 items-center gap-3 rounded-md px-2 py-1 text-left hover:bg-secondary"
              onClick={() => onOpenChat(c.conversationId)}
            >
              {c.type === 'announcement' ? (
                <span className="av bg-[#E6E9ED] text-[11px] text-[#011935]">ALL</span>
              ) : (
                <Avatar
                  name={c.title}
                  artistId={c.artists.find((x) => x.displayName === c.title)?.artistId}
                />
              )}
              <span className="min-w-0 flex-1">
                <b className="block">{c.title}</b>
                <span className="src block truncate">{c.preview ?? 'No messages yet'}</span>
              </span>
              {c.unreadCount > 0 && (
                <Tag tone="k">
                  {c.unreadCount}
                  <span className="sr-only"> unread</span>
                </Tag>
              )}
            </button>
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
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="src max-w-[40%] truncate max-sm:hidden">
                  {names[t.artistId] ?? ''}
                </span>
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
              <DataTable
                label="Waiting for review"
                cards={openReviews.slice(0, 5).map((s) => (
                  <RowCard
                    key={s.submissionId}
                    title={s.title}
                    status={
                      <Tag tone={PRIORITY_TAG[s.priority][0]}>{PRIORITY_TAG[s.priority][1]}</Tag>
                    }
                    sub={`${names[s.artistId] ?? 'Artist'} · Needed by ${shortDate(s.neededBy)}`}
                    onOpen={() => onNavigate('review')}
                  />
                ))}
              >
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
                          <Avatar
                            name={names[s.artistId] ?? 'Artist'}
                            artistId={s.artistId}
                            size={28}
                          />
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
            <button
              key={f.fileId}
              type="button"
              className="li w-full text-left hover:bg-[#F6F8FA] dark:hover:bg-secondary"
              onClick={() => onOpenFile(f.fileId)}
            >
              <FileThumb
                src={f.thumbnailUrl}
                kind={f.fileType.kind}
                ext={f.fileType.ext}
                label={f.fileType.label}
                size={32}
              />
              <span className="flex-1 truncate">{f.displayName}</span>
              <span className="src">
                {f.sharing === 'all-artists'
                  ? 'All artists'
                  : f.sharing === 'selected'
                    ? `${f.sharedWithArtistIds.length} artist${f.sharedWithArtistIds.length === 1 ? '' : 's'}`
                    : 'BMG only'}
              </span>
            </button>
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
            <DataTable
              label="Artists"
              cards={artists.map((a) => (
                <RowCard
                  key={a.artistId}
                  lead={<Avatar name={a.displayName} artistId={a.artistId} size={36} />}
                  title={a.displayName}
                  status={
                    <Tag tone={a.status === 'active' ? 'n' : 's'}>{a.status || 'Invited'}</Tag>
                  }
                  sub={`Joined ${shortDate(a.createdAt)}`}
                  tags={
                    <>
                      <Tag tone={a.termsAcceptedAt ? 'n' : 's'}>
                        {a.termsAcceptedAt ? 'Terms accepted' : 'Terms not yet'}
                      </Tag>
                      <Tag tone={a.aiOptIn ? 'n' : 's'}>
                        {a.aiOptIn === true
                          ? 'AI on'
                          : a.aiOptIn === false
                            ? 'AI off'
                            : 'AI not chosen'}
                      </Tag>
                      {a.planOwnerNeeded ? (
                        <Tag tone="c">Plan needs an owner</Tag>
                      ) : a.planOwner ? (
                        <Tag tone="s">Plan owner: {a.planOwner.displayName}</Tag>
                      ) : null}
                    </>
                  }
                  onOpen={() => onOpen(a.artistId)}
                  openLabel={`Open ${a.displayName}'s workspace`}
                />
              ))}
            >
              <thead>
                <tr>
                  <th scope="col">Artist</th>
                  <th scope="col">App account</th>
                  <th scope="col">Terms</th>
                  <th scope="col">AI</th>
                  <th scope="col">Plan owner</th>
                  <th scope="col">Joined</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {artists.map((a) => (
                  <tr key={a.artistId}>
                    <td>
                      <span className="flex items-center gap-3">
                        <Avatar name={a.displayName} artistId={a.artistId} size={32} />
                        <b>{a.displayName}</b>
                      </span>
                    </td>
                    <td>
                      <Tag tone={a.status === 'active' ? 'n' : 's'}>{a.status || 'Invited'}</Tag>
                    </td>
                    <td>
                      {a.termsAcceptedAt ? (
                        `Accepted ${shortDate(a.termsAcceptedAt)}`
                      ) : (
                        <span className="src">Not yet</span>
                      )}
                    </td>
                    <td>
                      {a.aiOptIn === true ? (
                        <Tag tone="n">Opted in</Tag>
                      ) : a.aiOptIn === false ? (
                        <Tag tone="s">Opted out</Tag>
                      ) : (
                        <span className="src">Not chosen</span>
                      )}
                    </td>
                    <td>
                      {a.planOwnerNeeded ? (
                        <Tag tone="c">Needs an owner</Tag>
                      ) : a.planOwner ? (
                        a.planOwner.displayName
                      ) : (
                        <span className="src">No plan yet</span>
                      )}
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
          This creates their login and emails them how to open Blueprint on the web, install the app
          on their phone and sign in for the first time.
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
  | 'brand'
  | 'submit'
  | 'plan'
  | 'profile'
  | 'connectors'
  | 'stats'
  | 'contacts';

function ArtistApp({ cfg, token, me, userName, onSignOut, onReauth }: HomeProps) {
  const [theme, setTheme] = useTheme();
  const [avatar, setAvatar] = useState(me.avatar ?? null);
  useOwnAvatar(me.sub, me.artistId, avatar);
  const [asking, setAsking] = useState(false);
  // A document opened from Home shows its page in the library (rev 8).
  const [libraryFile, setLibraryFile] = useState<string | null>(null);
  const notes = useNotifications(cfg, token, me.sub);
  const [chatTarget, setChatTarget] = useState<string | null>(null);
  // A document of their own opened from a link (rev 8), and a submission.
  const [myFile, setMyFile] = useState<string | null>(null);
  const [subTarget, setSubTarget] = useState<{ submissionId: string; n: number } | null>(null);
  useDeepLink((link) => {
    const doc = /^doc:(library|art_[a-z0-9]+)\/([a-z0-9]+)$/.exec(link);
    if (doc) {
      setLibTab('all');
      if (doc[1] === 'library') setLibraryFile(doc[2]!);
      else setMyFile(doc[2]!);
      return setView('library');
    }
    const sub = /^submission:art_[a-z0-9]+\/([A-Za-z0-9_-]+)$/.exec(link);
    if (sub) {
      setSubTarget((was) => ({ submissionId: sub[1]!, n: (was?.n ?? 0) + 1 }));
      return setView('submit');
    }
    if (link.startsWith('brand:')) return setView('brand');
    if (link.startsWith('assets:')) {
      setLibTab('assets');
      return setView('library');
    }
    if (link.startsWith('chat:')) setChatTarget(link.slice('chat:'.length) || null);
    setView(
      link.startsWith('chat:')
        ? 'chat'
        : link === 'submit' || link === 'library'
          ? link
          : link === 'todos'
            ? 'todo'
            : link === 'plan' || link === 'profile'
              ? link
              : 'home',
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
    library: { eyebrow: 'Library', title: 'Your files' },
    brand: { eyebrow: 'Library', title: 'My brand kit' },
    submit: { eyebrow: 'Submit for review', title: 'Send to Blueprint' },
    plan: { eyebrow: 'My plan', title: 'Your plan' },
    gigs: { eyebrow: 'Gigs', title: 'My gigs' },
    connectors: { eyebrow: 'Profile', title: 'My connectors' },
    stats: { eyebrow: 'Socials', title: 'My stats' },
    contacts: { eyebrow: 'Shared by Blueprint', title: 'Contacts & venues' },
  };
  const [libTab, setLibTab] = useState<LibraryKind>('all');
  // Which list has a document page open; the rest of the library is hidden meanwhile.
  const [docOpen, setDocOpen] = useState<'mine' | 'shared' | null>(null);
  const mineOpen = useCallback((o: boolean) => {
    setDocOpen((d) => (o ? 'mine' : d === 'mine' ? null : d));
    if (!o) setMyFile(null);
  }, []);
  const sharedOpen = useCallback(
    (o: boolean) => setDocOpen((d) => (o ? 'shared' : d === 'shared' ? null : d)),
    [],
  );
  const [bookTab, setBookTab] = useState<'contacts' | 'venues'>('contacts');
  const back =
    view === 'brand' ||
    view === 'submit' ||
    view === 'plan' ||
    view === 'profile' ||
    view === 'connectors' ||
    view === 'stats' ||
    view === 'contacts';

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
                              : n.link === 'todos'
                                ? 'todo'
                                : n.link === 'plan'
                                  ? 'plan'
                                  : 'home',
                    );
                  }}
                />
                <ProfileMenu
                  userName={userName}
                  roleLabel="Artist"
                  avatar={avatar}
                  size={34}
                  onProfile={() => setView('profile')}
                  items={[
                    { label: 'My connectors', icon: 'plug', onSelect: () => setView('connectors') },
                  ]}
                  onSignOut={onSignOut}
                />
              </span>
            )
          }
        />
      }
    >
      {view === 'home' && (
        <ArtistHome
          cfg={cfg}
          token={token}
          me={me}
          onNavigate={setView}
          onOpenFile={(id) => {
            setLibraryFile(id);
            setLibTab('all');
            setView('library');
          }}
        />
      )}
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
          <div className={`flex flex-wrap items-center gap-2 ${docOpen ? 'hidden' : ''}`}>
            <Chips
              label="Type"
              value={libTab}
              onChange={setLibTab}
              options={LIBRARY_KIND_OPTIONS}
            />
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setView('brand')}>
              My brand kit
            </Button>
          </div>
          {libTab !== 'assets' ? (
            <>
              <div className={docOpen === 'shared' ? 'hidden' : 'contents'}>
                <ArtistFiles
                  cfg={cfg}
                  token={token}
                  artistId={artistId}
                  isBmg={false}
                  kind={libTab}
                  onOpenChange={mineOpen}
                  openFileId={myFile}
                />
              </div>
              <div className={docOpen === 'mine' ? 'hidden' : 'contents'}>
                {!docOpen && (
                  <div className="eyebrow pt-2 text-muted-foreground">Shared by Blueprint</div>
                )}
                <Library
                  cfg={cfg}
                  token={token}
                  isBmg={false}
                  artists={[]}
                  openFileId={libraryFile}
                  onClosed={() => setLibraryFile(null)}
                  onOpenChange={sharedOpen}
                />
              </div>
            </>
          ) : (
            <AssetLibrary
              cfg={cfg}
              token={token}
              artistId={artistId}
              artistName={userName}
              isArtist
              compact
              onOpenBrandKit={() => setView('brand')}
            />
          )}
        </>
      )}
      {view === 'brand' && (
        <BrandKit
          cfg={cfg}
          token={token}
          artistId={artistId}
          artistName={userName}
          isArtist
          compact
          onOpenAssets={() => {
            setLibTab('assets');
            setView('library');
          }}
        />
      )}
      {view === 'submit' && (
        <ArtistSubmissions
          cfg={cfg}
          token={token}
          artistId={artistId}
          isBmg={false}
          open={subTarget}
        />
      )}
      {view === 'plan' && (
        <PlanTab
          cfg={cfg}
          token={token}
          artistId={artistId}
          artistName={userName}
          canEdit={false}
        />
      )}
      {view === 'gigs' && <ArtistGigs cfg={cfg} token={token} artistId={artistId} />}
      {view === 'connectors' && <MyConnectors cfg={cfg} token={token} artistId={artistId} />}
      {view === 'contacts' && (
        <>
          <Chips
            label="Contacts or venues"
            value={bookTab}
            onChange={setBookTab}
            options={[
              { id: 'contacts', label: 'Contacts' },
              { id: 'venues', label: 'Venues' },
            ]}
          />
          {bookTab === 'contacts' ? (
            <Contacts cfg={cfg} token={token} isBmg={false} compact />
          ) : (
            <Venues cfg={cfg} token={token} isBmg={false} compact />
          )}
        </>
      )}
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
          me={{ ...me, avatar }}
          userName={userName}
          theme={theme}
          onTheme={setTheme}
          onSignOut={onSignOut}
          onReauth={onReauth}
          onAvatar={setAvatar}
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
  onOpenFile,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  onNavigate: (v: ArtistView) => void;
  /** Open a shared document's page (rev 8). */
  onOpenFile: (fileId: string) => void;
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
              aria-label="Open my plan"
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
          <button
            key={f.fileId}
            type="button"
            className="flex items-center gap-3 text-left text-[15px]"
            onClick={() => onOpenFile(f.fileId)}
          >
            <FileThumb
              src={f.thumbnailUrl}
              kind={f.fileType.kind}
              ext={f.fileType.ext}
              label={f.fileType.label}
              size={32}
            />
            <span className="truncate">{f.displayName}</span>
          </button>
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
      <section className="card gap-2.5">
        <div className="flex items-center gap-2">
          <span className="eyebrow">Contacts & venues</span>
          <button
            type="button"
            className="ml-auto text-sm font-bold underline"
            onClick={() => onNavigate('contacts')}
          >
            Open
          </button>
        </div>
        <button
          type="button"
          className="text-left text-[15px]"
          onClick={() => onNavigate('contacts')}
        >
          Venues, bookers and crew, shared with Blueprint →
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
