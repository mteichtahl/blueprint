import { useCallback, useEffect, useState } from 'react';
import {
  api,
  GOAL_MAX,
  OUTCOME_MAX,
  type ArtistSummary,
  type CustomStage,
  type MeasureId,
  type Phase,
  type Plan,
  type PlanResponse,
} from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { phaseProgress } from '../lib/plan.ts';
import { MarkdownEditor, MarkdownView } from '../components/Markdown.tsx';
import { Bar, Button, Card, Field, Notice, Tag, TextArea } from '../components/ui.tsx';
import { PlanTimeline } from '../components/PlanTimeline.tsx';

const MEASURES: MeasureId[] = ['M1', 'M2', 'M3', 'M4'];
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
const MAX_STAGES = 12;
const uid = () => Math.random().toString(36).slice(2, 10);
const STATUS = {
  done: { tone: 'n', label: 'Done', color: '#011935' },
  now: { tone: 'c', label: 'Now', color: '#D9534F' },
  next: { tone: 's', label: 'Next', color: '#5C6775' },
} as const;

/** A plan phase made from a stage: built-in (name only) or custom (goal and milestones too). */
function phaseFrom(stage: {
  name: string;
  goal?: string;
  milestones?: string[];
  stageId?: string;
}) {
  return {
    id: uid(),
    name: stage.name,
    goal: stage.goal ?? '',
    milestones: (stage.milestones ?? []).map((title) => ({
      id: uid(),
      title,
      done: false,
      measures: [] as MeasureId[],
    })),
    ...(stage.stageId ? { stageId: stage.stageId } : {}),
  } satisfies Phase;
}

/** Plan section tabs: outcome, one per stage, the alignment check (and "add stage" while editing). */
type Section =
  | { kind: 'outcome' }
  | { kind: 'phase'; id: string }
  | { kind: 'timeline' }
  | { kind: 'gaps' }
  | { kind: 'add' };
const sameSection = (a: Section, b: Section) =>
  a.kind === b.kind && (a.kind !== 'phase' || (b.kind === 'phase' && a.id === b.id));

/**
 * Artist workspace Plan tab: each section in its own tab (outcome and
 * measures, each stage, the alignment check). BMG edits, with Markdown in a
 * graphical editor; artists read. With no plan yet, BMG sees only "Start a
 * new plan".
 */
