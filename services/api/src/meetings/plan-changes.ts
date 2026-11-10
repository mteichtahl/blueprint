import { z } from 'zod';
import { GOAL_MAX, OUTCOME_MAX, PlanBody, type Plan } from '../workspace/model.ts';
import { planDay } from '../workspace/plan-history.ts';

/**
 * Suggested plan changes from a meeting (rev 11, spec 6). Pure and
 * unit-tested.
 *
 * The model proposes changes as a typed list. Nothing it says is trusted:
 * each change must point at a stage or milestone that really exists, the
 * "before" is always read from the plan itself, no-ops are dropped, and the
 * result must still be a valid plan. Only changes Blueprint could make by
 * hand in the plan editor are possible (spec 6.2). Nothing reaches the plan
 * until a person accepts it and presses Update plan.
 */

const Id = z.string().min(1).max(40);
const Day = z.iso.date();
const Ref = z.number().int().min(0).max(100_000);
const Common = {
  /** One line on why, in plain words. */
  reason: z.string().trim().min(1).max(400),
  /** Transcript line numbers it's based on. */
  refs: z.array(Ref).max(10).default([]),
};
const MilestoneIn = z.object({
  title: z.string().trim().min(1).max(200),
  due: Day.optional(),
});

/** What the model may propose (its reply is parsed with this). */
export const ProposedChange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('outcome.edit'),
    after: z.string().trim().min(1).max(OUTCOME_MAX),
    ...Common,
  }),
  z.object({
    kind: z.literal('measure.edit'),
    measureId: z.enum(['M1', 'M2', 'M3', 'M4']),
    after: z.string().trim().max(200),
    ...Common,
  }),
  z.object({
    kind: z.literal('stage.add'),
    /** A name the model uses to put new milestones into this new stage. */
    key: z.string().trim().max(40).optional(),
    name: z.string().trim().min(1).max(80),
    goal: z.string().trim().max(GOAL_MAX).default(''),
    start: Day.optional(),
    end: Day.optional(),
    /** Put it after this stage; first if not given. */
    afterPhaseId: Id.optional(),
    ...Common,
  }),
  z.object({
    kind: z.literal('stage.rename'),
    phaseId: Id,
    after: z.string().trim().min(1).max(80),
    ...Common,
  }),
  z.object({
    kind: z.literal('stage.goal'),
    phaseId: Id,
    after: z.string().trim().max(GOAL_MAX),
    ...Common,
  }),
  z.object({
    kind: z.literal('stage.dates'),
    phaseId: Id,
    start: Day.nullable().optional(),
    end: Day.nullable().optional(),
    ...Common,
  }),
  z.object({ kind: z.literal('stage.remove'), phaseId: Id, ...Common }),
  z.object({
    kind: z.literal('milestone.add'),
    /** An existing stage, or the `key` of a stage.add in the same reply. */
    phaseId: Id,
    ...MilestoneIn.shape,
    ...Common,
  }),
  z.object({
    kind: z.literal('milestone.rename'),
    phaseId: Id,
    milestoneId: Id,
    after: z.string().trim().min(1).max(200),
    ...Common,
  }),
  z.object({
    kind: z.literal('milestone.due'),
    phaseId: Id,
    milestoneId: Id,
    due: Day.nullable(),
    ...Common,
  }),
  z.object({
    kind: z.literal('milestone.done'),
    phaseId: Id,
    milestoneId: Id,
    done: z.boolean(),
    ...Common,
  }),
  z.object({
    kind: z.literal('milestone.move'),
    phaseId: Id,
    milestoneId: Id,
    toPhaseId: Id,
    ...Common,
  }),
  z.object({ kind: z.literal('milestone.remove'), phaseId: Id, milestoneId: Id, ...Common }),
]);
export type ProposedChange = z.infer<typeof ProposedChange>;

export const PlanReply = z.object({ changes: z.array(z.unknown()).max(40) });

