import { useCallback, useEffect, useState } from 'react';
import { api, type MeasureId, type Plan, type PlanResponse } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { Button, Card, Field, Notice } from '../components/ui.tsx';

const MEASURES: MeasureId[] = ['M1', 'M2', 'M3', 'M4'];
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Artist workspace Plan tab: outcome, success measures M1–M4, phases with
 * milestones, and the alignment check. BMG edits; artists read.
 */
export function PlanTab({
  cfg,
  token,
  artistId,
  canEdit,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  canEdit: boolean;
}) {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [draft, setDraft] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<PlanResponse>(cfg, token, 'GET', `/artists/${artistId}/plan`);
      setData(res);
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, artistId]);
  useEffect(() => void load(), [load]);

  async function save(plan: Plan) {
    setError(null);
    setSaved(false);
    try {
      await api(cfg, token, 'PUT', `/artists/${artistId}/plan`, {
        outcome: plan.outcome,
        measures: plan.measures,
        phases: plan.phases,
        version: plan.version,
      });
      setSaved(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!data)
    return error ? (
      <Notice tone="error">{error}</Notice>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  const plan = draft ?? data.plan;
  const editing = draft !== null;
  const edit = (fn: (p: Plan) => Plan) => setDraft(fn(structuredClone(plan)));

  return (
    <div className="space-y-4">
      {!data.exists && !editing && (
        <Notice>
          {canEdit
            ? 'No plan yet. Start from the template below.'
            : 'Blueprint hasn’t published your plan yet.'}
        </Notice>
      )}
      {data.gaps.length > 0 && !editing && (data.exists || canEdit) && (
        <Notice>
          <strong>Alignment check:</strong> {data.gaps.join(' ')}
        </Notice>
      )}

      <Card title="Outcome">
        {editing ? (
          <Field
            label="What this plan delivers"
            value={plan.outcome}
            maxLength={500}
            onChange={(e) => edit((p) => ({ ...p, outcome: e.target.value }))}
          />
        ) : (
          <p className="text-sm">
            {plan.outcome || <span className="text-muted-foreground">Not set</span>}
          </p>
        )}
        <h3 className="mt-5 mb-2 text-sm font-semibold">Success measures</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {plan.measures.map((m, i) => (
            <li key={m.id} className="rounded-[10px] bg-background px-3 py-2 text-sm">
              <span className="mr-2 font-semibold">{m.id}</span>
              {editing ? (
                <input
                  className="w-[80%] bg-transparent outline-none"
                  value={m.label}
                  placeholder="Measure"
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

      {plan.phases.map((phase, pi) => (
        <Card key={phase.id}>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="font-title text-lg">
              {pi + 1}. {phase.name}
            </h3>
            <span className="text-xs text-muted-foreground">
              {phase.milestones.filter((m) => m.done).length}/{phase.milestones.length} done
            </span>
          </div>
          {editing ? (
            <Field
              label="Goal"
              value={phase.goal}
              maxLength={500}
              onChange={(e) => edit((p) => ((p.phases[pi]!.goal = e.target.value), p))}
            />
          ) : (
            phase.goal && <p className="mb-3 text-sm text-muted-foreground">{phase.goal}</p>
          )}
          <ul className="mt-3 space-y-2">
            {phase.milestones.map((m, mi) => (
              <li key={m.id} className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={m.done}
                  disabled={!canEdit}
                  aria-label={`Milestone "${m.title}" done`}
                  onChange={() => {
                    const next = structuredClone(plan);
                    next.phases[pi]!.milestones[mi]!.done = !m.done;
                    if (editing) setDraft(next);
                    else void save(next);
                  }}
                />
                <span className={m.done ? 'text-muted-foreground line-through' : ''}>
                  {m.title}
                </span>
                <span className="ml-auto flex gap-1">
                  {MEASURES.map((id) =>
                    editing ? (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={m.measures.includes(id)}
                        className={`rounded-md px-1.5 text-xs ${m.measures.includes(id) ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}
                        onClick={() =>
                          edit((p) => {
                            const ms = p.phases[pi]!.milestones[mi]!.measures;
                            p.phases[pi]!.milestones[mi]!.measures = ms.includes(id)
                              ? ms.filter((x) => x !== id)
                              : [...ms, id];
                            return p;
                          })
                        }
                      >
                        {id}
                      </button>
                    ) : (
                      m.measures.includes(id) && (
                        <span
                          key={id}
                          className="rounded-md bg-secondary px-1.5 text-xs font-semibold"
                        >
                          {id}
                        </span>
                      )
                    ),
                  )}
                  {editing && (
                    <button
                      type="button"
                      className="ml-2 text-xs text-destructive"
                      onClick={() => edit((p) => (p.phases[pi]!.milestones.splice(mi, 1), p))}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {editing && (
            <AddMilestone
              onAdd={(title) =>
                edit(
                  (p) => (
                    p.phases[pi]!.milestones.push({ id: uid(), title, done: false, measures: [] }),
                    p
                  ),
                )
              }
            />
          )}
        </Card>
      ))}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          {editing ? (
            <>
              <select
                className="h-10 rounded-md border border-input bg-white px-2 text-sm"
                defaultValue=""
                aria-label="Add a phase"
                onChange={(e) => {
                  const name = e.target.value;
                  if (name)
                    edit((p) => (p.phases.push({ id: uid(), name, goal: '', milestones: [] }), p));
                  e.target.value = '';
                }}
              >
                <option value="">Add a phase…</option>
                {data.phaseLibrary.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
              <Button variant="cta" onClick={() => void save(plan)}>
                Save plan
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button onClick={() => setDraft(structuredClone(data.plan))}>
              {data.exists ? 'Edit plan' : 'Start a new plan'}
            </Button>
          )}
        </div>
      )}
      {saved && <Notice tone="success">Plan saved.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
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
        className="h-9 flex-1 rounded-md border border-input bg-white px-3 text-sm shadow-xs"
        placeholder="New milestone"
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
