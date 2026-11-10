import { describe, expect, it } from 'vitest';
import {
  changedBy,
  MAX_CHANGE_LINES,
  planChanges,
  planLogSk,
  publicChange,
  type PlanChange,
} from '../src/workspace/plan-history.ts';

const plan = () => ({
  outcome: 'Release the EP',
  measures: [
    { id: 'M1' as const, label: '10k streams' },
    { id: 'M2' as const, label: '' },
  ],
  phases: [
    {
      id: 'p1',
      name: 'Discovery',
      goal: 'Find the sound',
      milestones: [
        { id: 'a', title: 'Demo three songs', done: false, measures: [] as ('M1' | 'M2')[] },
        { id: 'b', title: 'Pick a producer', done: false, measures: [] as ('M1' | 'M2')[] },
      ],
    },
    {
      id: 'p2',
      name: 'Release',
      goal: '',
      milestones: [] as {
        id: string;
        title: string;
        done: boolean;
        measures: ('M1' | 'M2')[];
        due?: string;
      }[],
    },
  ] as {
    id: string;
    name: string;
    goal: string;
    start?: string;
    end?: string;
    milestones: {
      id: string;
      title: string;
      done: boolean;
      measures: ('M1' | 'M2')[];
      due?: string;
    }[];
  }[],
});

describe('plan change history (rev 8)', () => {
  it('records a new plan as started', () => {
    expect(planChanges(undefined, plan())).toEqual(['Started the plan with 2 stages']);
  });

  it('records nothing when nothing changed', () => {
    expect(planChanges(plan(), plan())).toEqual([]);
  });

  it('describes outcome, measure, stage and milestone changes in plain words', () => {
    const before = plan();
    const after = plan();
    after.outcome = 'Release the EP and tour it';
    after.measures[0]!.label = '20k streams';
    after.measures[1]!.label = '3 sold-out shows';
    after.phases[0]!.name = 'Writing';
    after.phases[0]!.start = '2026-12-01';
    after.phases[0]!.end = '2027-01-15';
    after.phases[0]!.milestones[0]!.done = true;
    after.phases[0]!.milestones[0]!.due = '2026-12-07';
    after.phases[0]!.milestones[1]!.measures = ['M1'];
    after.phases[1]!.milestones.push({ id: 'c', title: 'Book launch', done: false, measures: [] });
    expect(planChanges(before, after)).toEqual([
      'Changed the outcome',
      'Changed success measure M1 to “20k streams”',
      'Added success measure M2: “3 sold-out shows”',
      'Renamed stage “Discovery” to “Writing”',
      'Set the dates of “Writing” to 1 Dec 2026 – 15 Jan 2027',
      'Marked “Demo three songs” done',
      'Set “Demo three songs” due 7 Dec 2026',
      'Linked “Pick a producer” to M1',
      'Added milestone “Book launch” to “Release”',
    ]);
  });

  it('reports moves, removals and reordering', () => {
    const before = plan();
    const after = plan();
    const [a] = after.phases[0]!.milestones;
    after.phases[0]!.milestones = [];
    after.phases[1]!.milestones = [a!];
    after.phases.reverse();
    expect(planChanges(before, after)).toEqual([
      'Reordered the stages',
      'Moved milestone “Demo three songs” from “Discovery” to “Release”',
      'Removed milestone “Pick a producer” from “Discovery”',
    ]);
    const fewer = plan();
    fewer.phases.pop();
    expect(planChanges(before, fewer)).toEqual(['Removed stage “Release”']);
  });

  it('keeps a huge change readable', () => {
    const after = plan();
    after.phases[1]!.milestones = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      title: `Task ${i}`,
      done: false,
      measures: [],
    }));
    after.phases.push({
      ...after.phases[1]!,
      id: 'p3',
      milestones: after.phases[1]!.milestones.map((m) => ({ ...m, id: `x${m.id}` })),
    });
    const lines = planChanges(plan(), after);
    expect(lines).toHaveLength(MAX_CHANGE_LINES);
    expect(lines.at(-1)).toMatch(/^…and \d+ more changes$/);
  });

  it('names who changed it and keeps their id out of the response', () => {
    expect(changedBy('Artist Manager')).toBe('Blueprint · Artist Manager');
    expect(changedBy(undefined)).toBe('Blueprint');
    expect(changedBy('  ')).toBe('Blueprint');
    const c: PlanChange = {
      changeId: 'c1',
      artistId: 'art_aaaaaaaaaaaa',
      version: 3,
      at: '2026-11-10T01:00:00.000Z',
      kind: 'edited',
      bySub: 'secret-sub',
      byRole: 'bmg-staff',
      byName: 'Blueprint',
      changes: ['Changed the outcome'],
    };
    expect(publicChange(c)).not.toHaveProperty('bySub');
    expect(planLogSk(c.at, c.changeId)).toBe('PLANLOG#2026-11-10T01:00:00.000Z#c1');
  });
});
