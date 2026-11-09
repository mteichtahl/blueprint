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

const Phase = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().max(500).default(''),
  milestones: z.array(Milestone).max(30).default([]),
});

export const PlanBody = z.object({
  outcome: z.string().trim().max(500),
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

export const TodoCreate = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  due: z.iso.date().optional(),
  phaseId: z.string().max(40).optional(),
  /** BMG-only to-dos are hidden from the artist (design 6.3). Artists can't set it. */
  bmgOnly: z.boolean().optional(),
});

export const TodoPatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
    due: z.iso.date().nullable().optional(),
    done: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export interface Todo {
  todoId: string;
  artistId: string;
  title: string;
  notes?: string;
  due?: string;
  phaseId?: string;
  /** Set on to-dos made from review feedback (design F3). */
  submissionId?: string;
  done: boolean;
  source: (typeof TODO_SOURCES)[number];
  visibility: 'normal' | 'bmg-only';
  createdBy: string;
  createdAt: string;
}

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
