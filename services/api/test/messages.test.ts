import { describe, expect, it } from 'vitest';
import {
  access,
  artistPairId,
  canAddMembers,
  canSend,
  canShareFiles,
  decodePayload,
  encodePayload,
  NewMessage,
  previewOf,
  publicType,
  QUICK_REACTIONS,
  reactionSummary,
  UpdateMine,
  ticks,
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

describe('WhatsApp-style chat rules', () => {
  const group = (settings = {}) => ({
    type: 'group' as const,
    artistIds: [A, B],
    settings: {
      onlyAdminsSend: false,
      artistsShareFiles: true,
      artistsAddMembers: false,
      ...settings,
    },
  });
  const ann = { type: 'announcement' as const, artistIds: [A, B] };

  it('lets artists read announcements but only Blueprint post', () => {
    expect(access(artistA, ann)).toBe('read');
    expect(access(artistC, ann)).toBe('none');
    expect(canSend(artistA, ann)).toBe(false);
    expect(canSend(admin, ann)).toBe(true);
    expect(publicType('broadcast')).toBe('announcement');
  });

  it('honours group settings', () => {
    expect(canSend(artistA, group())).toBe(true);
    expect(canSend(artistA, group({ onlyAdminsSend: true }))).toBe(false);
    expect(canSend(admin, group({ onlyAdminsSend: true }))).toBe(true);
    expect(canShareFiles(artistA, group({ artistsShareFiles: false }))).toBe(false);
    expect(canAddMembers(artistA, group())).toBe(false);
    expect(canAddMembers(artistA, group({ artistsAddMembers: true }))).toBe(true);
    expect(canAddMembers(staffA, { ...group(), artistIds: [A] })).toBe(true);
    expect(canAddMembers(staffA, group())).toBe(false);
    expect(canAddMembers(artistA, ann)).toBe(false);
  });

  it('works out ticks from the other members', () => {
    const at = '2026-11-09T10:00:00.000Z';
    const later = '2026-11-09T10:05:00.000Z';
    const earlier = '2026-11-09T09:00:00.000Z';
    expect(ticks(at, [])).toBe('sent');
    expect(ticks(at, [{ lastOnlineAt: earlier }])).toBe('sent');
    expect(ticks(at, [{ lastOnlineAt: later }])).toBe('delivered');
    expect(ticks(at, [{ lastReadAt: later }, { lastOnlineAt: later }])).toBe('delivered');
    expect(ticks(at, [{ lastReadAt: later }, { lastReadAt: later }])).toBe('read');
  });

  it('round-trips the payload and still reads old plain-text messages', () => {
    const p = {
      text: 'see this',
      replyTo: { messageId: 'm1', senderName: 'Kyra', text: 'hi' },
      attachment: { kind: 'file' as const, id: 'doc_1', title: 'Rider.pdf' },
    };
    expect(decodePayload(encodePayload(p))).toEqual(p);
    expect(decodePayload('just text')).toEqual({ text: 'just text' });
    expect(previewOf({ text: '', attachment: p.attachment })).toContain('Rider.pdf');
  });

  it('needs text or an attachment', () => {
    expect(NewMessage.safeParse({ text: '' }).success).toBe(false);
    expect(
      NewMessage.safeParse({ attachment: { kind: 'todo', id: 't1', title: 'Book flights' } })
        .success,
    ).toBe(true);
  });

  it('keeps groups and announcements to Blueprint', () => {
    const req = { kind: 'group' as const, title: 'Tour', artistIds: [B, A] };
    expect(planConversation(artistA, req)).toMatchObject({ ok: false });
    expect(planConversation(admin, req)).toMatchObject({ ok: true, artistIds: [A, B] });
    expect(
      planConversation(admin, { kind: 'announcement', title: 'News', artistIds: [A] }),
    ).toMatchObject({ ok: true, type: 'announcement' });
  });
});

describe('quick reactions (rev 14)', () => {
  const at = (n: number) => `2026-11-13T10:00:0${n}.000Z`;
  const id = '3f2a8c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

  it('accepts only the four quick reactions, or null to remove', () => {
    expect(QUICK_REACTIONS).toEqual(['👍', '👎', '😊', '😢']);
    for (const emoji of [...QUICK_REACTIONS, null])
      expect(
        UpdateMine.safeParse({ react: { messageId: id, createdAt: at(1), emoji } }).success,
      ).toBe(true);
    expect(
      UpdateMine.safeParse({ react: { messageId: id, createdAt: at(1), emoji: '🔥' } }).success,
    ).toBe(false);
    expect(
      UpdateMine.safeParse({ react: { messageId: 'x', createdAt: at(1), emoji: '👍' } }).success,
    ).toBe(false);
  });

  it('groups reactions in bar order, marks mine and names who reacted', () => {
    const summary = reactionSummary(
      {
        'sub-kyra': { e: '👍', n: 'Kyra', at: at(1) },
        'sub-me': { e: '👍', n: 'Chloe', at: at(2) },
        'sub-sam': { e: '😢', n: 'Sam', at: at(3) },
      },
      'sub-me',
    );
    expect(summary).toEqual([
      { emoji: '👍', count: 2, mine: true, names: ['Kyra', 'You'] },
      { emoji: '😢', count: 1, mine: false, names: ['Sam'] },
    ]);
    expect(reactionSummary(undefined, 'sub-me')).toEqual([]);
  });
});
