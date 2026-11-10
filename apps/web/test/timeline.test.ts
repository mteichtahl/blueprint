import { describe, expect, it } from 'vitest';
import { layoutTimeline, PX_PER_DAY } from '../src/lib/timeline.ts';

const phases = [
  {
    id: 'a',
    name: 'Foundations',
    start: '2026-11-02',
    end: '2026-11-29',
    milestones: [
      { id: 'm1', title: 'Brand shoot', done: true, due: '2026-11-15' },
      { id: 'm2', title: 'Bio', done: false },
    ],
  },
  { id: 'b', name: 'Album release', milestones: [] },
];

describe('plan timeline', () => {
  it('draws nothing for an undated plan', () => {
    expect(
      layoutTimeline([{ id: 'x', name: 'X', milestones: [] }], 'month', '2026-11-10'),
    ).toBeNull();
  });

  it('lays out bars, diamonds and the today line', () => {
    const t = layoutTimeline(phases, 'month', '2026-11-10')!;
    expect(t.from).toBe('2026-11-01');
    const bar = t.rows.find((r) => r.id === 'a')!;
    expect(bar.x1).toBe(PX_PER_DAY.month * 1);
    expect(bar.x2! > bar.x1!).toBe(true);
    const shoot = t.rows.find((r) => r.id === 'm1')!;
    expect(shoot.x! > bar.x1! && shoot.x! < bar.x2!).toBe(true);
    expect(t.todayX).not.toBeNull();
    expect(t.ticks[0]!.label).toMatch(/Nov/);
  });

  it('lists what has no dates yet', () => {
    const t = layoutTimeline(phases, 'week', '2026-11-10')!;
    expect(t.unscheduled).toEqual([
      { phase: 'Foundations', title: 'Bio' },
      { phase: 'Album release', title: 'Stage dates' },
    ]);
    expect(t.from).toBe('2026-11-02'); // a Monday
    expect(t.rows.find((r) => r.id === 'b')!.unscheduled).toBe(true);
  });

  it('starts quarters on the first month of the quarter', () => {
    expect(layoutTimeline(phases, 'quarter', '2026-11-10')!.from).toBe('2026-10-01');
  });

  it('hides the today line outside the plan', () => {
    expect(layoutTimeline(phases, 'month', '2027-06-01')!.todayX).toBeNull();
  });
});
