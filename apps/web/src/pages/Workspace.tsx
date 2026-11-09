import { useCallback, useEffect, useState } from 'react';
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
import { Avatar, Bar, Button, Card, shortDate, Tag } from '../components/ui.tsx';
import { ArtistFiles } from './Library.tsx';
import { ArtistChatTab } from './Messages.tsx';
import { PlanTab } from './PlanLazy.tsx';
import { ArtistSubmissions, PRIORITY_TAG } from './Review.tsx';
import { ArtistTodos } from './Todos.tsx';

/** Workspace tabs from the screens doc; the greyed ones arrive in later phases. */
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'chat', label: 'Chat' },
  { id: 'plan', label: 'Plan' },
  { id: 'todo', label: 'To-do' },
  { id: 'submissions', label: 'Submissions' },
  { id: 'gigs', label: 'Gigs', soon: true },
  { id: 'library', label: 'Library' },
  { id: 'assets', label: 'Assets', soon: true },
  { id: 'brand', label: 'Brand kit', soon: true },
  { id: 'stats', label: 'Stats', soon: true },
] as const;
type TabId = (typeof TABS)[number]['id'];

const STATUS_TAG = { done: ['n', 'Done'], now: ['c', 'Now'], next: ['s', 'Next'] } as const;
const STATUS_COLOR = { done: '#011935', now: '#D9534F', next: '#5C6775' } as const;

/** The plan strip in the workspace header: outcome plus the artist's own phases. */
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
        <b className="line-clamp-2 min-w-[260px] flex-1">
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

/** Artist workspace (BMG view): header, plan strip and tabs. */
export function ArtistWorkspace({
  cfg,
  token,
  me,
  artist,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artist: ArtistSummary;
}) {
  const [tab, setTab] = useState<TabId>('overview');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [startPlan, setStartPlan] = useState(false);
  const loadPlan = useCallback(() => {
    api<PlanResponse>(cfg, token, 'GET', `/artists/${artist.artistId}/plan`)
      .then(setPlan)
      .catch(() => setPlan(null));
  }, [cfg, token, artist.artistId]);
  useEffect(() => {
    setTab('overview');
    setStartPlan(false);
    loadPlan();
  }, [loadPlan]);

  return (
    <>
      <header className="flex flex-wrap items-center gap-[18px]">
        <Avatar name={artist.displayName} size={64} />
        <div className="flex min-w-[300px] flex-1 flex-col gap-1">
          <span className="eyebrow">Artist workspace</span>
          <h1 className="t m-0 text-[38px] leading-tight">{artist.displayName}</h1>
          <p className="m-0 text-[17px] text-muted-foreground">
            Joined {shortDate(artist.createdAt)}
            {artist.status ? ` · ${artist.status}` : ''}
          </p>
        </div>
      </header>
      <PlanStrip
        plan={plan}
        onOpenPlan={() => setTab('plan')}
        onStartPlan={() => {
          setStartPlan(true);
          setTab('plan');
        }}
      />
      <nav aria-label="Workspace" role="tablist" className="flex flex-wrap border-b border-input">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="wtab"
            aria-selected={tab === t.id}
            disabled={'soon' in t}
            title={'soon' in t ? 'Coming in a later release' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'overview' && (
        <WorkspaceOverview cfg={cfg} token={token} artist={artist} onTab={setTab} />
      )}
      {tab === 'chat' && <ArtistChatTab cfg={cfg} token={token} me={me} artist={artist} />}
      {tab === 'plan' && (
        <PlanTab
          cfg={cfg}
          token={token}
          artistId={artist.artistId}
          canEdit
          autoStart={startPlan}
          onChanged={loadPlan}
        />
      )}
      {tab === 'todo' && <ArtistTodos cfg={cfg} token={token} artistId={artist.artistId} isBmg />}
      {tab === 'submissions' && (
        <ArtistSubmissions cfg={cfg} token={token} artistId={artist.artistId} isBmg />
      )}
      {tab === 'library' && (
        <ArtistFiles
          cfg={cfg}
          token={token}
          artistId={artist.artistId}
          isBmg
          isAdmin={me.role === 'bmg-admin'}
        />
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
        className="min-w-[360px] flex-[2_1_360px]"
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
        className="min-w-[300px] flex-[1_1_300px]"
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
