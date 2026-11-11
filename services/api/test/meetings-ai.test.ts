import { describe, expect, it } from 'vitest';
import type { Plan } from '../src/workspace/model.ts';
import {
  applySuggestions,
  planForPrompt,
  planProblem,
  reviewChanges,
  setStatus,
} from '../src/meetings/plan-changes.ts';
import { jsonIn, promptVars, summaryFrom, summaryMarkdown } from '../src/meetings/ai.ts';
import { plan as notify } from '../src/notifications/model.ts';

const PLAN: Pick<Plan, 'outcome' | 'measures' | 'phases'> = {
  outcome: 'Release a debut album and headline a Melbourne show.',
  measures: [
    { id: 'M1', label: '1,000 monthly listeners' },
    { id: 'M2', label: '' },
  ],
  phases: [
    {
      id: 'p1',
      name: 'Foundations',
      goal: 'Get the basics right',
      start: '2026-09-01',
      end: '2026-10-31',
      milestones: [{ id: 'm1', title: 'Brand kit', done: false, measures: [] }],
    },
    {
      id: 'p2',
      name: 'Album release',
      goal: '',
      start: '2026-11-01',
      end: '2026-12-12',
      milestones: [
        { id: 'm2', title: 'Master the EP', done: false, measures: [], due: '2026-11-20' },
      ],
    },
  ],
};

const reason = 'Agreed in the meeting';