/** The reply shape code appends to the (editable) prompt. */
export const PLAN_REPLY_SHAPE = `Reply with JSON only, no other text:
{"changes": [ ... ]}
Each change is one of these (ids come from the plan; "refs" are the transcript line numbers it's based on; "reason" is one short sentence):
{"kind":"outcome.edit","after":"<new outcome>","reason":"…","refs":[…]}
{"kind":"measure.edit","measureId":"M1|M2|M3|M4","after":"<new wording>","reason":"…","refs":[…]}
{"kind":"stage.add","key":"<short name to refer to it>","name":"…","goal":"…","start":"YYYY-MM-DD","end":"YYYY-MM-DD","afterPhaseId":"<id>","reason":"…","refs":[…]}
{"kind":"stage.rename","phaseId":"<id>","after":"…","reason":"…","refs":[…]}
{"kind":"stage.goal","phaseId":"<id>","after":"<new goal>","reason":"…","refs":[…]}
{"kind":"stage.dates","phaseId":"<id>","start":"YYYY-MM-DD","end":"YYYY-MM-DD","reason":"…","refs":[…]}
{"kind":"stage.remove","phaseId":"<id>","reason":"…","refs":[…]}
{"kind":"milestone.add","phaseId":"<id, or the key of a new stage>","title":"…","due":"YYYY-MM-DD","reason":"…","refs":[…]}
{"kind":"milestone.rename","phaseId":"<id>","milestoneId":"<id>","after":"…","reason":"…","refs":[…]}
{"kind":"milestone.due","phaseId":"<id>","milestoneId":"<id>","due":"YYYY-MM-DD","reason":"…","refs":[…]}
{"kind":"milestone.done","phaseId":"<id>","milestoneId":"<id>","done":true,"reason":"…","refs":[…]}
{"kind":"milestone.move","phaseId":"<id>","milestoneId":"<id>","toPhaseId":"<id>","reason":"…","refs":[…]}
{"kind":"milestone.remove","phaseId":"<id>","milestoneId":"<id>","reason":"…","refs":[…]}
Leave out optional fields you don't need. Reply {"changes": []} if nothing changes.`;

/** The plan as the model sees it: ids, names, dates, milestones. */
export function planForPrompt(plan: Pick<Plan, 'outcome' | 'measures' | 'phases'>): string {
  return JSON.stringify(
    {
      outcome: plan.outcome,
      measures: plan.measures.filter((m) => m.label.trim()),
      stages: plan.phases.map((p) => ({
        id: p.id,
        name: p.name,
        goal: p.goal,
        ...(p.start ? { start: p.start } : {}),
        ...(p.end ? { end: p.end } : {}),
        milestones: p.milestones.map((m) => ({
          id: m.id,
          title: m.title,
          done: m.done,
          ...(m.due ? { due: m.due } : {}),
        })),
      })),
    },
    null,
    1,
  );
}

