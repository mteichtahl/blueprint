import type { Plan } from './model.ts';

/**
 * Plan change history (rev 8): every save of a plan writes one entry next to
 * the plan, saying who changed it, when, and what changed in plain words.
 * Artists and Blueprint can both read it; it is included in the plan PDF.
 */

export const PLAN_LOG_PREFIX = 'PLANLOG#';
export const planLogSk = (at: string, changeId: string) => `${PLAN_LOG_PREFIX}${at}#${changeId}`;

/** Most changes in a single entry; the rest are counted. */
export const MAX_CHANGE_LINES = 40;

export type PlanChangeKind = 'created' | 'edited' | 'stage-added';

export interface PlanChange {
  changeId: string;
  artistId: string;
  /** The plan version this change produced. */
  version: number;
  at: string;
  kind: PlanChangeKind;
  bySub: string;
  byRole: 'artist' | 'bmg-admin' | 'bmg-staff';
  /** "Blueprint", or "Blueprint · <job title>" when the person has one. */
  byName: string;
  changes: string[];
}

export const publicChange = (c: PlanChange) => ({
  changeId: c.changeId,
  version: c.version,
  at: c.at,
  kind: c.kind,
  byName: c.byName,
  changes: c.changes,
});

/** Who made a change, as shown in the history. Staff have no names in the app, only job titles. */
export function changedBy(jobTitle: unknown): string {
  const title = typeof jobTitle === 'string' ? jobTitle.trim() : '';
  return title ? `Blueprint · ${title}` : 'Blueprint';
}

type PlanContent = Pick<Plan, 'outcome' | 'measures' | 'phases'>;
type Phase = Plan['phases'][number];
type Milestone = Phase['milestones'][number];

const q = (s: string) => `“${s}”`;

/** "7 Dec 2026" for a plan date (date only, so no time zone shift). */
export function planDay(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const sameOrder = (a: string[], b: string[]) => {
  const common = new Set(a.filter((id) => b.includes(id)));
  const x = a.filter((id) => common.has(id));
  const y = b.filter((id) => common.has(id));
  return x.every((id, i) => id === y[i]);
};

function stageDates(p: Pick<Phase, 'start' | 'end'>): string {
  if (p.start && p.end) return `${planDay(p.start)} – ${planDay(p.end)}`;
  if (p.start) return `from ${planDay(p.start)}`;
  if (p.end) return `until ${planDay(p.end)}`;
  return '';
}

function milestoneChanges(stage: string, a: Milestone, b: Milestone): string[] {
  const out: string[] = [];
  if (a.title !== b.title)
    out.push(`Renamed milestone ${q(a.title)} to ${q(b.title)} in ${q(stage)}`);
  if (a.done !== b.done) out.push(b.done ? `Marked ${q(b.title)} done` : `Reopened ${q(b.title)}`);
  if ((a.due ?? '') !== (b.due ?? '')) {
    out.push(
      b.due ? `Set ${q(b.title)} due ${planDay(b.due)}` : `Cleared the due date of ${q(b.title)}`,
    );
  }
  const am = [...a.measures].sort().join(', ');
  const bm = [...b.measures].sort().join(', ');
  if (am !== bm) {
    out.push(
      bm ? `Linked ${q(b.title)} to ${bm}` : `Unlinked ${q(b.title)} from the success measures`,
    );
  }
  return out;
}

/**
 * What changed between two versions of a plan, in plain words, in plan
 * order. `before` is undefined when the plan is new.
 */
export function planChanges(before: PlanContent | undefined, after: PlanContent): string[] {
  if (!before) {
    const stages = after.phases.length;
    return [`Started the plan with ${stages} stage${stages === 1 ? '' : 's'}`];
  }
  const out: string[] = [];

  if (before.outcome.trim() !== after.outcome.trim()) {
    out.push(after.outcome.trim() ? 'Changed the outcome' : 'Cleared the outcome');
  }

  for (const id of ['M1', 'M2', 'M3', 'M4'] as const) {
    const a = before.measures.find((m) => m.id === id)?.label.trim() ?? '';
    const b = after.measures.find((m) => m.id === id)?.label.trim() ?? '';
    if (a === b) continue;
    if (!a) out.push(`Added success measure ${id}: ${q(b)}`);
    else if (!b) out.push(`Removed success measure ${id} (${q(a)})`);
    else out.push(`Changed success measure ${id} to ${q(b)}`);
  }

  const beforeStages = new Map(before.phases.map((p) => [p.id, p]));
  const afterStages = new Map(after.phases.map((p) => [p.id, p]));
  // Where each milestone lives, so a move between stages reads as a move.
  const stageOf = (plan: PlanContent) =>
    new Map(plan.phases.flatMap((p) => p.milestones.map((m) => [m.id, { p, m }] as const)));
  const beforeMs = stageOf(before);
  const afterMs = stageOf(after);

  for (const p of before.phases) {
    if (!afterStages.has(p.id)) out.push(`Removed stage ${q(p.name)}`);
  }
  if (
    !sameOrder(
      before.phases.map((p) => p.id),
      after.phases.map((p) => p.id),
    )
  ) {
    out.push('Reordered the stages');
  }

  for (const p of after.phases) {
    const was = beforeStages.get(p.id);
    if (!was) {
      const dates = stageDates(p);
      out.push(`Added stage ${q(p.name)}${dates ? ` (${dates})` : ''}`);
    } else {
      if (was.name !== p.name) out.push(`Renamed stage ${q(was.name)} to ${q(p.name)}`);
      if (was.goal.trim() !== p.goal.trim()) out.push(`Changed the goal of ${q(p.name)}`);
      if ((was.start ?? '') !== (p.start ?? '') || (was.end ?? '') !== (p.end ?? '')) {
        const dates = stageDates(p);
        out.push(
          dates ? `Set the dates of ${q(p.name)} to ${dates}` : `Cleared the dates of ${q(p.name)}`,
        );
      }
      // Milestones that left this stage, other than moves (reported where they land).
      for (const m of was.milestones) {
        if (!afterMs.has(m.id)) out.push(`Removed milestone ${q(m.title)} from ${q(p.name)}`);
      }
      if (
        !sameOrder(
          was.milestones.map((m) => m.id),
          p.milestones.map((m) => m.id),
        )
      ) {
        out.push(`Reordered the milestones in ${q(p.name)}`);
      }
    }
    for (const m of p.milestones) {
      const prev = beforeMs.get(m.id);
      if (!prev) {
        out.push(
          `Added milestone ${q(m.title)} to ${q(p.name)}${m.due ? ` (due ${planDay(m.due)})` : ''}`,
        );
        continue;
      }
      if (prev.p.id !== p.id) {
        out.push(`Moved milestone ${q(m.title)} from ${q(prev.p.name)} to ${q(p.name)}`);
      }
      out.push(...milestoneChanges(p.name, prev.m, m));
    }
  }

  // Milestones in stages that were removed go with the stage, so they aren't listed one by one.
  if (out.length > MAX_CHANGE_LINES) {
    const rest = out.length - (MAX_CHANGE_LINES - 1);
    return [...out.slice(0, MAX_CHANGE_LINES - 1), `…and ${rest} more changes`];
  }
  return out;
}
