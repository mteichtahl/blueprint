import { useCallback, useEffect, useState } from 'react';
import { ArtistStats } from './Insights.tsx';
import {
  api,
  type Me,
  type ArtistSummary,
  type PlanResponse,
  type SubmissionSummary,
  type Todo,
} from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { phaseProgress } from '../lib/plan.ts';
import { markdownToText } from '../lib/markdown.ts';
import { Avatar, Bar, Button, Card, Chips, Icon, shortDate, Tag } from '../components/ui.tsx';
import { GigsTab } from './Gigs.tsx';
import { AssetLibrary } from './Assets.tsx';
import { BrandKit } from './BrandKit.tsx';
import { ArtistFiles, LIBRARY_KIND_OPTIONS, type LibraryKind } from './Library.tsx';
import { ArtistChatTab, useNarrow } from './Messages.tsx';
import { PlanTab } from './PlanLazy.tsx';
import type { PlanView } from './Plan.tsx';
import { ArtistSubmissions, PRIORITY_TAG } from './Review.tsx';
import { ArtistTodos } from './Todos.tsx';
import { LatestMeetingCard, PlanSuggestionsBanner, useArtistMeetings } from './Meetings.tsx';
import type { Meeting } from '../lib/meetings.ts';

/**
 * Workspace tabs (screens doc rev 9): four tabs, each with a section switch
 * underneath. Chat isn't a tab; it opens as a side panel beside any tab.
 */
