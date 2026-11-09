import { describe, expect, it } from 'vitest';
import { overallProgress, phaseProgress } from '../src/lib/plan.ts';

const m = (done: boolean) => ({ id: Math.random().toString(), title: 'x', done, measures: [] });

describe('phase progress', () => {
  it('marks finished phases done, the first unfinished one now, the rest next', () => {
    const phases = [
      { id: 'a', name: 'Foundations', goal: '', milestones: [m(true), m(true)] },
      { id: 'b', name: 'Live', goal: '', milestones: [m(true), m(false)] },
      { id: 'c', name: 'Album', goal: '', milestones: [m(false)] },
    ];
    expect(phaseProgress({ phases }).map((p) => [p.status, p.pct])).toEqual([
      ['done', 100],
      ['now', 50],
      ['next', 0],
    ]);
    expect(overallProgress({ phases })).toBe(60);
  });
});
