import { describe, expect, it } from 'vitest';
import {
  alignmentGaps,
  changedFields,
  matchesFilter,
  newId,
  notifyOnEdit,
  phaseFromStage,
  PlanBody,
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