const GROUPS = [
  {
    id: 'overview',
    label: 'Overview',
    sections: [
      { id: 'summary', label: 'Summary' },
      { id: 'stats', label: 'Stats' },
    ],
  },
  {
    id: 'plan',
    label: 'Plan',
    sections: [
      // Rev 13: the plan's own sections live here, so there are only two levels.
      { id: 'plan', label: 'Outcome' },
      { id: 'stages', label: 'Stages' },
      { id: 'timeline', label: 'Timeline' },
      { id: 'history', label: 'History' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    sections: [
      // To-dos sit with the other day-to-day work, not inside the plan.
      { id: 'todo', label: 'To-dos' },
      { id: 'submissions', label: 'Submissions' },
      { id: 'gigs', label: 'Gigs' },
    ],
  },
  {
    id: 'files',
    label: 'Files',
    sections: [
      { id: 'library', label: 'Library' },
      { id: 'brand', label: 'Brand kit' },
    ],
  },
] as const;
type Group = (typeof GROUPS)[number];
/** Workspace sections that show the plan, and which part of it. */
const PLAN_TABS: Partial<Record<string, PlanView>> = {
  plan: 'outcome',
  stages: 'stages',
  timeline: 'timeline',
  history: 'history',
};
type GroupId = Group['id'];
export type TabId = Group['sections'][number]['id'];
const groupOf = (s: TabId): Group => GROUPS.find((g) => g.sections.some((x) => x.id === s))!;

/** A count on a tab or section; coral when it's waiting on Blueprint. */
function Count({ n, hot = false }: { n: number; hot?: boolean }) {
  if (!n) return null;
  // Named with the tab, as it reads: "Work 2".
  return <span className={`cnt ${hot ? 'cnt-hot' : ''}`}>{n}</span>;
}

const STATUS_TAG = { done: ['n', 'Done'], now: ['c', 'Now'], next: ['s', 'Next'] } as const;
const STATUS_COLOR = { done: '#011935', now: '#D9534F', next: '#5C6775' } as const;

/** The plan outcome card on the workspace Overview tab: outcome plus the artist's own phases. */
export function PlanStrip({
  plan,
  onOpenPlan,
  onStartPlan,
}: {
  plan: PlanResponse | null;
  onOpenPlan?: () => void;
  /** No plan yet: the strip is just this button. */
  onStartPlan?: () => void;
}) {
  if (!plan) return null;
  if (!plan.exists) {
    return onStartPlan ? (
      <div>
        <Button variant="cta" onClick={onStartPlan}>
          Start a new plan
        </Button>
      </div>
    ) : null;
  }
  const phases = phaseProgress(plan.plan);
  return (
    <section className="card gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="eyebrow">Plan outcome</span>
        <b className="line-clamp-2 min-w-[min(260px,100%)] flex-1">
          {markdownToText(plan.plan.outcome) || (
            <span className="font-normal text-muted-foreground">No outcome set yet</span>
          )}
        </b>
        {onOpenPlan && (
          <button type="button" className="font-bold underline" onClick={onOpenPlan}>
            Open plan
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-4">
        {phases.map((p) => (
          <div key={p.id} className="flex min-w-[150px] flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-1.5 text-[15px]">
              <b className="flex-1 truncate">{p.name}</b>
              <Tag tone={STATUS_TAG[p.status][0]}>{STATUS_TAG[p.status][1]}</Tag>
            </div>
            <Bar pct={p.pct} color={STATUS_COLOR[p.status]} />
            <span className="src">
              {p.total ? `${p.done} of ${p.total} milestones · ${p.pct}%` : 'No milestones yet'}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Artist workspace (BMG view): header and tabs; the plan outcome card sits on Overview. */
export function ArtistWorkspace({
  cfg,
  token,
  me,
  artist,
  onNavigate,
  onOpenChat,
  onRecordMeeting,
  onOpenMeeting,
  initialTab,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artist: ArtistSummary;
  /** Opens a Studio HQ view (chat attachment cards). */
  onNavigate?: (view: string) => void;
  /** "Open in Chat": the full Chat page on this conversation. */
  onOpenChat?: (conversationId: string) => void;
  /** Record meeting (rev 11): a new meeting about this artist. */
  onRecordMeeting?: () => void;
  /** Opens one of this artist's meetings. */
  onOpenMeeting?: (m: Meeting) => void;
  /** Open on this section (a notification link, e.g. a plan update). */
  initialTab?: TabId;
}) {
  const meetings = useArtistMeetings(cfg, token, artist.artistId);
  const planReview = meetings.reduce((n, m) => n + m.suggestionsWaiting, 0);
  const [tab, setTabState] = useState<TabId>('summary');
  // Each tab reopens on the section last used in it.
  const [lastIn, setLastIn] = useState<Partial<Record<GroupId, TabId>>>({});
  const setTab = useCallback((t: TabId) => {
    setTabState(t);
    setLastIn((m) => ({ ...m, [groupOf(t).id]: t }));
  }, []);
  const [libKind, setLibKind] = useState<LibraryKind>('all');
  const [chatOpen, setChatOpen] = useState(false);
  const narrow = useNarrow();
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [startPlan, setStartPlan] = useState(false);
  const [counts, setCounts] = useState({ submissions: 0, todos: 0 });
  const loadPlan = useCallback(() => {
    api<PlanResponse>(cfg, token, 'GET', `/artists/${artist.artistId}/plan`)
      .then(setPlan)
      .catch(() => setPlan(null));
  }, [cfg, token, artist.artistId]);
  const loadCounts = useCallback(() => {
    const base = `/artists/${artist.artistId}`;
    void Promise.all([
      api<{ submissions: SubmissionSummary[] }>(cfg, token, 'GET', `${base}/submissions`)
        .then((r) => r.submissions.filter((x) => x.status === 'open').length)
        .catch(() => 0),
      api<{ todos: Todo[] }>(cfg, token, 'GET', `${base}/todos`)
        .then((r) => r.todos.length)
        .catch(() => 0),
    ]).then(([submissions, todos]) => setCounts({ submissions, todos }));
  }, [cfg, token, artist.artistId]);
  useEffect(() => {
    setTabState(initialTab ?? 'summary');
    setLastIn({});
    setLibKind('all');
    setChatOpen(false);
    setStartPlan(false);
    loadPlan();
    loadCounts();
  }, [loadPlan, loadCounts, initialTab]);
  // Counts follow what's open, so a review or a ticked to-do shows on the tabs.
  useEffect(() => loadCounts(), [tab, loadCounts]);

  const group = groupOf(tab);
  const sectionCount: Partial<Record<TabId, { n: number; hot?: boolean }>> = {
    plan: { n: planReview, hot: true },
    todo: { n: counts.todos },
    submissions: { n: counts.submissions, hot: true },
  };
  const groupCount: Partial<Record<GroupId, { n: number; hot?: boolean }>> = {
    plan: { n: planReview, hot: true },
    // Work holds to-dos and submissions; submissions waiting on Blueprint show first (coral).
    work: counts.submissions ? sectionCount.submissions : sectionCount.todo,
  };
  const chat = (
    <ArtistChatTab
      cfg={cfg}
      token={token}
      me={me}
      artist={artist}
      onNavigate={onNavigate}
      onOpenChat={onOpenChat}
      onBack={() => setChatOpen(false)}
      panel
    />
  );

  return (
    <>
      <header className="page-head flex flex-wrap items-center gap-[18px]">
        <Avatar name={artist.displayName} artistId={artist.artistId} size={64} />
        <div className="flex min-w-[min(300px,100%)] flex-1 flex-col gap-1">
          <span className="eyebrow">Artist workspace</span>
          <div className="flex items-center gap-3">
            <h1 className="t m-0 min-w-0 flex-1 text-[38px] leading-tight">{artist.displayName}</h1>
            {onRecordMeeting && (
              <Button size="sm" className="shrink-0" onClick={onRecordMeeting}>
                <Icon name="record" size={16} /> Record meeting
              </Button>
            )}
            {/* Chat toggle: an icon on the far right of the name line. */}
            <Button
              size="sm"
              variant={chatOpen ? 'navy' : 'default'}
              className="w-[38px] shrink-0 !px-0"
              aria-label={chatOpen ? 'Close chat' : `Chat with ${artist.displayName}`}
              title={chatOpen ? 'Close chat' : 'Chat'}
              aria-expanded={chatOpen}
              aria-controls="ws-chat"
              onClick={() => setChatOpen((v) => !v)}
            >
              <Icon name="chat" size={18} />
            </Button>
          </div>
          <p className="m-0 text-[17px] text-muted-foreground">
            Joined {shortDate(artist.createdAt)}
            {artist.status ? ` · ${artist.status}` : ''}
            {/* Plan owner (rev 12); changed from the Plan tab. */}
            {plan?.exists &&
              (plan.owner ? (
                <>
                  {' · Plan owner '}
                  <b className="text-foreground">{plan.owner.displayName}</b>
                </>
              ) : null)}
          </p>
          {plan?.exists && plan.ownerNeeded && (
            <button
              type="button"
              className="w-fit"
              onClick={() => setTab('plan')}
              title="Open the plan to choose an owner"
            >
              <Tag tone="c">Plan needs an owner</Tag>
            </button>
          )}
        </div>
      </header>
      <nav
        aria-label="Workspace"
        role="tablist"
        className="page-head flex flex-wrap border-b border-input"
      >
        {GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            className="wtab"
            aria-selected={group.id === g.id}
            onClick={() => setTab(lastIn[g.id] ?? g.sections[0].id)}
          >
            {g.label} {groupCount[g.id] && <Count {...groupCount[g.id]!} />}
          </button>
        ))}
      </nav>
      <div role="tablist" aria-label={`${group.label} sections`} className="page-head seg">
        {group.sections.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
          >
            {x.label} {sectionCount[x.id] && <Count {...sectionCount[x.id]!} />}
          </button>
        ))}
      </div>
      {chatOpen && narrow ? (
        chat
      ) : (
        <div className="flex items-start gap-5">
          <div className="flex min-w-0 flex-1 flex-col gap-[22px]">
            {tab === 'summary' && (
              <>
                <PlanStrip
                  plan={plan}
                  onOpenPlan={() => setTab('plan')}
                  onStartPlan={() => {
                    setStartPlan(true);
                    setTab('plan');
                  }}
                />
                <WorkspaceOverview cfg={cfg} token={token} artist={artist} onTab={setTab} />
                {onOpenMeeting && onRecordMeeting && (
                  <div className="flex flex-wrap gap-5">
                    <LatestMeetingCard
                      meetings={meetings}
                      onOpen={onOpenMeeting}
                      onRecord={onRecordMeeting}
                    />
                  </div>
                )}
              </>
            )}
            {PLAN_TABS[tab] && onOpenMeeting && (
              <PlanSuggestionsBanner meetings={meetings} onOpen={onOpenMeeting} />
            )}
            {PLAN_TABS[tab] && (
              <PlanTab
                view={PLAN_TABS[tab]}
                cfg={cfg}
                token={token}
                artistId={artist.artistId}
                artistName={artist.displayName}
                canEdit
                autoStart={startPlan}
                onChanged={loadPlan}
                meSub={me.sub}
              />
            )}
            {tab === 'todo' && (
              <ArtistTodos cfg={cfg} token={token} artistId={artist.artistId} isBmg />
            )}
            {tab === 'submissions' && (
              <ArtistSubmissions cfg={cfg} token={token} artistId={artist.artistId} isBmg />
            )}
            {tab === 'gigs' && <GigsTab cfg={cfg} token={token} artist={artist} />}
            {tab === 'stats' && (
              <ArtistStats
                cfg={cfg}
                token={token}
                artistId={artist.artistId}
                name={artist.displayName}
              />
            )}
            {tab === 'library' && (
              <>
                <Chips
                  label="Type"
                  value={libKind}
                  onChange={setLibKind}
                  options={LIBRARY_KIND_OPTIONS}
                />
                {libKind === 'assets' ? (
                  <AssetLibrary
                    cfg={cfg}
                    token={token}
                    artistId={artist.artistId}
                    artistName={artist.displayName}
                    isArtist={false}
                    onOpenBrandKit={() => setTab('brand')}
                  />
                ) : (
                  <ArtistFiles
                    cfg={cfg}
                    token={token}
                    artistId={artist.artistId}
                    isBmg
                    isAdmin={me.role === 'bmg-admin'}
                    kind={libKind}
                  />
                )}
              </>
            )}
            {tab === 'brand' && (
              <BrandKit
                cfg={cfg}
                token={token}
                artistId={artist.artistId}
                artistName={artist.displayName}
                isArtist={false}
                onOpenAssets={() => {
                  setLibKind('assets');
                  setTab('library');
                }}
              />
            )}
          </div>
          {chatOpen && (
            <aside id="ws-chat" aria-label={`Chat with ${artist.displayName}`} className="ws-chat">
              {chat}
            </aside>
          )}
        </div>
      )}
    </>
  );
}

function WorkspaceOverview({
  cfg,
  token,
  artist,
  onTab,
}: {
  cfg: AppConfig;
  token: string;
  artist: ArtistSummary;
  onTab: (t: TabId) => void;
}) {
  const [subs, setSubs] = useState<SubmissionSummary[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const base = `/artists/${artist.artistId}`;
  useEffect(() => {
    api<{ submissions: SubmissionSummary[] }>(cfg, token, 'GET', `${base}/submissions`)
      .then((r) => setSubs(r.submissions.filter((s) => s.status === 'open')))
      .catch(() => setSubs([]));
    api<{ todos: Todo[] }>(cfg, token, 'GET', `${base}/todos`)
      .then((r) => setTodos(r.todos))
      .catch(() => setTodos([]));
    api<{ todos: Todo[] }>(cfg, token, 'GET', `${base}/todos?filter=done`)
      .then((r) => setDoneCount(r.todos.length))
      .catch(() => setDoneCount(0));
  }, [cfg, token, base]);
  const total = todos.length + doneCount;

  return (
    <div className="flex flex-wrap items-stretch gap-5">
      <Card
        className="min-w-[min(360px,100%)] flex-[2_1_360px]"
        title={<h2 className="t text-[22px]">Waiting for your review</h2>}
        action={
          <button
            type="button"
            className="font-bold underline"
            onClick={() => onTab('submissions')}
          >
            All submissions
          </button>
        }
      >
        {subs.length === 0 ? (
          <p className="src">Nothing waiting for review.</p>
        ) : (
          subs.slice(0, 4).map((s) => (
            <div key={s.submissionId} className="li">
              <Tag tone={PRIORITY_TAG[s.priority][0]}>{PRIORITY_TAG[s.priority][1]}</Tag>
              <span className="flex-1">{s.title}</span>
              <span className="src">by {shortDate(s.neededBy)}</span>
            </div>
          ))
        )}
        {subs.length > 0 && (
          <span className="src">
            Provide feedback from Submissions; it goes into the to-do list.
          </span>
        )}
      </Card>
      <Card
        className="min-w-[min(300px,100%)] flex-[1_1_300px]"
        title={<h2 className="t text-[22px]">To-do</h2>}
        action={
          <>
            <span className="src">
              {doneCount} of {total} done
            </span>
            <button type="button" className="font-bold underline" onClick={() => onTab('todo')}>
              Open
            </button>
          </>
        }
      >
        <Bar pct={total ? (doneCount / total) * 100 : 0} />
        {todos.slice(0, 4).map((t) => (
          <div key={t.todoId} className="flex min-h-10 items-center gap-3">
            <span className="flex-1">{t.title}</span>
            {t.due && <Tag tone="s">{shortDate(t.due)}</Tag>}
          </div>
        ))}
        {todos.length === 0 && <p className="src">No open to-dos.</p>}
      </Card>
    </div>
  );
}
