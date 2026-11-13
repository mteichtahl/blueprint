import { describe, expect, it } from 'vitest';
import { plan, type Recipient } from '../src/notifications/model.ts';
import {
  matchesFilter,
  notifyOnEdit,
  TodoCreate,
  TodoPatch,
  type Todo,
} from '../src/workspace/model.ts';
import {
  ArtistTodosSettings,
  canSendBack,
  DEFAULT_SETTINGS,
  isOpenForBmg,
  limitFor,
  openFor,
  refusal,
  settingsFrom,
} from '../src/workspace/owner-todos.ts';
import { movesWithOwner } from '../src/workspace/plan-owner.ts';
import { ProfilePatch } from '../src/handlers/me.ts';

/** Rev 15: artists add to-dos for their plan owner. */

const CHLOE = 'art_chloe00000001';
const SARUN = 'art_sarun00000001';
const KYRA = '00000000-0000-0000-0000-000000000001';
const SAM = '00000000-0000-0000-0000-000000000002';

const forKyra: Todo = {
  todoId: 'abcdefghij',
  artistId: CHLOE,
  title: 'Book the rehearsal room',
  done: false,
  source: 'artist',
  visibility: 'normal',
  createdBy: 'chloe',
  createdAt: '2026-11-13T00:00:00Z',
  assignee: 'bmg',
  bmgOwnerSub: KYRA,
};
const sentBack = {
  reason: 'Ask the venue',
  bySub: KYRA,
  byName: 'Kyra',
  at: '2026-11-13T01:00:00Z',
};