export function PlanTab({
  cfg,
  token,
  artistId,
  canEdit,
  autoStart = false,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  canEdit: boolean;
  /** Open straight into a new plan (from the workspace header's button). */
  autoStart?: boolean;
  /** Lets the workspace header refresh after a save. */
  onChanged?: () => void;
}) {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [draft, setDraft] = useState<Plan | null>(null);
  const [section, setSection] = useState<Section>({ kind: 'outcome' });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<PlanResponse>(cfg, token, 'GET', `/artists/${artistId}/plan`);
      setData(res);
      setDraft(null);
      return res;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [cfg, token, artistId]);
  useEffect(() => {
    void load().then((res) => {
      if (res && !res.exists && autoStart && canEdit) setDraft(structuredClone(res.plan));
    });
  }, [load, autoStart, canEdit]);

  async function save(plan: Plan) {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await api(cfg, token, 'PUT', `/artists/${artistId}/plan`, {
        outcome: plan.outcome,
        measures: plan.measures,
        phases: plan.phases,
        version: plan.version,
      });
      setSaved(true);
      await load();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data)
    return error ? (
      <Notice tone="error">{error}</Notice>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );

  const editing = draft !== null;
  // No plan yet: nothing but the button (BMG), or a line saying so (artist).
  if (!data.exists && !editing) {
    return canEdit ? (
      <div>
        <Button
          variant="cta"
          onClick={() => {
            setSection({ kind: 'outcome' });
            setDraft(structuredClone(data.plan));
          }}
        >
          Start a new plan
        </Button>
      </div>
    ) : (
      <p className="src">Blueprint hasn’t published your plan yet.</p>
    );
  }

  const plan = draft ?? data.plan;
  const edit = (fn: (p: Plan) => Plan) => setDraft(fn(structuredClone(plan)));
  const progress = phaseProgress(plan);
  // If the open stage was removed, fall back to the outcome tab.
  const current: Section =
    section.kind === 'phase' && !plan.phases.some((p) => p.id === section.id)
      ? { kind: 'outcome' }
      : section.kind === 'add' && !editing
        ? { kind: 'outcome' }
        : section;

  const tabs: { section: Section; label: React.ReactNode; key: string }[] = [
    { section: { kind: 'outcome' }, label: 'Outcome & measures', key: 'outcome' },
    ...plan.phases.map((p, i) => ({
      section: { kind: 'phase' as const, id: p.id },
      key: p.id,
      label: (
        <>
          {i + 1}. {p.name}
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ background: STATUS[progress[i]!.status].color }}
          />
        </>
      ),
    })),
    ...(data.exists || canEdit
      ? [
          { section: { kind: 'timeline' as const }, key: 'timeline', label: 'Timeline' },
          {
            section: { kind: 'gaps' as const },
            key: 'gaps',
            label: (
              <>
                Alignment check
                {data.gaps.length > 0 && <Tag tone="c">{data.gaps.length}</Tag>}
              </>
            ),
          },
        ]
      : []),
    ...(editing && plan.phases.length < MAX_STAGES
      ? [{ section: { kind: 'add' as const }, key: 'add', label: '+ Add stage' }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <nav
        role="tablist"
        aria-label="Plan sections"
        className="flex flex-wrap overflow-x-auto border-b border-input"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            className="stab"
            aria-selected={sameSection(current, t.section)}
            onClick={() => setSection(t.section)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {current.kind === 'outcome' && <OutcomeSection plan={plan} editing={editing} edit={edit} />}

      {current.kind === 'phase' &&
        (() => {
          const pi = plan.phases.findIndex((p) => p.id === current.id);
          return (
            <PhaseSection
              phase={plan.phases[pi]!}
              index={pi}
              count={plan.phases.length}
              progress={progress[pi]!}
              editing={editing}
              canTick={canEdit && !busy}
              edit={(fn) => edit((p) => ((p.phases[pi] = fn(p.phases[pi]!)), p))}
              move={(dir) =>
                edit((p) => {
                  const [ph] = p.phases.splice(pi, 1);
                  p.phases.splice(pi + dir, 0, ph!);
                  return p;
                })
              }
              remove={() => {
                edit((p) => (p.phases.splice(pi, 1), p));
                setSection({ kind: 'outcome' });
              }}
              onTick={(mi) => {
                const next = structuredClone(plan);
                const m = next.phases[pi]!.milestones[mi]!;
                m.done = !m.done;
                if (editing) setDraft(next);
                else void save(next);
              }}
            />
          );
        })()}

      {current.kind === 'timeline' && (
        <Card title={<span className="eyebrow">Timeline</span>}>
          {editing && (
            <span className="src">
              Showing your unsaved dates. Set them on each stage&apos;s tab.
            </span>
          )}
          <PlanTimeline phases={plan.phases} canEdit={canEdit} />
        </Card>
      )}

      {current.kind === 'gaps' && (
        <Card title={<span className="eyebrow">Alignment check</span>}>
          {editing && (
            <span className="src">Shows the saved plan. Save to check your changes.</span>
          )}
          {data.gaps.length === 0 ? (
            <p className="m-0 text-[15px]">No gaps: every measure is fed by a milestone.</p>
          ) : (
            <ul className="m-0 flex flex-col gap-1 pl-[18px] text-[15px]">
              {data.gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {current.kind === 'add' && editing && (
        <AddStage
          library={data.phaseLibrary}
          stages={data.stages ?? []}
          used={new Set(plan.phases.map((p) => p.stageId).filter(Boolean) as string[])}
          onAdd={(stage) => {
            const phase = phaseFrom(stage);
            edit((p) => (p.phases.push(phase), p));
            setSection({ kind: 'phase', id: phase.id });
          }}
        />
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          {editing ? (
            <>
              <Button variant="cta" disabled={busy} onClick={() => void save(plan)}>
                {busy ? 'Saving…' : data.exists ? 'Save plan' : 'Create plan'}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button onClick={() => setDraft(structuredClone(data.plan))}>Edit plan</Button>
          )}
        </div>
      )}
      {saved && <Notice tone="success">Plan saved.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function OutcomeSection({
  plan,
  editing,
  edit,
}: {
  plan: Plan;
  editing: boolean;
  edit: (fn: (p: Plan) => Plan) => void;
}) {
  return (
    <Card title={<span className="eyebrow">Outcome and success measures</span>}>
      {editing ? (
        <MarkdownEditor
          label="What this plan delivers"
          value={plan.outcome}
          maxLength={OUTCOME_MAX}
          placeholder="The outcome this plan works towards…"
          onChange={(md) => edit((p) => ({ ...p, outcome: md }))}
        />
      ) : plan.outcome ? (
        <MarkdownView value={plan.outcome} className="text-[17px]" />
      ) : (
        <p className="m-0 text-muted-foreground">No outcome set yet.</p>
      )}
      <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {plan.measures.map((m, i) => (
          <li key={m.id} className="tile text-[15px]">
            <span className="t text-lg">{m.id}</span>
            {editing ? (
              <input
                className="w-[80%] bg-transparent outline-none"
                value={m.label}
                placeholder="Measure"
                aria-label={`Success measure ${m.id}`}
                maxLength={200}
                onChange={(e) => edit((p) => ((p.measures[i]!.label = e.target.value), p))}
              />
            ) : (
              m.label || <span className="text-muted-foreground">—</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PhaseSection({
  phase,
  index,
  count,
  progress,
  editing,
  canTick,
  edit,
  move,
  remove,
  onTick,
}: {
  phase: Phase;
  index: number;
  count: number;
  progress: ReturnType<typeof phaseProgress>[number];
  editing: boolean;
  canTick: boolean;
  edit: (fn: (ph: Phase) => Phase) => void;
  move: (dir: -1 | 1) => void;
  remove: () => void;
  onTick: (milestoneIndex: number) => void;
}) {
  const st = STATUS[progress.status];
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        {editing ? (
          <div className="min-w-60 flex-1">
            <Field
              label="Stage name"
              value={phase.name}
              maxLength={80}
              onChange={(e) => edit((ph) => ({ ...ph, name: e.target.value }))}
            />
          </div>
        ) : (
          <h3 className="t m-0 flex-1 text-xl">
            {index + 1}. {phase.name}
          </h3>
        )}
        <Tag tone={st.tone}>{st.label}</Tag>
        <span className="src">
          {progress.done}/{progress.total} done
        </span>
      </div>
      <Bar pct={progress.pct} color={st.color} />
      {editing ? (
        <MarkdownEditor
          label="Goal"
          value={phase.goal}
          maxLength={GOAL_MAX}
          placeholder="What this stage is for, and how you'll know it's done…"
          onChange={(md) => edit((ph) => ({ ...ph, goal: md }))}
        />
      ) : (
        phase.goal && (
          <div className="flex flex-col gap-1">
            <span className="eyebrow text-muted-foreground">Goal</span>
            <MarkdownView value={phase.goal} />
          </div>
        )
      )}
      {editing ? (
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Stage starts"
            type="date"
            value={phase.start ?? ''}
            onChange={(e) =>
              edit((ph) => {
                const next = { ...ph };
                if (e.target.value) next.start = e.target.value;
                else delete next.start;
                return next;
              })
            }
          />
          <Field
            label="Stage ends"
            type="date"
            value={phase.end ?? ''}
            min={phase.start}
            onChange={(e) =>
              edit((ph) => {
                const next = { ...ph };
                if (e.target.value) next.end = e.target.value;
                else delete next.end;
                return next;
              })
            }
            {...(phase.start && phase.end && phase.end < phase.start
              ? { hint: "A stage can't end before it starts" }
              : {})}
          />
        </div>
      ) : (
        (phase.start || phase.end) && (
          <span className="src">
            {[phase.start, phase.end]
              .filter(Boolean)
              .map((d) => fmtDay(d!))
              .join(' – ')}
          </span>
        )
      )}
      <ul className="m-0 flex list-none flex-col p-0">
        {phase.milestones.map((m, mi) => (
          <li key={m.id} className="li text-[15px]">
            <input
              type="checkbox"
              className="chk"
              checked={m.done}
              disabled={!canTick}
              aria-label={`Milestone "${m.title}" done`}
              onChange={() => onTick(mi)}
            />
            {editing ? (
              <MilestoneTitle
                title={m.title}
                onChange={(title) =>
                  edit((ph) => {
                    ph.milestones[mi] = { ...ph.milestones[mi]!, title };
                    return ph;
                  })
                }
              />
            ) : (
              <span className={m.done ? 'text-muted-foreground line-through' : ''}>
                {m.title}
                {m.due && <span className="src"> · due {fmtDay(m.due)}</span>}
              </span>
            )}
            {editing && (
              <input
                type="date"
                aria-label={`Due date for ${m.title}`}
                className="min-h-9 rounded-md border border-input bg-white px-2 text-[14px]"
                value={m.due ?? ''}
                onChange={(e) =>
                  edit((ph) => {
                    const ms = { ...ph.milestones[mi]! };
                    if (e.target.value) ms.due = e.target.value;
                    else delete ms.due;
                    ph.milestones[mi] = ms;
                    return ph;
                  })
                }
              />
            )}
            <span className="ml-auto flex gap-1">
              {MEASURES.map((id) =>
                editing ? (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={m.measures.includes(id)}
                    aria-label={`Feeds ${id}`}
                    className={`tag ${m.measures.includes(id) ? 'tn' : 'ts'}`}
                    onClick={() =>
                      edit((ph) => {
                        const ms = ph.milestones[mi]!.measures;
                        ph.milestones[mi]!.measures = ms.includes(id)
                          ? ms.filter((x) => x !== id)
                          : [...ms, id];
                        return ph;
                      })
                    }
                  >
                    {id}
                  </button>
                ) : (
                  m.measures.includes(id) && (
                    <span key={id} className="tag ts">
                      {id}
                    </span>
                  )
                ),
              )}
              {editing && (
                <button
                  type="button"
                  className="ml-2 text-xs text-destructive"
                  onClick={() => edit((ph) => (ph.milestones.splice(mi, 1), ph))}
                >
                  Remove
                </button>
              )}
            </span>
          </li>
        ))}
        {phase.milestones.length === 0 && !editing && <li className="src">No milestones yet.</li>}
      </ul>
      {editing && (
        <>
          <AddMilestone
            onAdd={(title) =>
              edit(
                (ph) => (ph.milestones.push({ id: uid(), title, done: false, measures: [] }), ph),
              )
            }
          />
          <div className="flex flex-wrap gap-2 border-t border-input pt-3">
            <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => move(-1)}>
              ← Move earlier
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={index === count - 1}
              onClick={() => move(1)}
            >
              Move later →
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-destructive"
              disabled={count <= 1}
              title={count <= 1 ? 'A plan needs at least one stage' : undefined}
              onClick={remove}
            >
              Remove stage
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Edit a milestone's name in place (rev 7). An empty name isn't kept: the
 * field goes back to the last name on blur.
 */
function MilestoneTitle({ title, onChange }: { title: string; onChange: (t: string) => void }) {
  const [v, setV] = useState(title);
  return (
    <input
      aria-label={`Milestone name: ${title}`}
      className="min-h-9 min-w-0 flex-1 rounded-md border border-input bg-white px-2 text-[15px]"
      maxLength={200}
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        if (e.target.value.trim()) onChange(e.target.value.trim());
      }}
      onBlur={() => !v.trim() && setV(title)}
    />
  );
}

/** Add a stage while editing: from the built-in library, a custom stage, or a blank one. */
function AddStage({
  library,
  stages,
  used,
  onAdd,
}: {
  library: string[];
  stages: CustomStage[];
  used: Set<string>;
  onAdd: (stage: { name: string; goal?: string; milestones?: string[]; stageId?: string }) => void;
}) {
  const [name, setName] = useState('');
  return (
    <Card title={<span className="eyebrow">Add a stage</span>}>
      {stages.length > 0 && (
        <div className="flex flex-col gap-2">
          <b className="text-[15px]">Custom stages for this artist</b>
          <div className="flex flex-wrap gap-2">
            {stages.map((st) => (
              <Button
                key={st.stageId}
                size="sm"
                variant="ghost"
                disabled={used.has(st.stageId)}
                title={used.has(st.stageId) ? 'Already in this plan' : undefined}
                onClick={() => onAdd({ ...st })}
              >
                {st.name}
                {st.milestones.length > 0 && (
                  <span className="src">· {st.milestones.length} milestones</span>
                )}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <b className="text-[15px]">Phase library</b>
        <div className="flex flex-wrap gap-2">
          {library.map((n) => (
            <Button key={n} size="sm" variant="ghost" onClick={() => onAdd({ name: n })}>
              {n}
            </Button>
          ))}
        </div>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onAdd({ name: name.trim() });
          setName('');
        }}
      >
        <div className="min-w-60 flex-1">
          <Field
            label="Or a new stage, just for this plan"
            value={name}
            maxLength={80}
            placeholder="Stage name"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={!name.trim()}>
          Add
        </Button>
      </form>
      <span className="src">
        Reusable stages for one or more artists are set up under Plan templates.
      </span>
    </Card>
  );
}

function AddMilestone({ onAdd }: { onAdd: (title: string) => void }) {
  const [title, setTitle] = useState('');
  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onAdd(title.trim());
        setTitle('');
      }}
    >
      <input
        className="min-h-[38px] flex-1 rounded-lg border border-input bg-white px-3 text-base shadow-xs"
        placeholder="New milestone"
        aria-label="New milestone"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Button type="submit" variant="ghost">
        Add
      </Button>
    </form>
  );
}

// ── Plan templates screen: custom stages ──────────────────────────────────

interface StagesResponse {
  stages: CustomStage[];
  phaseLibrary: string[];
}
type StageDraft = Omit<CustomStage, 'stageId' | 'createdAt' | 'updatedAt'>;
const emptyStage = (): StageDraft => ({
  name: '',
  goal: '',
  milestones: [],
  appliesTo: 'all',
  artistIds: [],
});

/**
 * Plan templates (BMG): custom stages that apply to every artist or to
 * chosen ones. They're offered when editing those artists' plans, and can be
 * added to their existing plans in one go.
 */
export function PlanStages({
  cfg,
  token,
  artists,
}: {
  cfg: AppConfig;
  token: string;
  artists: ArtistSummary[];
}) {
  const [data, setData] = useState<StagesResponse | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: StageDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));

  const load = useCallback(async () => {
    try {
      setData(await api<StagesResponse>(cfg, token, 'GET', '/plan-stages'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  useEffect(() => void load(), [load]);

  async function save() {
    if (!editing) return;
    setError(null);
    try {
      const body = {
        ...editing.draft,
        artistIds: editing.draft.appliesTo === 'selected' ? editing.draft.artistIds : [],
      };
      if (editing.id) await api(cfg, token, 'PUT', `/plan-stages/${editing.id}`, body);
      else await api(cfg, token, 'POST', '/plan-stages', body);
      setMsg(`“${editing.draft.name}” saved.`);
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(st: CustomStage) {
    try {
      await api(cfg, token, 'DELETE', `/plan-stages/${st.stageId}`);
      setMsg(`“${st.name}” deleted. Plans that already use it keep their copy.`);
      if (editing?.id === st.stageId) setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function apply(st: CustomStage) {
    const ids = st.appliesTo === 'all' ? artists.map((a) => a.artistId) : st.artistIds;
    if (ids.length === 0) return;
    try {
      const r = await api<{ added: string[]; alreadyThere: string[]; noPlan: string[] }>(
        cfg,
        token,
        'POST',
        `/plan-stages/${st.stageId}/apply`,
        { artistIds: ids },
      );
      const list = (xs: string[]) => xs.map((id) => names[id] ?? 'Artist').join(', ');
      setMsg(
        [
          r.added.length ? `Added to ${list(r.added)}.` : 'Not added to any plan.',
          r.alreadyThere.length ? `Already in ${list(r.alreadyThere)}.` : '',
          r.noPlan.length
            ? `${list(r.noPlan)} ha${r.noPlan.length === 1 ? 's' : 've'} no plan yet.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!data) return error ? <Notice tone="error">{error}</Notice> : <p className="src">Loading…</p>;

  return (
    <div className="flex flex-wrap items-start gap-5">
      <Card
        className="flex-[2_1_520px]"
        title="Custom stages"
        action={
          <Button
            size="sm"
            variant="cta"
            onClick={() => setEditing({ id: null, draft: emptyStage() })}
          >
            New stage
          </Button>
        }
      >
        {msg && <Notice tone="success">{msg}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {data.stages.length === 0 ? (
          <p className="src">
            No custom stages yet. Create one for a type of work you repeat, such as a radio campaign
            or a tour.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {data.stages.map((st) => (
              <li key={st.stageId} className="li flex-wrap text-[15px]">
                <span className="min-w-0 flex-1">
                  <b className="block">{st.name}</b>
                  <span className="src">
                    {st.appliesTo === 'all'
                      ? 'All artists'
                      : st.artistIds.map((id) => names[id] ?? 'Artist').join(', ')}
                    {` · ${st.milestones.length} milestone${st.milestones.length === 1 ? '' : 's'}`}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void apply(st)}>
                  Add to plans
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setEditing({
                      id: st.stageId,
                      draft: {
                        name: st.name,
                        goal: st.goal,
                        milestones: st.milestones,
                        appliesTo: st.appliesTo,
                        artistIds: st.artistIds,
                      },
                    })
                  }
                >
                  Edit
                </Button>
                <ConfirmButton label="Delete" onConfirm={() => remove(st)} />
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 border-t border-input pt-3">
          <span className="eyebrow text-muted-foreground">Built-in phase library</span>
          <div className="flex flex-wrap gap-1.5">
            {data.phaseLibrary.map((n) => (
              <Tag key={n} tone="s">
                {n}
              </Tag>
            ))}
          </div>
        </div>
      </Card>
      {editing && (
        <div className="flex-[1_1_380px]">
          <StageEditor
            draft={editing.draft}
            isNew={!editing.id}
            artists={artists}
            onChange={(draft) => setEditing({ ...editing, draft })}
            onSave={() => void save()}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}
    </div>
  );
}

function StageEditor({
  draft,
  isNew,
  artists,
  onChange,
  onSave,
  onCancel,
}: {
  draft: StageDraft;
  isNew: boolean;
  artists: ArtistSummary[];
  onChange: (d: StageDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [milestones, setMilestones] = useState(draft.milestones.join('\n'));
  const set = (patch: Partial<StageDraft>) => onChange({ ...draft, ...patch });
  const pickedOk = draft.appliesTo === 'all' || draft.artistIds.length > 0;
  return (
    <Card title={isNew ? 'New stage' : 'Edit stage'}>
      <Field
        label="Name"
        value={draft.name}
        maxLength={80}
        onChange={(e) => set({ name: e.target.value })}
      />
      <MarkdownEditor
        label="Goal"
        value={draft.goal}
        maxLength={GOAL_MAX}
        placeholder="What this stage is for…"
        onChange={(goal) => set({ goal })}
      />
      <TextArea
        label="Starting milestones (one per line)"
        value={milestones}
        onChange={(e) => {
          setMilestones(e.target.value);
          set({
            milestones: e.target.value
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 30),
          });
        }}
      />
      <fieldset className="flex flex-col gap-2 text-[15px]">
        <legend className="mb-1 font-bold">Applies to</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="appliesTo"
            checked={draft.appliesTo === 'all'}
            onChange={() => set({ appliesTo: 'all' })}
          />
          All artists
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="appliesTo"
            checked={draft.appliesTo === 'selected'}
            onChange={() => set({ appliesTo: 'selected' })}
          />
          Chosen artists
        </label>
        {draft.appliesTo === 'selected' && (
          <div className="grid gap-1 pl-6 sm:grid-cols-2">
            {artists.map((a) => (
              <label key={a.artistId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="chk"
                  checked={draft.artistIds.includes(a.artistId)}
                  onChange={(e) =>
                    set({
                      artistIds: e.target.checked
                        ? [...draft.artistIds, a.artistId]
                        : draft.artistIds.filter((id) => id !== a.artistId),
                    })
                  }
                />
                {a.displayName}
              </label>
            ))}
            {artists.length === 0 && <p className="src">No artists yet.</p>}
          </div>
        )}
      </fieldset>
      <div className="flex gap-2">
        <Button variant="cta" disabled={!draft.name.trim() || !pickedOk} onClick={onSave}>
          Save stage
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** A button that asks for a second click before acting (no browser dialogs). */
function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size="sm"
      variant={armed ? 'cta' : 'ghost'}
      onClick={() => (armed ? void onConfirm().finally(() => setArmed(false)) : setArmed(true))}
    >
      {armed ? 'Confirm' : label}
    </Button>
  );
}
