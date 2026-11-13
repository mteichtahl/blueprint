/** Team chats: each member's own copy of the chat key (decided 13 Nov 2026). */
import { describe, expect, it } from 'vitest';
import {
  staffWrapName,
  teamKeySource,
  wrapContext,
  wrapsUpdate,
  type Viewer,
} from '../src/messages/model.ts';
import { staffWrapContext } from '@bmg/crypto';

const KYRA = '11111111-1111-4111-8111-111111111111';
const SAM = '22222222-2222-4222-8222-222222222222';
const JO = '33333333-3333-4333-8333-333333333333';
const blob = new Uint8Array([1, 2, 3]);
const kyra: Viewer = { role: 'bmg-admin', sub: KYRA };
const sam: Viewer = { role: 'bmg-staff', sub: SAM };
const jo: Viewer = { role: 'bmg-admin', sub: JO };
const base = { type: 'staff-group' as const, artistIds: [], staffSubs: [KYRA, SAM] };

describe('which copy of a team chat key someone opens', () => {
  it('opens your own copy, and only yours', () => {
    const c = { ...base, keyWraps: { [staffWrapName(KYRA)]: blob, [staffWrapName(SAM)]: blob } };
    expect(teamKeySource(kyra, c)).toBe('own');
    expect(teamKeySource(sam, c)).toBe('own');
    // An admin who isn't in it gets nothing, even with copies lying around.
    expect(teamKeySource(jo, c)).toBe('none');
    expect(teamKeySource({ role: 'artist', artistId: 'art_aaaaaaaaaaaa', sub: KYRA }, c)).toBe(
      'none',
    );
  });
  it('moves a chat made before per-person keys, for a member only', () => {
    const old = { ...base, keyWraps: { platform: blob } };
    expect(teamKeySource(kyra, old)).toBe('move');
    expect(teamKeySource(jo, old)).toBe('none');
  });
  it('gives a member without a copy nothing once the chat has moved', () => {
    const moved = { ...base, keyWraps: { [staffWrapName(SAM)]: blob } };
    expect(teamKeySource(kyra, moved)).toBe('none');
  });
  it('never applies to chats with artists', () => {
    expect(teamKeySource(kyra, { type: 'bmg-artist', artistIds: [], keyWraps: {} })).toBe('none');
  });
});

describe('storing members’ copies', () => {
  it('sets each copy under keyWraps by name', () => {
    const u = wrapsUpdate({ [staffWrapName(KYRA)]: blob, [staffWrapName(SAM)]: blob });
    expect(u.sets).toEqual(['#kw.#w0 = :w0', '#kw.#w1 = :w1']);
    expect(u.names).toEqual({
      '#kw': 'keyWraps',
      '#w0': `staff:${KYRA}`,
      '#w1': `staff:${SAM}`,
    });
    expect(Object.keys(u.values)).toEqual([':w0', ':w1']);
  });
});

describe('encryption contexts', () => {
  it('binds each copy to its owner and the chat, unlike the old platform copy', () => {
    expect(staffWrapContext(SAM, 'sg-x')).toEqual({
      staffSub: SAM,
      purpose: 'staff-conversation',
      conversationId: 'sg-x',
    });
    expect(wrapContext('sg-x', undefined, 'staff-group')).toEqual({
      purpose: 'staff-conversation',
      conversationId: 'sg-x',
    });
    expect(() => staffWrapContext('not-a-sub', 'sg-x')).toThrow();
  });
});
