import { describe, expect, it } from 'vitest';
import {
  actionsFrom,
  actionsWaiting,
  mergeActions,
  stepFor,
  withEdits,
  type MeetingAction,
  type MeetingActionSet,
} from '../src/meetings/meeting-actions.ts';

/** Actions found in a meeting (rev 11 change): parsing, merging and what Do it calls. */

const segments = [{ id: 0 }, { id: 1 }];
const meta = { requestId: 'r1', createdAt: '2026-11-11T00:00:00Z', createdBy: 'k' };

describe('reading the AI’s reply', () => {
  it('keeps to-dos and gigs, drops what is malformed and lines that don’t exist', () => {
    const set = actionsFrom(
      {
        actions: [
          { kind: 'todo', why: 'Agreed', refs: [0, 0, 9], title: 'Send stems', due: 'soon' },
          {
            kind: 'gig',
            why: 'Booked',
            refs: [1],
            title: 'Lantern Room',
            date: '2026-12-12',
            startTime: '8pm',
          },
          { kind: 'gig', why: 'Floated', refs: [], title: 'No date' },
          { kind: 'email', why: 'x', refs: [], title: 'Nope' },
        ],
      },
      segments,
      meta,
    )!;
    expect(set.items).toEqual([
      {
        id: 'a1',
        kind: 'todo',
        why: 'Agreed',
        refs: [0],
        status: 'waiting',
        todo: { title: 'Send stems' },
      },
      {
        id: 'a2',
        kind: 'gig',
        why: 'Booked',
        refs: [1],
        status: 'waiting',
        gig: { title: 'Lantern Room', date: '2026-12-12' },
      },
    ]);
    expect(actionsWaiting(set)).toBe(2);
  });

  it('isn’t fooled by a reply of the wrong shape', () => {
    expect(actionsFrom({ nope: true }, segments, meta)).toBeUndefined();
    expect(actionsFrom({ actions: [] }, segments, meta)!.items).toEqual([]);
  });
});

describe('looking again', () => {
  const action = (id: string, status: MeetingAction['status'], title: string): MeetingAction => ({
    id,
    kind: 'todo',
    why: 'x',
    refs: [],
    status,
    todo: { title },
  });
  it('keeps what was decided (same ids), replaces what was waiting, and doesn’t repeat', () => {
    const before: MeetingActionSet = {
      ...meta,
      items: [
        action('a1', 'done', 'Send stems'),
        action('a2', 'waiting', 'Old idea'),
        action('a3', 'doing', 'Call Sam'),
      ],
    };
    const next: MeetingActionSet = {
      ...meta,
      requestId: 'r2',
      items: [action('a1', 'waiting', 'send stems'), action('a2', 'waiting', 'Book photographer')],
    };
    const merged = mergeActions(before, next);
    expect(merged.items.map((a) => [a.id, a.status, a.todo?.title])).toEqual([
      ['a1', 'done', 'Send stems'],
      ['a3', 'doing', 'Call Sam'],
      ['a4', 'waiting', 'Book photographer'],
    ]);
  });
});

describe('what Do it calls', () => {
  const meeting = { title: 'Meeting with Chloe Poli', date: '2026-11-11' };
  it('adds a to-do through the normal API, noting the meeting, without a past due date', () => {
    const todo: MeetingAction = {
      id: 'a1',
      kind: 'todo',
      why: 'x',
      refs: [],
      status: 'waiting',
      todo: { title: 'Send stems', due: '2026-11-01' },
    };
    expect(stepFor(todo, 'art_aaaaaaaaaaaa', meeting, '2026-11-11')).toEqual({
      method: 'POST',
      path: '/artists/art_aaaaaaaaaaaa/todos',
      body: {
        title: 'Send stems',
        notes: 'From the meeting “Meeting with Chloe Poli”, 2026-11-11.',
      },
    });
  });

  it('creates a gig as an idea, with staff’s edits re-checked', () => {
    const gig: MeetingAction = {
      id: 'a2',
      kind: 'gig',
      why: 'x',
      refs: [],
      status: 'waiting',
      gig: { title: 'Lantern Room', date: '2026-12-12' },
    };
    const edited = withEdits(gig, { gig: { venue: 'The Lantern Room', startTime: '20:00' } });
    expect(stepFor(edited, 'art_aaaaaaaaaaaa', meeting, '2026-11-11')).toMatchObject({
      path: '/artists/art_aaaaaaaaaaaa/gigs',
      body: {
        title: 'Lantern Room',
        date: '2026-12-12',
        venue: 'The Lantern Room',
        startTime: '20:00',
        status: 'idea',
      },
    });
    expect(() => withEdits(gig, { gig: { date: 'tomorrow' } })).toThrow();
    expect(() => withEdits(gig, { todo: { title: 'x' } })).toThrow();
  });
});
