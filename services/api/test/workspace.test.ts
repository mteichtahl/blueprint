import { describe, expect, it } from 'vitest';
import {
  alignmentGaps,
  changedFields,
  CommentCreate,
  publicComment,
  threadOf,
  todoCommentPrefix,
  type TodoComment,
  matchesFilter,
  newId,
  notifyOnEdit,
  phaseFromStage,
  PlanBody,
  planSpan,
  reminderAt,
  reminderScheduleName,
  stageAppliesTo,
  StageBody,
  templatePlan,
  TodoCreate,
  TodoPatch,
  zonedTimeToUtc,
  type Todo,
} from '../src/workspace/model.ts';

const base: Todo = {
  todoId: 'x',
  artistId: 'art_aaaaaaaaaaaa',
  title: 'Book rehearsal',
  done: false,
  source: 'bmg',
  visibility: 'normal',
  createdBy: 'u',
  createdAt: '2026-11-01T00:00:00Z',
};

describe('to-do quick filters', () => {
  const today = '2026-11-09';
  it('shows open to-dos by default and done ones only under "done"', () => {
    expect(matchesFilter(base, undefined, today)).toBe(true);
    expect(matchesFilter({ ...base, done: true }, undefined, today)).toBe(false);
    expect(matchesFilter({ ...base, done: true }, 'done', today)).toBe(true);
  });
  it('knows overdue and due this week', () => {
    expect(matchesFilter({ ...base, due: '2026-11-08' }, 'overdue', today)).toBe(true);
    expect(matchesFilter({ ...base, due: '2026-11-09' }, 'overdue', today)).toBe(false);
    expect(matchesFilter({ ...base, due: '2026-11-16' }, 'due-this-week', today)).toBe(true);
    expect(matchesFilter({ ...base, due: '2026-11-17' }, 'due-this-week', today)).toBe(false);
  });
  it('filters by where the to-do came from', () => {
    expect(matchesFilter({ ...base, source: 'feedback' }, 'from-feedback', today)).toBe(true);
    expect(matchesFilter({ ...base, source: 'artist' }, 'own', today)).toBe(true);
    expect(matchesFilter(base, 'own', today)).toBe(false);
  });
});

describe('plan alignment check', () => {
  it('flags an empty template', () => {
    const gaps = alignmentGaps(templatePlan());
    expect(gaps).toContain('The plan has no outcome statement.');
    expect(gaps).toContain('No success measures are defined.');
  });
  it('flags a measure no milestone feeds', () => {
    const plan = {
      outcome: 'Release an EP and play 6 shows',
      measures: [
        { id: 'M1' as const, label: 'EP released' },
        { id: 'M2' as const, label: '6 shows' },
      ],
      phases: [
        {
          id: 'p1',
          name: 'Release',
          goal: '',
          milestones: [{ id: 'm1', title: 'Master EP', done: false, measures: ['M1' as const] }],
        },
      ],
    };
    expect(alignmentGaps(plan)).toEqual(['No milestone feeds M2.']);
  });
});

describe('validation', () => {
  it('rejects a plan without phases and a no-op to-do patch', () => {
    expect(PlanBody.safeParse({ outcome: '', measures: [], phases: [], version: 0 }).success).toBe(
      false,
    );
    expect(TodoPatch.safeParse({}).success).toBe(false);
  });
  it('makes sortable unique ids', () => {
    const a = newId(1_000);
    const b = newId(2_000);
    expect(a < b).toBe(true);
    expect(newId(1_000)).not.toBe(a);
    expect(a).toMatch(/^[a-z0-9]{19}$/);
  });
});

