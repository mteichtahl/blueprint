import { describe, expect, it } from 'vitest';
import {
  access,
  artistPairId,
  channelsFor,
  CONVERSATION_ID_PATTERN,
  members,
  newConversationKey,
  open,
  planConversation,
  seal,
  wrapContext,
  type Viewer,
} from '../src/messages/model.ts';

const A = 'art_aaaaaaaaaaaa';
const B = 'art_bbbbbbbbbbbb';
const C = 'art_cccccccccccc';
const admin: Viewer = { role: 'bmg-admin' };
const staffA: Viewer = { role: 'bmg-staff', assignedArtistIds: [A] };
const artistA: Viewer = { role: 'artist', artistId: A };
const artistC: Viewer = { role: 'artist', artistId: C };

describe('who can see a conversation', () => {
  const dmA = { type: 'bmg-artist' as const, artistIds: [A] };
  const group = { type: 'group' as const, artistIds: [A, B] };
  const pair = { type: 'artist-to-artist' as const, artistIds: [A, B] };
  const broadcast = { type: 'broadcast' as const, artistIds: [] };

  it('keeps artist-to-artist chats private to their two artists', () => {
    expect(access(artistA, pair)).toBe('read-write');
    expect(access(artistC, pair)).toBe('none');
    expect(access(admin, pair)).toBe('none');
    expect(access(staffA, pair)).toBe('none');
  });
  it('lets artists read the broadcast but not post', () => {
    expect(access(artistA, broadcast)).toBe('read');
    expect(access(admin, broadcast)).toBe('read-write');
  });
  it('limits staff to chats whose artists are all assigned to them', () => {
    expect(access(staffA, dmA)).toBe('read-write');
    expect(access(staffA, group)).toBe('none');
    expect(access(admin, group)).toBe('read-write');
    expect(access(artistC, group)).toBe('none');
  });
  it('never puts Blueprint in an artist-to-artist inbox or channel', () => {
    expect(members(pair)).toEqual([`ARTIST#${A}`, `ARTIST#${B}`]);
    expect(channelsFor(pair)).not.toContain('/inbox/bmg');
    expect(channelsFor(dmA)).toContain('/inbox/bmg');
  });
});

describe('starting conversations', () => {
  it('gives two artists one shared chat whoever starts it', () => {
    expect(artistPairId(A, B)).toBe(artistPairId(B, A));
    const p = planConversation(artistA, { kind: 'direct', artistId: B });
    expect(p).toMatchObject({ ok: true, type: 'artist-to-artist', artistIds: [A, B] });
    if (p.ok) expect(CONVERSATION_ID_PATTERN.test(p.conversationId)).toBe(true);
  });
  it('gives an artist their chat with Blueprint', () => {
    expect(planConversation(artistA, { kind: 'direct' })).toMatchObject({
      ok: true,
      conversationId: `dm-${A}`,
      type: 'bmg-artist',
    });
  });
  it('keeps groups for Blueprint', () => {
    expect(planConversation(artistA, { kind: 'group', title: 'x', artistIds: [B] }).ok).toBe(false);
    expect(
      planConversation(admin, { kind: 'group', title: 'Mixer', artistIds: [B, A, A] }),
    ).toMatchObject({
      ok: true,
      artistIds: [A, B],
    });
  });
});

describe('sealing', () => {
  it('round-trips and binds each message to its conversation and id', () => {
    const key = newConversationKey();
    const blob = seal(key, 'Should I apply for Seven Sisters?', 'dm-x', 'm1');
    expect(open(key, blob, 'dm-x', 'm1')).toBe('Should I apply for Seven Sisters?');
    expect(() => open(key, blob, 'dm-y', 'm1')).toThrow();
    expect(() => open(key, blob, 'dm-x', 'm2')).toThrow();
    expect(() => open(newConversationKey(), blob, 'dm-x', 'm1')).toThrow();
  });
  it('wraps artist-to-artist keys as private so KMS refuses BMG roles', () => {
    expect(wrapContext('aa-x', A)).toEqual({
      artistId: A,
      visibility: 'private',
      conversationId: 'aa-x',
    });
    expect(wrapContext('dm-x')).not.toHaveProperty('artistId');
  });
});