// ── Suggestions as stored and reviewed ────────────────────────────────────
export const SUGGESTION_STATUSES = ['waiting', 'accepted', 'rejected'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export interface Suggestion {
  id: string;
  /** The change as it will be applied (edited by staff, or as proposed). */
  change: ProposedChange;
  /** Where it lands, in words: "Album release", "Album release › First headline show". */
  where: string;
  /** What it says now and what it would say, for the before → after view. */
  before: string;
  after: string;
  /** Removals, and date moves of more than four weeks. */
  checkThis: boolean;
  /** A new milestone in a new stage depends on that stage. */
  dependsOn?: string;
  status: SuggestionStatus;
  edited?: boolean;
  /** The plan changed since: this one no longer fits and needs another look. */
  stale?: boolean;
}

export interface SuggestionSet {
  setId: string;
  createdAt: string;
  createdBy: string;
  /** The plan version the suggestions were made against. */
  basePlanVersion: number;
  suggestions: Suggestion[];
  /** Set once Update plan has run. */
  applied?: {
    at: string;
    by: string;
    planVersion: number;
    /** Undo is possible until then, if the plan hasn't changed since. */
    undoUntil: string;
    /** The plan as it was, for Undo. */
    before: Pick<Plan, 'outcome' | 'measures' | 'phases'>;
    changeCount: number;
    undoneAt?: string;
  };
  /** The model found nothing to change. */
  none?: boolean;
}

export const UNDO_DAYS = 7;
const BIG_MOVE_DAYS = 28;

const dayDiff = (a?: string | null, b?: string | null) =>
  a && b ? Math.abs(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000 : 0;
const day = (d?: string | null) => (d ? planDay(d) : 'no date');

type Phase = Plan['phases'][number];

/**
 * Checks each proposed change against the real plan and words it for review.
 * Changes that point at nothing, change nothing, or repeat an earlier one are
 * dropped. A new stage's `key` lets milestones be added to it.
 */
export function reviewChanges(
  plan: Pick<Plan, 'outcome' | 'measures' | 'phases'>,
  proposed: unknown[],
): Suggestion[] {
  const out: Suggestion[] = [];
  const stageKeys = new Map<string, string>(); // key → suggestion id
  const seen = new Set<string>();
  const phase = (id: string) => plan.phases.find((p) => p.id === id);
  const milestone = (p: Phase | undefined, id: string) => p?.milestones.find((m) => m.id === id);
  let n = 0;
  const push = (s: Omit<Suggestion, 'id' | 'status'>) => {
    const sig = JSON.stringify({ ...s.change, reason: undefined, refs: undefined });
    if (seen.has(sig)) return;
    seen.add(sig);
    out.push({ ...s, id: `c${++n}`, status: 'waiting' });
  };
  for (const raw of proposed) {
    const parsed = ProposedChange.safeParse(raw);
    if (!parsed.success) continue;
    const c = parsed.data;
    switch (c.kind) {
      case 'outcome.edit':
        if (c.after === plan.outcome.trim()) break;
        push({
          change: c,
          where: 'Outcome',
          before: plan.outcome,
          after: c.after,
          checkThis: false,
        });
        break;
      case 'measure.edit': {
        const m = plan.measures.find((x) => x.id === c.measureId);
        if (!m || m.label === c.after) break;
        push({
          change: c,
          where: `Success measure ${c.measureId}`,
          before: m.label,
          after: c.after,
          checkThis: false,
        });
        break;
      }
      case 'stage.add': {
        if (plan.phases.some((p) => p.name.toLowerCase() === c.name.toLowerCase())) break;
        if (c.afterPhaseId && !phase(c.afterPhaseId)) break;
        if (c.start && c.end && c.end < c.start) break;
        push({ change: c, where: 'Stages', before: '', after: c.name, checkThis: false });
        if (c.key) stageKeys.set(c.key, `c${n}`);
        break;
      }
      case 'stage.rename': {
        const p = phase(c.phaseId);
        if (!p || p.name === c.after) break;
        push({ change: c, where: p.name, before: p.name, after: c.after, checkThis: false });
        break;
      }
      case 'stage.goal': {
        const p = phase(c.phaseId);
        if (!p || p.goal.trim() === c.after) break;
        push({
          change: c,
          where: `${p.name} › goal`,
          before: p.goal,
          after: c.after,
          checkThis: false,
        });
        break;
      }
      case 'stage.dates': {
        const p = phase(c.phaseId);
        if (!p) break;
        const start = c.start === undefined ? p.start : (c.start ?? undefined);
        const end = c.end === undefined ? p.end : (c.end ?? undefined);
        if (start === p.start && end === p.end) break;
        if (start && end && end < start) break;
        push({
          change: c,
          where: p.name,
          before: `${day(p.start)} – ${day(p.end)}`,
          after: `${day(start)} – ${day(end)}`,
          checkThis: dayDiff(p.start, start) > BIG_MOVE_DAYS || dayDiff(p.end, end) > BIG_MOVE_DAYS,
        });
        break;
      }
      case 'stage.remove': {
        const p = phase(c.phaseId);
        if (!p || plan.phases.length <= 1) break;
        push({ change: c, where: p.name, before: p.name, after: '', checkThis: true });
        break;
      }
      case 'milestone.add': {
        const p = phase(c.phaseId);
        const newStage = stageKeys.get(c.phaseId);
        if (!p && !newStage) break;
        if (p?.milestones.some((m) => m.title.toLowerCase() === c.title.toLowerCase())) break;
        const stageName = p
          ? p.name
          : String((out.find((s) => s.id === newStage)!.change as { name: string }).name);
        push({
          change: c,
          where: stageName,
          before: '',
          after: c.due ? `${c.title} (due ${day(c.due)})` : c.title,
          checkThis: false,
          ...(newStage ? { dependsOn: newStage } : {}),
        });
        break;
      }
      case 'milestone.rename': {
        const p = phase(c.phaseId);
        const m = milestone(p, c.milestoneId);
        if (!p || !m || m.title === c.after) break;
        push({
          change: c,
          where: `${p.name} › ${m.title}`,
          before: m.title,
          after: c.after,
          checkThis: false,
        });
        break;
      }
      case 'milestone.due': {
        const p = phase(c.phaseId);
        const m = milestone(p, c.milestoneId);
        if (!p || !m || (m.due ?? null) === c.due) break;
        push({
          change: c,
          where: `${p.name} › ${m.title}`,
          before: day(m.due),
          after: day(c.due),
          checkThis: dayDiff(m.due, c.due) > BIG_MOVE_DAYS,
        });
        break;
      }
      case 'milestone.done': {
        const p = phase(c.phaseId);
        const m = milestone(p, c.milestoneId);
        if (!p || !m || m.done === c.done) break;
        push({
          change: c,
          where: `${p.name} › ${m.title}`,
          before: m.done ? 'Done' : 'Not done',
          after: c.done ? 'Done' : 'Not done',
          checkThis: false,
        });
        break;
      }
      case 'milestone.move': {
        const p = phase(c.phaseId);
        const m = milestone(p, c.milestoneId);
        const to = phase(c.toPhaseId);
        if (!p || !m || !to || to.id === p.id) break;
        push({ change: c, where: m.title, before: p.name, after: to.name, checkThis: false });
        break;
      }
      case 'milestone.remove': {
        const p = phase(c.phaseId);
        const m = milestone(p, c.milestoneId);
        if (!p || !m) break;
        push({
          change: c,
          where: `${p.name} › ${m.title}`,
          before: m.title,
          after: '',
          checkThis: true,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Accept or reject one suggestion, keeping linked ones in step: accepting a
 * milestone in a new stage accepts the stage; rejecting the stage rejects its
 * milestones. Returns the ids that changed.
 */
export function setStatus(list: Suggestion[], id: string, status: SuggestionStatus): string[] {
  const changed = new Set<string>();
  const set = (s: Suggestion, to: SuggestionStatus) => {
    if (s.status !== to) {
      s.status = to;
      changed.add(s.id);
    }
  };
  const target = list.find((s) => s.id === id);
  if (!target) return [];
  set(target, status);
  if (status !== 'rejected' && target.dependsOn) {
    const parent = list.find((s) => s.id === target.dependsOn);
    if (parent && status === 'accepted') set(parent, 'accepted');
  }
  if (status !== 'accepted') {
    for (const child of list.filter((s) => s.dependsOn === id)) set(child, status);
  }
  if (status === 'accepted' || status === 'waiting') target.stale = false;
  return [...changed];
}

/** Ids for new stages and milestones (the plan editor uses short random ids too). */
export type NewId = () => string;

/**
 * Applies the accepted suggestions to the plan, in order. A suggestion whose
 * stage or milestone is no longer there (the plan changed since) is skipped
 * and returned as stale; everything else is applied. The result is checked
 * with the same rules as a save from the plan editor.
 */
export function applySuggestions(
  plan: Pick<Plan, 'outcome' | 'measures' | 'phases'>,
  suggestions: Suggestion[],
  newId: NewId,
): { next: Pick<Plan, 'outcome' | 'measures' | 'phases'>; applied: string[]; stale: string[] } {
  const next = structuredClone({
    outcome: plan.outcome,
    measures: plan.measures,
    phases: plan.phases,
  });
  const applied: string[] = [];
  const stale: string[] = [];
  const newStages = new Map<string, string>(); // stage.add key → phase id
  const phase = (id: string) =>
    next.phases.find((p) => p.id === id) ?? next.phases.find((p) => p.id === newStages.get(id));
  for (const s of suggestions.filter((x) => x.status === 'accepted')) {
    const c = s.change;
    let ok = true;
    switch (c.kind) {
      case 'outcome.edit':
        next.outcome = c.after;
        break;
      case 'measure.edit': {
        const m = next.measures.find((x) => x.id === c.measureId);
        if (m) m.label = c.after;
        else next.measures.push({ id: c.measureId, label: c.after });
        break;
      }
      case 'stage.add': {
        const id = newId();
        const at = c.afterPhaseId ? next.phases.findIndex((p) => p.id === c.afterPhaseId) : -1;
        if (c.afterPhaseId && at < 0) {
          ok = false;
          break;
        }
        next.phases.splice(at + 1, 0, {
          id,
          name: c.name,
          goal: c.goal,
          milestones: [],
          ...(c.start ? { start: c.start } : {}),
          ...(c.end ? { end: c.end } : {}),
        });
        if (c.key) newStages.set(c.key, id);
        break;
      }
      case 'stage.rename':
      case 'stage.goal':
      case 'stage.dates':
      case 'stage.remove': {
        const p = next.phases.find((x) => x.id === c.phaseId);
        if (!p) {
          ok = false;
          break;
        }
        if (c.kind === 'stage.rename') p.name = c.after;
        if (c.kind === 'stage.goal') p.goal = c.after;
        if (c.kind === 'stage.dates') {
          if (c.start !== undefined) {
            if (c.start) p.start = c.start;
            else delete p.start;
          }
          if (c.end !== undefined) {
            if (c.end) p.end = c.end;
            else delete p.end;
          }
        }
        if (c.kind === 'stage.remove') next.phases = next.phases.filter((x) => x.id !== c.phaseId);
        break;
      }
      case 'milestone.add': {
        const p = phase(c.phaseId);
        if (!p) {
          ok = false;
          break;
        }
        p.milestones.push({
          id: newId(),
          title: c.title,
          done: false,
          measures: [],
          ...(c.due ? { due: c.due } : {}),
        });
        break;
      }
      default: {
        const p = next.phases.find((x) => x.id === c.phaseId);
        const m = p?.milestones.find((x) => x.id === c.milestoneId);
        if (!p || !m) {
          ok = false;
          break;
        }
        if (c.kind === 'milestone.rename') m.title = c.after;
        if (c.kind === 'milestone.due') {
          if (c.due) m.due = c.due;
          else delete m.due;
        }
        if (c.kind === 'milestone.done') m.done = c.done;
        if (c.kind === 'milestone.remove') p.milestones = p.milestones.filter((x) => x !== m);
        if (c.kind === 'milestone.move') {
          const to = next.phases.find((x) => x.id === c.toPhaseId);
          if (!to) {
            ok = false;
            break;
          }
          p.milestones = p.milestones.filter((x) => x !== m);
          to.milestones.push(m);
        }
      }
    }
    (ok ? applied : stale).push(s.id);
  }
  return { next, applied, stale };
}

/** The plan must still be one the editor would save (limits, dates, at least one stage). */
export function planProblem(
  plan: Pick<Plan, 'outcome' | 'measures' | 'phases'>,
): string | undefined {
  const r = PlanBody.safeParse({ ...plan, version: 0 });
  return r.success ? undefined : r.error.issues[0]?.message;
}