describe('to-do reminders', () => {
  it('reads due times as Melbourne time, across daylight saving', () => {
    // AEDT (UTC+11) in November, AEST (UTC+10) in June.
    expect(zonedTimeToUtc('2026-11-20', '09:00').toISOString()).toBe('2026-11-19T22:00:00.000Z');
    expect(zonedTimeToUtc('2026-06-20', '09:00').toISOString()).toBe('2026-06-19T23:00:00.000Z');
  });

  it('fires 60 minutes, 1, 3 or 7 days before the due time (9am if no time)', () => {
    const due = { due: '2026-11-20', dueTime: '14:30' };
    expect(reminderAt({ ...due, reminder: '60m' })?.toISOString()).toBe('2026-11-20T02:30:00.000Z');
    expect(reminderAt({ ...due, reminder: '1d' })?.toISOString()).toBe('2026-11-19T03:30:00.000Z');
    expect(reminderAt({ ...due, reminder: '3d' })?.toISOString()).toBe('2026-11-17T03:30:00.000Z');
    expect(reminderAt({ ...due, reminder: '7d' })?.toISOString()).toBe('2026-11-13T03:30:00.000Z');
    expect(reminderAt({ due: '2026-11-20', reminder: '1d' })?.toISOString()).toBe(
      '2026-11-18T22:00:00.000Z',
    );
    expect(reminderAt({ due: '2026-11-20' })).toBeUndefined();
    expect(reminderAt({ reminder: '1d' })).toBeUndefined();
  });

  it('only accepts the four reminder choices and a valid time', () => {
    expect(TodoCreate.safeParse({ title: 'x', reminder: '2d' }).success).toBe(false);
    expect(TodoCreate.safeParse({ title: 'x', dueTime: '25:00' }).success).toBe(false);
    expect(TodoPatch.safeParse({ reminder: null }).success).toBe(true);
    expect(TodoPatch.safeParse({ dueTime: '07:05' }).success).toBe(true);
  });

  it('keeps schedule names within 64 characters', () => {
    expect(reminderScheduleName(`art_${'a'.repeat(32)}`, newId()).length).toBeLessThanOrEqual(64);
  });
});

describe('editing to-dos', () => {
  it('lists the fields that changed', () => {
    expect(changedFields(base, { ...base, title: 'Book studio', due: '2026-12-01' })).toEqual([
      'title',
      'due',
    ]);
    expect(changedFields(base, { ...base })).toEqual([]);
  });

  it('tells whoever the to-do is allocated to', () => {
    expect(notifyOnEdit('bmg-staff', base)).toBe('artist');
    expect(notifyOnEdit('bmg-admin', { ...base, visibility: 'bmg-only' })).toBeUndefined();
    expect(notifyOnEdit('artist', base)).toBe('bmg');
    expect(notifyOnEdit('artist', { ...base, source: 'artist' })).toBeUndefined();
  });
});

describe('custom plan stages', () => {
  const A = 'art_aaaaaaaaaaaa';
  it('apply to every artist or to the named ones', () => {
    expect(stageAppliesTo({ appliesTo: 'all', artistIds: [] }, A)).toBe(true);
    expect(stageAppliesTo({ appliesTo: 'selected', artistIds: [A] }, A)).toBe(true);
    expect(stageAppliesTo({ appliesTo: 'selected', artistIds: [] }, A)).toBe(false);
    expect(StageBody.safeParse({ name: 'Radio', appliesTo: 'selected' }).success).toBe(false);
    expect(
      StageBody.safeParse({ name: 'Radio', appliesTo: 'selected', artistIds: [A] }).success,
    ).toBe(true);
  });

  it('become a plan phase with fresh milestones', () => {
    let n = 0;
    const phase = phaseFromStage(
      { name: 'Radio', goal: '**Get played**', milestones: ['Pitch list', 'Send'], stageId: 's1' },
      () => `id${n++}`,
    );
    expect(phase).toMatchObject({ name: 'Radio', goal: '**Get played**', stageId: 's1' });
    expect(phase.milestones.map((m) => [m.title, m.done])).toEqual([
      ['Pitch list', false],
      ['Send', false],
    ]);
    expect(PlanBody.safeParse({ ...templatePlan(), phases: [phase] }).success).toBe(true);
  });
});

