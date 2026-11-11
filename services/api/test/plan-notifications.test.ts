import { describe, expect, it } from 'vitest';
import { bodyBlocks, planGroups, type Recipient } from '../src/notifications/model.ts';
import { digestLines, planDigestScheduleName } from '../src/workspace/plan-owner.ts';
import { handoverSummary, plainText } from '../src/workspace/plan-handover.ts';
import type { PlanChange } from '../src/workspace/plan-history.ts';

const A = 'art_aaaaaaaaaaaa';
const people: Recipient[] = [
  { sub: 'kyra', role: 'bmg-admin', email: 'k@x' },
  { sub: 'pat', role: 'bmg-admin' },
  { sub: 'sam', role: 'bmg-staff', assignedArtistIds: [A] },
  { sub: 'chloe', role: 'artist', artistId: A },
  { sub: 'sarun', role: 'artist', artistId: 'art_bbbbbbbbbbbb' },
];
const subs = (g: { to: Recipient[] }) => g.to.map((r) => r.sub).sort();

describe('plan updates (rev 12)', () => {
  const update = {
    type: 'plan.updated' as const,
    artistId: A,
    lines: ['Album release: set the dates to 2 Feb – 30 Apr 2027'],
    more: 0,
    artistName: 'Chloe Poli',
  };

  it('tells the artist and the plan owner, each in their own words', () => {
    const [artist, owner] = planGroups({ ...update, ownerSub: 'sam', bySub: 'kyra' }, people);
    expect(subs(artist!)).toEqual(['chloe']);
    expect(artist!.draft.title).toBe('Blueprint updated your plan');
    expect(artist!.draft.link).toBe('plan');
    expect(subs(owner!)).toEqual(['sam']);
    expect(owner!.draft.title).toBe("Chloe Poli's plan was updated");
    expect(owner!.draft.link).toBe(`plan:${A}`);
  });

  it("doesn't tell the person who made the change", () => {
    const [, owner] = planGroups({ ...update, ownerSub: 'sam', bySub: 'sam' }, people);
    expect(owner!.to).toEqual([]);
  });

  it('tells the admins when the plan has no owner, or the owner has left', () => {
    expect(subs(planGroups({ ...update, bySub: 'kyra' }, people)[1]!)).toEqual(['pat']);
    expect(subs(planGroups({ ...update, ownerSub: 'gone', bySub: 'sam' }, people)[1]!)).toEqual([
      'kyra',
      'pat',
    ]);
  });

  it('still tells the owner when staff chose not to tell the artist', () => {
    const [artist, owner] = planGroups(
      { ...update, ownerSub: 'sam', bySub: 'kyra', skipArtist: true },
      people,
    );
    expect(artist!.to).toEqual([]);
    expect(subs(owner!)).toEqual(['sam']);
  });
});

describe('plan owner changes', () => {
  const change = {
    type: 'plan.ownerChanged' as const,
    artistId: A,
    artistName: 'Chloe Poli',
    fromSub: 'kyra',
    toSub: 'sam',
    toName: 'Sam',
    bySub: 'pat',
    moved: 4,
    summary: ['Pat handed Chloe Poli’s plan to you (from Kyra).'],
  };
  it('gives the new owner the summary and tells the previous owner what moved', () => {
    const [to, from] = planGroups(change, people);
    expect(subs(to!)).toEqual(['sam']);
    expect(to!.draft.title).toBe("You now own Chloe Poli's plan");
    expect(subs(from!)).toEqual(['kyra']);
    expect(from!.draft.body).toBe('4 open to-dos moved to Sam.');
  });
  it('gives the summary even to someone taking the plan on themselves', () => {
    const [to, from] = planGroups({ ...change, bySub: 'sam' }, people);
    expect(subs(to!)).toEqual(['sam']);
    expect(subs(from!)).toEqual(['kyra']);
  });
  it("doesn't tell the previous owner about their own handover", () => {
    expect(planGroups({ ...change, bySub: 'kyra' }, people)[1]!.to).toEqual([]);
  });
  it('never tells the artist (the plan update says so instead)', () => {
    const all = planGroups(change, people).flatMap((g) => g.to.map((r) => r.sub));
    expect(all).not.toContain('chloe');
  });
});

describe('the 10-minute roll-up', () => {
  const entry = (at: string, bySub: string, kind: PlanChange['kind'], changes: string[]) => ({
    at,
    bySub,
    kind,
    changes,
  });
  it("lists one person's saves, oldest first, without meeting updates", () => {
    const res = digestLines(
      [
        entry('2026-11-11T01:05:00Z', 'sam', 'edited', ['Changed the outcome']),
        entry('2026-11-11T01:01:00Z', 'sam', 'edited', ['Renamed stage “Live” to “Live shows”']),
        entry('2026-11-11T01:02:00Z', 'kyra', 'edited', ['Changed the goal of “Brand”']),
        entry('2026-11-11T01:03:00Z', 'sam', 'meeting', ['From a meeting']),
      ],
      'sam',
    );
    expect(res).toEqual({
      lines: ['Renamed stage “Live” to “Live shows”', 'Changed the outcome'],
      more: 0,
    });
  });
  it('shows up to 10 lines and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, n) => `Change ${n}`);
    const res = digestLines([entry('2026-11-11T01:00:00Z', 'sam', 'edited', many)], 'sam');
    expect(res.lines).toHaveLength(10);
    expect(res.more).toBe(3);
  });
  it('names one schedule per artist and editor, within 64 characters', () => {
    const a = planDigestScheduleName(A, '00000000-0000-0000-0000-000000000001');
    expect(a).toMatch(/^plan-[0-9a-f]{40}$/);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(planDigestScheduleName(A, '00000000-0000-0000-0000-000000000002')).not.toBe(a);
  });
});

