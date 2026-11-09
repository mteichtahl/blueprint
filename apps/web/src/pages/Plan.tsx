import { useCallback, useEffect, useState } from 'react';
import { api, type MeasureId, type Plan, type PlanResponse } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { phaseProgress } from '../lib/plan.ts';
import { Bar, Button, Card, Field, Notice, Tag } from '../components/ui.tsx';

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
    <div className="flex flex-col gap-4">
      {!data.exists && !editing && (
        <Notice>
          {canEdit
            ? 'No plan yet. Start from the template below.'
            : 'Blueprint hasn’t published your plan yet.'}
        </Notice>
      )}
      {data.gaps.length > 0 && !editing && (data.exists || canEdit) && (
        <section className="card gap-2 border-[#E8A9A6]">
          <div className="card-hd">
            <span className="eyebrow">Alignment check</span>
            <Tag tone="c">
              {data.gaps.length} gap{data.gaps.length === 1 ? '' : 's'}
            </Tag>
          </div>
          <ul className="m-0 flex flex-col gap-1 pl-[18px] text-[15px]">
            {data.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      )}

      <Card title={<span className="eyebrow">Outcome and success measures</span>}>
        {editing ? (
          <Field
            label="What this plan delivers"
            value={plan.outcome}
            maxLength={500}
            onChange={(e) => edit((p) => ({ ...p, outcome: e.target.value }))}
          />
        ) : (
          <h2 className="t m-0 text-[22px] leading-snug">
            {plan.outcome || <span className="font-normal text-muted-foreground">Not set</span>}
          </h2>
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

      {plan.phases.map((phase, pi) => {
        const prog = phaseProgress(plan)[pi]!;
        return (
          <Card key={phase.id}>
            <div className="flex items-center gap-3">
              <h3 className="t m-0 flex-1 text-xl">
                {pi + 1}. {phase.name}
              </h3>
              <Tag tone={prog.status === 'done' ? 'n' : prog.status === 'now' ? 'c' : 's'}>
                {prog.status === 'done' ? 'Done' : prog.status === 'now' ? 'Now' : 'Next'}
              </Tag>
              <span className="src">
                {prog.done}/{prog.total} done
              </span>
            </div>
            <Bar
              pct={prog.pct}
              color={
                prog.status === 'done' ? '#011935' : prog.status === 'now' ? '#D9534F' : '#5C6775'
              }
            />
            {editing ? (
              <Field
                label="Goal"
                value={phase.goal}
                maxLength={500}
                onChange={(e) => edit((p) => ((p.phases[pi]!.goal = e.target.value), p))}
              />
            ) : (
              phase.goal && (
                <p className="m-0 text-[15px]">
                  <span className="eyebrow mr-2 text-muted-foreground">Goal</span>
                  {phase.goal}
                </p>
              )
            )}
            <ul className="m-0 flex list-none flex-col p-0">
              {phase.milestones.map((m, mi) => (
                <li key={m.id} className="li text-[15px]">
                  <input
                    type="checkbox"
                    className="chk"
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
                          className={`tag ${m.measures.includes(id) ? 'tn' : 'ts'}`}
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
                      p.phases[pi]!.milestones.push({
                        id: uid(),
                        title,
                        done: false,
                        measures: [],
                      }),
                      p
                    ),
                  )
                }
              />
            )}
          </Card>
        );
      })}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          {editing ? (
            <>
              <select
                className="dd"
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
        className="min-h-[38px] flex-1 rounded-lg border border-input bg-white px-3 text-base shadow-xs"
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
