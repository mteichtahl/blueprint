import { describe, expect, it } from 'vitest';
import {
  alignmentGaps,
  matchesFilter,
  newId,
  PlanBody,
  templatePlan,
  TodoPatch,
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