describe('the owner’s limits', () => {
  it('is on with a maximum of 10 until the owner changes it', () => {
    expect(settingsFrom(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(limitFor(DEFAULT_SETTINGS, CHLOE, true)).toEqual({
      enabled: true,
      max: 10,
      custom: false,
    });
  });
  it('lets the owner give one artist a different maximum (a release week)', () => {
    const s = { enabled: true, maxOpenPerArtist: 5, perArtist: { [CHLOE]: 20 } };
    expect(limitFor(s, CHLOE, true)).toEqual({ enabled: true, max: 20, custom: true });
    expect(limitFor(s, SARUN, true)).toEqual({ enabled: true, max: 5, custom: false });
  });
  it('can be turned off, but never for a plan with no owner (Blueprint team)', () => {
    const off = { ...DEFAULT_SETTINGS, enabled: false };
    expect(limitFor(off, CHLOE, true).enabled).toBe(false);
    expect(limitFor(off, CHLOE, false)).toEqual({ enabled: true, max: 10, custom: false });
  });
  it('allows 1 to 50, no minimum setting', () => {
    expect(ArtistTodosSettings.safeParse({ enabled: true, maxOpenPerArtist: 0 }).success).toBe(
      false,
    );
    expect(ArtistTodosSettings.safeParse({ enabled: true, maxOpenPerArtist: 51 }).success).toBe(
      false,
    );
    expect(
      ArtistTodosSettings.safeParse({
        enabled: true,
        maxOpenPerArtist: 3,
        perArtist: { [CHLOE]: 60 },
      }).success,
    ).toBe(false);
    expect(
      ArtistTodosSettings.safeParse({ enabled: true, maxOpenPerArtist: 3, minimum: 1 }).success,
    ).toBe(false);
  });
  it('falls back to the defaults for a damaged record', () => {
    expect(settingsFrom({ enabled: 'yes', maxOpenPerArtist: 999 })).toEqual(DEFAULT_SETTINGS);
  });
  it('is set on Profile by Blueprint people', () => {
    expect(
      ProfilePatch.safeParse({ artistTodos: { enabled: false, maxOpenPerArtist: 4 } }).success,
    ).toBe(true);
  });
});

describe('counting and refusing', () => {
  it('counts only open to-dos the artist sent this owner', () => {
    const todos = [
      forKyra,
      { ...forKyra, todoId: 'b', done: true },
      { ...forKyra, todoId: 'c', sentBack },
      { ...forKyra, todoId: 'd', bmgOwnerSub: SAM },
      { ...forKyra, todoId: 'e', assignee: 'artist' as const },
      { ...forKyra, todoId: 'f', source: 'bmg' as const },
    ];
    expect(openFor(todos, KYRA)).toBe(1);
    expect(openFor(todos, SAM)).toBe(1);
    expect(openFor([{ ...forKyra, bmgOwnerSub: undefined }], undefined)).toBe(1);
  });
  it('refuses at the maximum, in plain words', () => {
    const limit = { enabled: true, max: 10, custom: false };
    expect(refusal(limit, 9, 'Kyra')).toBeNull();
    expect(refusal(limit, 10, 'Kyra')).toBe(
      'Kyra has 10 open to-dos from you. You can add more when one is done or sent back.',
    );
  });
  it('points to Chat when the owner turned it off', () => {
    expect(refusal({ enabled: false, max: 10, custom: false }, 0, 'Kyra')).toBe(
      "Kyra isn't taking to-dos in the app right now. Message them in Chat.",
    );
  });
});

describe('the to-do itself', () => {
  it('lets artists ask for their plan owner, never a named person', () => {
    expect(TodoCreate.parse({ title: 'x', for: 'planOwner' }).for).toBe('planOwner');
    expect(TodoCreate.safeParse({ title: 'x', for: SAM }).success).toBe(false);
    expect(TodoCreate.parse({ title: 'x', bmgOwnerSub: SAM } as never)).not.toHaveProperty(
      'bmgOwnerSub',
    );
  });
  it('needs a reason to send back, and does one thing at a time', () => {
    expect(TodoPatch.safeParse({ sendBack: { reason: '  ' } }).success).toBe(false);
    expect(TodoPatch.safeParse({ sendBack: { reason: 'Ask the venue' } }).success).toBe(true);
    expect(TodoPatch.safeParse({ sendAgain: true, makeMine: true }).success).toBe(false);
  });
  it('is sent back by the owner or an admin only', () => {
    expect(canSendBack('bmg-staff', KYRA, forKyra)).toBe(true);
    expect(canSendBack('bmg-staff', SAM, forKyra)).toBe(false);
    expect(canSendBack('bmg-admin', SAM, forKyra)).toBe(true);
    expect(canSendBack('artist', KYRA, forKyra)).toBe(false);
  });
  it('is open until done or sent back', () => {
    expect(isOpenForBmg(forKyra)).toBe(true);
    expect(isOpenForBmg({ ...forKyra, sentBack })).toBe(false);
    expect(isOpenForBmg({ ...forKyra, done: true })).toBe(false);
  });
  it('tells the owner when the artist edits it', () => {
    expect(notifyOnEdit('artist', forKyra)).toBe('bmg');
    expect(notifyOnEdit('artist', { ...forKyra, assignee: 'artist' })).toBeUndefined();
    expect(notifyOnEdit('bmg-staff', forKyra)).toBe('artist');
  });
  it('moves with the plan owner, but sent-back ones stay', () => {
    expect(movesWithOwner(forKyra, KYRA)).toBe(true);
    expect(movesWithOwner({ ...forKyra, sentBack }, KYRA)).toBe(false);
  });
});

describe('filters', () => {
  const today = '2026-11-13';
  it('keeps sent-back to-dos out of the open list, under their own filter', () => {
    const back = { ...forKyra, sentBack };
    expect(matchesFilter(back, undefined, today)).toBe(false);
    expect(matchesFilter(back, 'sent-back', today)).toBe(true);
    expect(matchesFilter(forKyra, 'sent-back', today)).toBe(false);
  });
  it('lists to-dos for Blueprint, and "for me" for the owner', () => {
    expect(matchesFilter(forKyra, 'for-bmg', today)).toBe(true);
    expect(matchesFilter(forKyra, 'own', today)).toBe(false);
    expect(matchesFilter(forKyra, 'for-me', today, KYRA)).toBe(true);
    expect(matchesFilter(forKyra, 'for-me', today, SAM)).toBe(false);
  });
});

describe('notices', () => {
  const people: Recipient[] = [
    { sub: KYRA, role: 'bmg-admin' },
    { sub: SAM, role: 'bmg-staff', assignedArtistIds: [CHLOE] },
    { sub: 'chloe', role: 'artist', artistId: CHLOE },
  ];
  const to = (r?: { to: Recipient[] }) => r?.to.map((x) => x.sub).sort();
  const created = {
    type: 'todo.forOwner' as const,
    artistId: CHLOE,
    todoId: 'abcdefghij',
    title: 'Send the stems to the mixer',
    due: '2026-11-20',
    artistName: 'Chloe Poli',
    bySub: 'chloe',
    again: false,
  };
  it('tells only the plan owner', () => {
    const p = plan({ ...created, ownerSub: SAM }, people);
    expect(to(p)).toEqual([SAM]);
    expect(p?.draft.title).toBe('Chloe Poli added a to-do for you');
    expect(p?.draft.body).toBe('“Send the stems to the mixer” · due Fri 20 Nov');
  });
  it('tells the admins when the plan has no owner', () => {
    expect(to(plan(created, people))).toEqual([KYRA]);
  });
  it('tells the artist when it is sent back or finished', () => {
    const back = plan(
      {
        type: 'todo.sentBack',
        artistId: CHLOE,
        todoId: 'abcdefghij',
        title: 'Book the rehearsal room',
        reason: 'Ask the venue directly',
        bySub: KYRA,
        byName: 'Kyra',
      },
      people,
    );
    expect(to(back)).toEqual(['chloe']);
    expect(back?.draft.title).toBe('Kyra sent back: Book the rehearsal room');
    const done = plan(
      {
        type: 'todo.finished',
        artistId: CHLOE,
        todoId: 'abcdefghij',
        title: 'Book the rehearsal room',
        bySub: KYRA,
        byName: 'Kyra',
      },
      people,
    );
    expect(done?.draft.title).toBe('Kyra finished: Book the rehearsal room');
  });
});