describe('handover summary', () => {
  const base = {
    artistName: 'Chloe Poli',
    fromName: 'Kyra',
    byName: 'Kyra',
    byNewOwner: false,
    plan: {
      outcome: '**Release** an EP and play [six shows](https://x)',
      measures: [
        { id: 'M1' as const, label: 'EP out' },
        { id: 'M2' as const, label: '' },
      ],
      phases: [
        {
          id: 'p1',
          name: 'Foundations',
          goal: '',
          start: '2026-09-01',
          end: '2026-10-31',
          milestones: [{ id: 'm1', title: 'Brand kit', done: true, measures: [] }],
        },
        {
          id: 'p2',
          name: 'Live confidence',
          goal: '',
          milestones: [
            {
              id: 'm2',
              title: 'First headline show',
              done: false,
              due: '2026-12-02',
              measures: [],
            },
            { id: 'm3', title: 'Showcase', done: false, due: '2026-11-01', measures: [] },
            { id: 'm4', title: 'Tour', done: false, due: '2027-06-01', measures: [] },
          ],
        },
      ],
    },
    todos: [
      { title: 'Book rehearsal', due: '2026-11-20', done: false },
      { title: 'Send rider', due: '2026-11-05', done: false },
      { title: 'Old one', done: true },
    ],
    waiting: [{ title: 'EP artwork', neededBy: '2026-11-30' }],
    recent: [
      { at: '2026-11-11T01:00:00Z', changes: ['Changed the plan owner from Kyra to Sam'] },
      { at: '2026-11-10T01:00:00Z', changes: ['Changed the outcome', 'Reordered the stages'] },
    ],
    today: '2026-11-11',
  };

  it('reads like a briefing, from the plan’s own data', () => {
    expect(handoverSummary(base)).toEqual([
      "Kyra handed Chloe Poli's plan to you.",
      'Outcome: Release an EP and play six shows',
      'Success measures: M1 EP out',
      'Stages:',
      '• Foundations (1 Sept 2026 – 31 Oct 2026): 1 of 1 milestones done',
      '• Live confidence: 0 of 3 milestones done, current stage',
      'Milestones overdue or due in the next 30 days:',
      '• “Showcase” (Live confidence), overdue since 1 Nov 2026',
      '• “First headline show” (Live confidence), due 2 Dec 2026',
      'Your open to-dos for Chloe Poli (2):',
      '• Send rider, overdue since 5 Nov 2026',
      '• Book rehearsal, due 20 Nov 2026',
      'Waiting for review (1):',
      '• EP artwork, needed by 30 Nov 2026',
      'Recent changes:',
      '• 11 Nov 2026: Changed the plan owner from Kyra to Sam',
      '• 10 Nov 2026: Changed the outcome and 1 more',
    ]);
  });

  it('says who handed it over, the note, and when someone took it on themselves', () => {
    expect(
      handoverSummary({ ...base, byName: 'Pat', note: 'Call her Monday' }).slice(0, 2),
    ).toEqual(["Pat handed Chloe Poli's plan to you (from Kyra).", 'Note: “Call her Monday”']);
    expect(handoverSummary({ ...base, byNewOwner: true })[0]).toBe(
      "You took over Chloe Poli's plan from Kyra.",
    );
    expect(handoverSummary({ ...base, byNewOwner: true, fromName: undefined })[0]).toBe(
      "You're now the owner of Chloe Poli's plan.",
    );
  });

  it('leaves out empty sections', () => {
    const lines = handoverSummary({ ...base, todos: [], waiting: [], recent: [] });
    expect(lines.some((l) => l.startsWith('Your open to-dos'))).toBe(false);
    expect(lines.some((l) => l.startsWith('Waiting for review'))).toBe(false);
    expect(lines.some((l) => l.startsWith('Recent changes'))).toBe(false);
  });

  it('turns Markdown into one short plain line', () => {
    expect(plainText('# Big\n\n> quote _here_', 240)).toBe('Big quote here');
    expect(plainText('x'.repeat(300), 20)).toHaveLength(20);
  });
});

describe('notification emails', () => {
  it('shows bullet lines as lists and the rest as paragraphs', () => {
    expect(bodyBlocks('Intro\n• one\n• two\nAfter\n\n• three')).toEqual([
      { kind: 'p', text: 'Intro' },
      { kind: 'list', items: ['one', 'two'] },
      { kind: 'p', text: 'After' },
      { kind: 'list', items: ['three'] },
    ]);
  });
});
