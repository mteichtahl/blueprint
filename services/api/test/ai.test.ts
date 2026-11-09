import type { Principal } from '@bmg/authz';
import { actionsHash, type Action } from '@bmg/prompts/actions';
import { describe, expect, it } from 'vitest';
import {
  aiCanRead,
  canUseAssistant,
  checkClaims,
  decodeToken,
  encodeToken,
  workspaceDigest,
} from '../src/ai/model.ts';
import { stepsFor } from '../src/handlers/ai-actions.ts';
import type { Gig } from '../src/events/model.ts';
import type { Todo } from '../src/workspace/model.ts';

const A = 'art_aaaaaaaaaaaa';
const B = 'art_bbbbbbbbbbbb';
const base = { mfaSatisfied: true, secondsSinceAuth: 10 };
const artistA: Principal = { sub: 'u-a', role: 'artist', artistId: A, ...base };
const staffA: Principal = { sub: 'u-s', role: 'bmg-staff', assignedArtistIds: [A], ...base };
const admin: Principal = { sub: 'u-x', role: 'bmg-admin', ...base };

describe('who the assistant serves', () => {
  it('artists only once opted in; Blueprint always', () => {
    expect(canUseAssistant(artistA, false)).toMatch(/turn it on in Profile/);
    expect(canUseAssistant(artistA, true)).toBeUndefined();
    expect(canUseAssistant(admin, false)).toBeUndefined();
    expect(canUseAssistant({ ...admin, mfaSatisfied: false }, true)).toMatch(/two-step/);
  });

  it('an opted-out artist is invisible, whoever asks', () => {
    expect(aiCanRead(admin, A, false)).toMatchObject({ ok: false, reason: /isn't using AI/ });
    expect(aiCanRead(admin, A, true)).toEqual({ ok: true });
  });

  it("artists can't reach another artist; staff only their own artists", () => {
    expect(aiCanRead(artistA, B, true)).toMatchObject({ ok: false });
    expect(aiCanRead(artistA, A, true)).toEqual({ ok: true });
    expect(aiCanRead(staffA, B, true)).toMatchObject({ ok: false, reason: /assigned/ });
  });
});

describe('workspace digest', () => {
  const todo = (over: Partial<Todo>): Todo =>
    ({
      todoId: 't',
      artistId: A,
      title: 'x',
      done: false,
      source: 'bmg',
      visibility: 'normal',
      createdBy: 'u',
      createdAt: '',
      ...over,
    }) as Todo;
  const gig = (over: Partial<Gig>): Gig =>
    ({
      gigId: 'g',
      artistId: A,
      title: 'Show',
      date: '2026-12-01',
      status: 'confirmed',
      deal: 'free',
      checklist: [],
      plannedBy: 'artist',
      shared: true,
      createdBy: 'u',
      createdAt: '',
      ...over,
    }) as Gig;

  it('hides BMG-only to-dos from artists and private gigs from Blueprint', () => {
    const input = {
      artistName: 'Chloe',
      todos: [
        todo({ title: 'Open' }),
        todo({ title: 'Secret', visibility: 'bmg-only' }),
        todo({ title: 'Done', done: true }),
      ],
      gigs: [
        gig({ title: 'Shared' }),
        gig({ title: 'Private', shared: false }),
        gig({ title: 'Past', date: '2026-01-01' }),
      ],
      submissions: [],
    };
    const forArtist = workspaceDigest(input, 'artist', '2026-11-09');
    expect(forArtist.openTodos.map((t) => t.title)).toEqual(['Open']);
    expect(forArtist.upcomingGigs.map((g) => g.title)).toEqual(['Shared', 'Private']);
    const forBmg = workspaceDigest(input, 'bmg-admin', '2026-11-09');
    expect(forBmg.openTodos.map((t) => t.title)).toEqual(['Open', 'Secret']);
    expect(forBmg.upcomingGigs.map((g) => g.title)).toEqual(['Shared']);
  });
});

describe('action tokens', () => {
  const actions: Action[] = [
    { type: 'createTodo', summary: 'Add a to-do', artistId: A, title: 'Send the pitch' },
  ];
  const claims = {
    sub: 'u-a',
    sid: 'sabcdefgh1',
    h: actionsHash(actions),
    exp: 1000,
    jti: 'a'.repeat(32),
  };

  it('round-trips and rejects tampering', () => {
    const token = encodeToken(claims, new Uint8Array([1, 2, 3]));
    expect(decodeToken(token)).toEqual({ claims, mac: new Uint8Array([1, 2, 3]) });
    expect(decodeToken(`${token}.x`)).toBeUndefined();
    expect(decodeToken('nope')).toBeUndefined();
  });

  it('is bound to the person, the exact checklist and 60 seconds', () => {
    const ok = { sub: 'u-a', hash: actionsHash(actions), nowSeconds: 999 };
    expect(checkClaims(claims, ok)).toBeUndefined();
    expect(checkClaims(claims, { ...ok, sub: 'u-b' })).toMatch(/someone else/);
    const changed = actionsHash([{ ...actions[0]!, title: 'Delete everything' } as Action]);
    expect(checkClaims(claims, { ...ok, hash: changed })).toMatch(/changed/);
    expect(checkClaims(claims, { ...ok, nowSeconds: 1001 })).toMatch(/expired/);
  });

  it('hashes the same checklist the same way whatever the key order', () => {
    const reordered = [
      { title: 'Send the pitch', artistId: A, summary: 'Add a to-do', type: 'createTodo' },
    ] as Action[];
    expect(actionsHash(reordered)).toBe(actionsHash(actions));
  });
});

describe('carrying out actions', () => {
  it('uses the normal API routes', () => {
    expect(
      stepsFor(
        { type: 'createTodo', summary: 's', artistId: A, title: 'T', due: '2026-12-01' },
        'bmg-admin',
      ),
    ).toEqual([
      { method: 'POST', path: `/artists/${A}/todos`, body: { title: 'T', due: '2026-12-01' } },
    ]);
    const msg = stepsFor({ type: 'sendMessage', summary: 's', text: 'Hi' }, 'artist');
    expect(msg[0]).toEqual({ method: 'POST', path: '/conversations', body: { kind: 'direct' } });
    expect(msg[1]!.path).toBe('/conversations/{conversationId}/messages');
  });
});

describe('conversation ids', () => {
  it('are random, unguessable and match the accepted format', async () => {
    const { sessionId, SessionId } = await import('../src/ai/model.ts');
    const a = sessionId();
    expect(SessionId.safeParse(a).success).toBe(true);
    expect(a).toMatch(/^s[0-9a-f]{24}$/);
    expect(sessionId()).not.toBe(a);
  });
});