describe('plan dates for the timeline (rev 7)', () => {
  const phase = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    name: 'Foundations',
    milestones: [{ id: 'm1', title: 'Shoot', due: '2026-11-20' }],
    ...over,
  });
  const plan = (phases: unknown[]) => ({ outcome: '', measures: [], phases, version: 0 });

  it('takes stage start and end and milestone due dates, all optional', () => {
    expect(
      PlanBody.safeParse(plan([phase({ start: '2026-11-01', end: '2026-11-30' })])).success,
    ).toBe(true);
    expect(PlanBody.safeParse(plan([{ id: 'p', name: 'X' }])).success).toBe(true);
    expect(PlanBody.safeParse(plan([phase({ start: '1 Nov' })])).success).toBe(false);
  });

  it("won't let a stage end before it starts", () => {
    const r = PlanBody.safeParse(plan([phase({ start: '2026-12-01', end: '2026-11-01' })]));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/end before it starts/);
  });

  it('spans the earliest to the latest date', () => {
    expect(
      planSpan([
        { start: '2026-11-01', end: '2026-12-31', milestones: [{ due: '2027-01-15' }] },
        { milestones: [{}] },
      ]),
    ).toEqual({ from: '2026-11-01', to: '2027-01-15' });
    expect(planSpan([{ milestones: [] }])).toBeUndefined();
  });
});

describe('to-do threads (rev 7)', () => {
  const c = (
    id: string,
    at: string,
    parentId?: string,
    over: Partial<TodoComment> = {},
  ): TodoComment => ({
    commentId: id,
    todoId: 't0000000001',
    artistId: 'art_aaaaaaaaaaaa',
    ...(parentId ? { parentId } : {}),
    text: id,
    authorSub: 'u',
    authorRole: 'artist',
    authorName: 'Chloe',
    createdAt: at,
    ...over,
  });

  it('keeps comments out of the to-do list prefix', () => {
    expect(todoCommentPrefix('abc').startsWith('TODO#')).toBe(false);
  });

  it('nests replies one level deep, in time order', () => {
    const thread = threadOf([
      c('b0000000002', '2026-11-10T02:00:00Z'),
      c('r0000000001', '2026-11-10T03:00:00Z', 'a0000000001'),
      c('a0000000001', '2026-11-10T01:00:00Z'),
      c('r0000000002', '2026-11-10T04:00:00Z', 'r0000000001'),
      c('o0000000001', '2026-11-10T05:00:00Z', 'gone0000000'),
    ]);
    expect(thread.map((t) => t.commentId)).toEqual(['a0000000001', 'b0000000002', 'o0000000001']);
    expect(thread[0]!.replies.map((r) => r.commentId)).toEqual(['r0000000001', 'r0000000002']);
  });

  it('hides the words of removed comments', () => {
    const p = publicComment(
      c('a0000000001', 'x', undefined, { deletedAt: 'y', authorSub: 'me' }),
      'me',
    );
    expect(p).toMatchObject({ text: '', deleted: true, mine: true });
  });

  it('needs some words, not too many', () => {
    expect(CommentCreate.safeParse({ text: '  ' }).success).toBe(false);
    expect(CommentCreate.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false);
    expect(CommentCreate.parse({ text: ' On it 👍 ', parentId: 'a0000000001' })).toEqual({
      text: 'On it 👍',
      parentId: 'a0000000001',
    });
  });
});

describe('to-do visibility (meeting sharing)', () => {
  it('lets a patch show or hide a to-do, and nothing else is needed', () => {
    expect(TodoPatch.parse({ bmgOnly: false })).toEqual({ bmgOnly: false });
    expect(TodoPatch.parse({ bmgOnly: true })).toEqual({ bmgOnly: true });
    expect(TodoPatch.safeParse({ bmgOnly: 'yes' }).success).toBe(false);
  });
});