describe('suggested plan changes', () => {
  it('reads "before" from the plan, never from the model', () => {
    const [s] = reviewChanges(PLAN, [
      { kind: 'stage.rename', phaseId: 'p2', after: 'EP release', reason, refs: [3] },
    ]);
    expect(s).toMatchObject({
      id: 'c1',
      where: 'Album release',
      before: 'Album release',
      after: 'EP release',
      status: 'waiting',
      checkThis: false,
    });
  });

  it('drops changes that point at nothing, change nothing, repeat, or are malformed', () => {
    const out = reviewChanges(PLAN, [
      { kind: 'stage.rename', phaseId: 'nope', after: 'X', reason },
      { kind: 'stage.rename', phaseId: 'p1', after: 'Foundations', reason },
      { kind: 'milestone.done', phaseId: 'p1', milestoneId: 'm1', done: true, reason },
      { kind: 'milestone.done', phaseId: 'p1', milestoneId: 'm1', done: true, reason: 'again' },
      { kind: 'milestone.rename', phaseId: 'p1', milestoneId: 'zz', after: 'x', reason },
      { kind: 'delete.everything', reason },
      { kind: 'outcome.edit', after: '', reason },
      'nonsense',
    ]);
    expect(out.map((s) => s.change.kind)).toEqual(['milestone.done']);
  });

  it('flags removals and big date moves for a second look', () => {
    const out = reviewChanges(PLAN, [
      { kind: 'stage.dates', phaseId: 'p2', end: '2027-01-30', reason },
      { kind: 'milestone.due', phaseId: 'p2', milestoneId: 'm2', due: '2026-11-27', reason },
      { kind: 'milestone.remove', phaseId: 'p1', milestoneId: 'm1', reason },
    ]);
    expect(out.map((s) => s.checkThis)).toEqual([true, false, true]);
    expect(out[0]!.before).toBe('1 Nov 2026 – 12 Dec 2026');
    expect(out[0]!.after).toBe('1 Nov 2026 – 30 Jan 2027');
  });

  it('links a milestone to a new stage, and keeps them in step', () => {
    const list = reviewChanges(PLAN, [
      { kind: 'stage.add', key: 'tour', name: 'Regional tour', afterPhaseId: 'p2', reason },
      { kind: 'milestone.add', phaseId: 'tour', title: 'Book Ballarat', due: '2027-02-10', reason },
    ]);
    expect(list[1]).toMatchObject({ dependsOn: 'c1', where: 'Regional tour' });
    setStatus(list, 'c2', 'accepted');
    expect(list.map((s) => s.status)).toEqual(['accepted', 'accepted']);
    setStatus(list, 'c1', 'rejected');
    expect(list.map((s) => s.status)).toEqual(['rejected', 'rejected']);
  });

  it('applies accepted changes only, with fresh ids, as a valid plan', () => {
    const list = reviewChanges(PLAN, [
      { kind: 'stage.add', key: 'tour', name: 'Regional tour', afterPhaseId: 'p1', reason },
      { kind: 'milestone.add', phaseId: 'tour', title: 'Book Ballarat', reason },
      { kind: 'milestone.done', phaseId: 'p1', milestoneId: 'm1', done: true, reason },
      { kind: 'stage.dates', phaseId: 'p2', end: '2027-01-30', reason },
    ]);
    setStatus(list, 'c2', 'accepted');
    setStatus(list, 'c3', 'accepted');
    let n = 0;
    const { next, applied, stale } = applySuggestions(PLAN, list, () => `new${++n}`);
    expect(applied).toEqual(['c1', 'c2', 'c3']);
    expect(stale).toEqual([]);
    expect(next.phases.map((p) => p.name)).toEqual([
      'Foundations',
      'Regional tour',
      'Album release',
    ]);
    expect(next.phases[1]!.milestones[0]).toMatchObject({ id: 'new2', title: 'Book Ballarat' });
    expect(next.phases[0]!.milestones[0]!.done).toBe(true);
    expect(next.phases[2]!.end).toBe('2026-12-12'); // not accepted
    expect(PLAN.phases[0]!.milestones[0]!.done).toBe(false); // untouched
    expect(planProblem(next)).toBeUndefined();
  });

  it('reports changes that no longer fit the plan as stale', () => {
    const list = reviewChanges(PLAN, [
      { kind: 'milestone.done', phaseId: 'p1', milestoneId: 'm1', done: true, reason },
      { kind: 'stage.goal', phaseId: 'p2', after: 'Ship the EP', reason },
    ]);
    list.forEach((s) => (s.status = 'accepted'));
    const changed = structuredClone(PLAN);
    changed.phases[0]!.milestones = [];
    const { applied, stale } = applySuggestions(changed, list, () => 'x');
    expect(applied).toEqual(['c2']);
    expect(stale).toEqual(['c1']);
  });

  it('refuses a plan the editor would refuse', () => {
    const bad = structuredClone(PLAN);
    bad.phases[0]!.end = '2026-08-01';
    expect(planProblem(bad)).toMatch(/can't end before it starts/);
  });

  it('shows the model the plan with ids, without empty measures', () => {
    const text = planForPrompt(PLAN);
    expect(text).toContain('"id": "p2"');
    expect(text).toContain('"id": "m2"');
    expect(text).not.toContain('"M2"');
  });
});

describe('summaries', () => {
  const content = {
    segments: [
      { id: 0, speaker: 'spk_0', start: 3, end: 5, text: 'Let’s push the EP.' },
      { id: 1, speaker: 'spk_1', start: 65, end: 70, text: 'Agreed, late January.' },
    ],
    speakers: { spk_0: 'Kyra' },
    notes: '',
    markers: [],
  };
  const meta = { id: 'r1', createdAt: '2026-11-11T00:00:00Z', createdBy: 'x' };

  it('keeps only real transcript lines as sources', () => {
    const s = summaryFrom(
      jsonIn(
        'Here you go: {"sections":[{"heading":"Decisions","points":[{"text":"EP moves to late January","refs":[1,1,7]}]}],"actions":[{"text":"Tell the distributor","owner":"Kyra","due":"soon","refs":[0]}]} thanks',
      ),
      content,
      { ...meta, kind: 'full' },
    )!;
    expect(s.sections[0]!.points[0]!.refs).toEqual([1]);
    expect(s.actions[0]).toEqual({ text: 'Tell the distributor', refs: [0], owner: 'Kyra' });
    expect(summaryMarkdown(s, content)).toContain('- EP moves to late January (1:05)');
    expect(summaryMarkdown(s, content)).toContain('- [ ] **Kyra:** Tell the distributor (0:03)');
  });

  it('has no action items in a quick summary, and refuses non-answers', () => {
    const q = summaryFrom(
      {
        sections: [{ heading: 'Summary', points: [{ text: 'x', refs: [] }] }],
        actions: [{ text: 'y' }],
      },
      content,
      { ...meta, kind: 'quick' },
    )!;
    expect(q.actions).toEqual([]);
    expect(summaryFrom({ sections: [] }, content, { ...meta, kind: 'quick' })).toBeUndefined();
    expect(jsonIn('no json here')).toBeUndefined();
  });

  it('gives the model numbered lines with names and times', () => {
    const v = promptVars(
      {
        title: 'Plan review',
        startedAt: '2026-11-11T03:00:00Z',
        attendees: [],
        artistId: 'art_aaaaaaaaaaaa',
      },
      { ...content, notes: 'Push it', markers: [{ at: 61, note: 'budget' }] },
      { artistName: 'Chloe Poli', today: '2026-11-11' },
    );
    expect(v.transcript).toBe(
      '[0] (0:03) Kyra: Let’s push the EP.\n[1] (1:05) Speaker 2: Agreed, late January.',
    );
    expect(v.notes).toBe('Push it\nMarked at 1:01: budget');
    expect(v.about).toBe('Chloe Poli');
  });
});

describe('notifications', () => {
  const people = [
    { sub: 'a', role: 'artist' as const, artistId: 'art_aaaaaaaaaaaa', email: 'a@x' },
    { sub: 'b', role: 'artist' as const, artistId: 'art_bbbbbbbbbbbb', email: 'b@x' },
    { sub: 's', role: 'bmg-staff' as const, email: 's@x' },
  ];
  it('tells only the artist when their plan is updated, in plan words', () => {
    const p = notify(
      {
        type: 'plan.updated',
        artistId: 'art_aaaaaaaaaaaa',
        lines: ['Album release: renamed'],
        more: 2,
      },
      people,
    )!;
    expect(p.to.map((r) => r.sub)).toEqual(['a']);
    expect(p.draft.body).toBe('• Album release: renamed\n+ 2 more changes');
    expect(p.draft.link).toBe('plan');
  });

  it('tells only the person who recorded a meeting that it’s ready', () => {
    const p = notify(
      {
        type: 'meeting.processed',
        meetingId: 'mabcdefghij12',
        artistId: 'art_aaaaaaaaaaaa',
        createdBy: 's',
        title: 'Plan review',
        outcome: 'ready',
      },
      people,
    )!;
    expect(p.to.map((r) => r.sub)).toEqual(['s']);
    expect(p.draft.link).toBe('meeting:art_aaaaaaaaaaaa/mabcdefghij12');
  });
});
