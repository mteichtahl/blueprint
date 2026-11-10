import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Artists, plans and to-dos (design 7.1 "Artists & plans", "Work"; screens:
 * artist workspace Plan and To-do tabs). Pure: keys, schemas and rules.
 */

// ── Keys in the main table ────────────────────────────────────────────────
export const artistPk = (artistId: string) => `ARTIST#${artistId}`;
export const PROFILE_SK = 'PROFILE';
export const PLAN_SK = 'PLAN';
export const todoSk = (todoId: string) => `TODO#${todoId}`;
/** GSI1: the roster, sorted by name. */
export const ROSTER_GSI1PK = 'ARTISTS';
/** GSI2: every artist to-do by due date, for BMG's "All artist to-dos". */
export const TODOS_GSI2PK = 'TODOS';
export const todoGsi2Sk = (due: string | undefined, artistId: string, todoId: string) =>
  `${due ?? '9999-12-31'}#${artistId}#${todoId}`;

/** Sortable, unique ids: time first so lists come back in creation order. */
export function newId(now = Date.now()): string {
  return `${now.toString(36).padStart(9, '0')}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

// ── Plan ──────────────────────────────────────────────────────────────────
export const MEASURE_IDS = ['M1', 'M2', 'M3', 'M4'] as const;

const Milestone = z.object({
  id: z.string().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  done: z.boolean().default(false),
  measures: z.array(z.enum(MEASURE_IDS)).max(4).default([]),
});

/** Plan text is Markdown, written in the editor (outcome and each stage's goal). */
export const OUTCOME_MAX = 2000;
export const GOAL_MAX = 4000;

const Phase = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().max(GOAL_MAX).default(''),
  milestones: z.array(Milestone).max(30).default([]),
  /** Set when the stage came from a custom stage in the library. */
  stageId: z.string().max(40).optional(),
});

export const PlanBody = z.object({
  outcome: z.string().trim().max(OUTCOME_MAX),
  measures: z
    .array(z.object({ id: z.enum(MEASURE_IDS), label: z.string().trim().max(200) }))
    .max(4),
  phases: z.array(Phase).min(1).max(12),
  /** Optimistic concurrency: the version the editor started from (0 for a new plan). */
  version: z.number().int().min(0),
});
export type Plan = Omit<z.infer<typeof PlanBody>, 'version'> & {
  version: number;
  updatedAt: string;
};

/** Phase library from the plan templates screen. */
export const PHASE_LIBRARY = [
  'Discovery',
  'Brand',
  'Release',
  'Live',
  'Content & community',
  'Partnerships',
  'Distribution',
  'Handover',
] as const;

// ── Custom stages ─────────────────────────────────────────────────────────
/**
 * BMG's own stages, on top of the built-in phase library. Each one applies to
 * every artist or to named artists, and is offered when editing their plans.
 */
export const STAGES_PK = 'ORG#plan-stages';
export const stageSk = (stageId: string) => `STAGE#${stageId}`;
export const STAGE_ID_PATTERN = /^[a-z0-9]{10,40}$/;
const ArtistIdList = z.array(z.string().regex(/^art_[a-z0-9]{10,32}$/)).max(200);

export const StageBody = z
  .object({
    name: z.string().trim().min(1, 'Give the stage a name').max(80),
    goal: z.string().trim().max(GOAL_MAX).default(''),
    /** Milestone titles a plan starts with when the stage is added. */
    milestones: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    appliesTo: z.enum(['all', 'selected']).default('all'),
    artistIds: ArtistIdList.default([]),
  })
  .refine(
    (v) => v.appliesTo === 'all' || v.artistIds.length > 0,
    'Pick at least one artist, or apply the stage to all artists',
  );
export type StageInput = z.infer<typeof StageBody>;

export interface Stage extends StageInput {
  stageId: string;
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

export const ApplyStageBody = z.object({ artistIds: ArtistIdList.min(1, 'Pick an artist') });

export function stageAppliesTo(stage: Pick<Stage, 'appliesTo' | 'artistIds'>, artistId: string) {
  return stage.appliesTo === 'all' || stage.artistIds.includes(artistId);
}

/** A plan phase made from a stage (built-in or custom), with fresh milestone ids. */
export function phaseFromStage(
  stage: { name: string; goal?: string; milestones?: string[]; stageId?: string },
  id: () => string,
) {
  return {
    id: id(),
    name: stage.name,
    goal: stage.goal ?? '',
    milestones: (stage.milestones ?? []).map((title) => ({
      id: id(),
      title,
      done: false,
      measures: [] as (typeof MEASURE_IDS)[number][],
    })),
    ...(stage.stageId ? { stageId: stage.stageId } : {}),
  };
}

/** "Start a new plan": the generic template with an outcome prompt. */
export function templatePlan(): Plan {
  return {
    outcome: '',
    measures: MEASURE_IDS.map((id) => ({ id, label: '' })),
    phases: ['Discovery', 'Brand', 'Release', 'Live', 'Handover'].map((name, i) => ({
      id: `p${i + 1}`,
      name,
      goal: '',
      milestones: [],
    })),
    version: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * Alignment check: flags gaps between the plan and its measures, so a plan
 * can't quietly drift from its stated outcome.
 */
export function alignmentGaps(plan: Pick<Plan, 'outcome' | 'measures' | 'phases'>): string[] {
  const gaps: string[] = [];
  if (!plan.outcome.trim()) gaps.push('The plan has no outcome statement.');
  const defined = plan.measures.filter((m) => m.label.trim()).map((m) => m.id);
  if (defined.length === 0) gaps.push('No success measures are defined.');
  const fed = new Set(plan.phases.flatMap((p) => p.milestones.flatMap((m) => m.measures)));
  for (const id of defined) {
    if (!fed.has(id)) gaps.push(`No milestone feeds ${id}.`);
  }
  for (const p of plan.phases) {
    if (p.milestones.length === 0) gaps.push(`Phase "${p.name}" has no milestones.`);
  }
  return gaps;
}

// ── To-dos ────────────────────────────────────────────────────────────────
export const TODO_SOURCES = ['bmg', 'feedback', 'artist'] as const;

/** Reminder before the due time, from the to-do editor. */
export const REMINDERS = ['60m', '1d', '3d', '7d'] as const;
export type Reminder = (typeof REMINDERS)[number];
const REMINDER_MS: Record<Reminder, number> = {
  '60m': 60 * 60_000,
  '1d': 24 * 3600_000,
  '3d': 3 * 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
};
/** Due times are Blueprint's local time; a to-do without one is due at 9am. */
export const TODO_TIME_ZONE = 'Australia/Melbourne';
export const DEFAULT_DUE_TIME = '09:00';
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 14:30');

export const TodoCreate = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  due: z.iso.date().optional(),
  dueTime: Time.optional(),
  reminder: z.enum(REMINDERS).optional(),
  phaseId: z.string().max(40).optional(),
  /** BMG-only to-dos are hidden from the artist (design 6.3). Artists can't set it. */
  bmgOnly: z.boolean().optional(),
});

export const TodoPatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
    due: z.iso.date().nullable().optional(),
    dueTime: Time.nullable().optional(),
    reminder: z.enum(REMINDERS).nullable().optional(),
    done: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export interface Todo {
  todoId: string;
  artistId: string;
  title: string;
  notes?: string;
  due?: string;
  /** 'HH:MM' in TODO_TIME_ZONE. */
  dueTime?: string;
  reminder?: Reminder;
  /** When the reminder fires (UTC ISO); a scheduled one-off sends it. */
  remindAt?: string;
  /** The reminder couldn't be scheduled; saving the to-do again retries it. */
  reminderFailed?: boolean;
  phaseId?: string;
  /** Set on to-dos made from review feedback (design F3). */
  submissionId?: string;
  done: boolean;
  source: (typeof TODO_SOURCES)[number];
  visibility: 'normal' | 'bmg-only';
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** Offset of `timeZone` from UTC at `instant`, in ms (positive east of UTC). */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-AU', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant;
}

/** A wall-clock date and time in `timeZone` as a UTC instant (handles daylight saving). */
export function zonedTimeToUtc(date: string, time: string, timeZone = TODO_TIME_ZONE): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let instant = wall - zoneOffset(wall, timeZone);
  // Re-check once: the offset can differ either side of a daylight-saving change.
  instant = wall - zoneOffset(instant, timeZone);
  return new Date(instant);
}

/** When the reminder should fire, or undefined if there's no due date or reminder. */
export function reminderAt(t: Pick<Todo, 'due' | 'dueTime' | 'reminder'>): Date | undefined {
  if (!t.due || !t.reminder) return undefined;
  const due = zonedTimeToUtc(t.due, t.dueTime ?? DEFAULT_DUE_TIME);
  return new Date(due.getTime() - REMINDER_MS[t.reminder]);
}

/** The fields a PATCH actually changed (for the "to-do changed" notification). */
export function changedFields(before: Todo, after: Todo): string[] {
  const keys = ['title', 'notes', 'due', 'dueTime', 'reminder', 'done'] as const;
  return keys.filter((k) => (before[k] ?? null) !== (after[k] ?? null));
}

/**
 * Who hears about an edit: the person the to-do is allocated to. To-dos are
 * allocated to the artist, so BMG edits tell the artist; an artist editing a
 * to-do Blueprint gave them tells Blueprint. BMG-only to-dos never reach the artist.
 */
export function notifyOnEdit(
  role: 'artist' | 'bmg-admin' | 'bmg-staff',
  todo: Pick<Todo, 'source' | 'visibility'>,
): 'artist' | 'bmg' | undefined {
  if (role === 'artist') return todo.source === 'artist' ? undefined : 'bmg';
  return todo.visibility === 'bmg-only' ? undefined : 'artist';
}

/** One schedule per to-do; names are limited to 64 characters. */
export const reminderScheduleName = (artistId: string, todoId: string) =>
  `todo-${artistId}-${todoId}`.slice(0, 64);

export const TODO_FILTERS = [
  'overdue',
  'due-this-week',
  'from-bmg',
  'from-feedback',
  'own',
  'done',
] as const;
export type TodoFilter = (typeof TODO_FILTERS)[number];

/** Quick filters from the "All artist to-dos" section (screens doc). */
export function matchesFilter(todo: Todo, filter: TodoFilter | undefined, today: string): boolean {
  if (!filter) return !todo.done;
  switch (filter) {
    case 'done':
      return todo.done;
    case 'overdue':
      return !todo.done && !!todo.due && todo.due < today;
    case 'due-this-week': {
      if (todo.done || !todo.due) return false;
      const end = new Date(`${today}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 7);
      return todo.due >= today && todo.due <= end.toISOString().slice(0, 10);
    }
    case 'from-bmg':
      return !todo.done && todo.source === 'bmg';
    case 'from-feedback':
      return !todo.done && todo.source === 'feedback';
    case 'own':
      return !todo.done && todo.source === 'artist';
  }
}
