import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok } from '../src/api.ts';

/**
 * UAT script K: chats between two artists are private to them. Blueprint
 * can't list, read or post in them.
 */

test.describe.configure({ mode: 'serial' });

let conversationId: string;
const text = tag('private artist message');

test('K-10: two artists chat directly', async () => {
  const settings = await ok<{ artistDirectChats: boolean }>('admin', 'GET', '/access/settings');
  test.skip(
    !settings.artistDirectChats,
    'Artist-to-artist chats are turned off in Access & permissions',
  );

  const res = await ok<{ conversationId: string }>('artistOn', 'POST', '/conversations', {
    kind: 'direct',
    artistId: await artistIdOf('artistOther'),
  });
  conversationId = res.conversationId;
  await ok('artistOn', 'POST', `/conversations/${conversationId}/messages`, { text });
  const theirs = await ok('artistOther', 'GET', `/conversations/${conversationId}/messages`);
  expect(JSON.stringify(theirs)).toContain(text);
});

test('K-11: Blueprint can’t see or join the artists’ chat', async () => {
  test.skip(!conversationId, 'No artist-to-artist chat was made');
  const list = await ok('admin', 'GET', '/conversations');
  expect(JSON.stringify(list)).not.toContain(conversationId);
  for (const as of ['admin', 'staff'] as const) {
    const read = await call(as, 'GET', `/conversations/${conversationId}/messages`);
    expect([403, 404]).toContain(read.status);
    const post = await call(as, 'POST', `/conversations/${conversationId}/messages`, {
      text: 'hi',
    });
    expect([403, 404]).toContain(post.status);
  }
});

test('a third person can’t read it either', async () => {
  test.skip(!conversationId, 'No artist-to-artist chat was made');
  const read = await call('artistOff', 'GET', `/conversations/${conversationId}/messages`);
  expect([403, 404]).toContain(read.status);
});

test('O-03: with artist-to-artist chats off, the server refuses to start one', async () => {
  const settings = await ok<{ artistDirectChats: boolean }>('admin', 'GET', '/access/settings');
  test.skip(settings.artistDirectChats, 'Artist-to-artist chats are on (K-10 covers that)');
  const res = await call('artistOn', 'POST', '/conversations', {
    kind: 'direct',
    artistId: await artistIdOf('artistOther'),
  });
  expect(res.status).toBe(403);
});

// ── Blueprint ↔ artist (UAT K-02 to K-04, rev 14 reactions) ───────────────
// Only Blueprint posts here, so the real Blueprint team isn't notified of test messages.

interface Message {
  messageId: string;
  createdAt: string;
  text: string;
  kind: string;
  mine: boolean;
  ticks?: 'sent' | 'delivered' | 'read';
  replyTo: { messageId: string; text: string; senderName: string } | null;
  reactions: { emoji: string; count: number; mine: boolean; names: string[] }[];
}
interface Thread {
  canSend: boolean;
  messages: Message[];
}
const thread = (as: 'admin' | 'artistOn' | 'artistOff' | 'artistOther', id: string) =>
  ok<Thread>(as, 'GET', `/conversations/${id}/messages`);
const listedIds = async (as: 'admin' | 'artistOn' | 'artistOff' | 'artistOther') =>
  (
    await ok<{ conversations: { conversationId: string }[] }>(as, 'GET', '/conversations')
  ).conversations.map((c) => c.conversationId);

let dmId: string;
let first: Message;

test('K-03: ticks turn to read once the artist opens the chat', async () => {
  dmId = (
    await ok<{ conversationId: string }>('admin', 'POST', '/conversations', {
      kind: 'direct',
      artistId: await artistIdOf('artistOn'),
    })
  ).conversationId;
  const text = tag('ticks');
  await ok('admin', 'POST', `/conversations/${dmId}/messages`, { text });
  first = (await thread('admin', dmId)).messages.find((m) => m.text === text)!;
  expect(first.mine).toBe(true);
  expect((await thread('artistOn', dmId)).messages.some((m) => m.text === text)).toBe(true);
  const after = (await thread('admin', dmId)).messages.find((m) => m.messageId === first.messageId);
  expect(after?.ticks).toBe('read');
});

test('K-04: a reply carries a quote of the message it answers', async () => {
  test.skip(!first, 'No message to reply to');
  const text = tag('reply with quote');
  await ok('admin', 'POST', `/conversations/${dmId}/messages`, {
    text,
    replyTo: { messageId: first.messageId },
  });
  const got = (await thread('artistOn', dmId)).messages.find((m) => m.text === text);
  expect(got?.replyTo?.messageId).toBe(first.messageId);
  expect(got?.replyTo?.text).toBe(first.text);
});

test('rev 14: one quick reaction per person, seen by both sides, and taken back', async () => {
  test.skip(!first, 'No message to react to');
  const react = (emoji: string | null) =>
    ok<{ reactions: Message['reactions'] }>('artistOn', 'PATCH', `/conversations/${dmId}/me`, {
      react: { messageId: first.messageId, createdAt: first.createdAt, emoji },
    });
  const thumbs = await react('👍');
  expect(thumbs.reactions).toEqual([
    expect.objectContaining({ emoji: '👍', count: 1, mine: true }),
  ]);
  // Changing it replaces it: still one reaction from this person.
  const smile = await react('😊');
  expect(smile.reactions.map((r) => r.emoji)).toEqual(['😊']);
  const seen = (await thread('admin', dmId)).messages.find((m) => m.messageId === first.messageId);
  expect(seen?.reactions).toEqual([
    expect.objectContaining({ emoji: '😊', count: 1, mine: false }),
  ]);
  // Only the four quick reactions.
  const odd = await call('artistOn', 'PATCH', `/conversations/${dmId}/me`, {
    react: { messageId: first.messageId, createdAt: first.createdAt, emoji: '🎸' },
  });
  expect(odd.status).toBe(400);
  expect((await react(null)).reactions).toEqual([]);
});

test('K-02: pin and mute are each person’s own', async () => {
  test.skip(!dmId, 'No chat was made');
  const set = await ok<{ pinned: boolean; muted: boolean }>(
    'admin',
    'PATCH',
    `/conversations/${dmId}/me`,
    { pinned: true, muted: true },
  );
  expect(set).toMatchObject({ pinned: true, muted: true });
  const back = await ok<{ pinned: boolean; muted: boolean }>(
    'admin',
    'PATCH',
    `/conversations/${dmId}/me`,
    { pinned: false, muted: false },
  );
  expect(back).toMatchObject({ pinned: false, muted: false });
});

// ── Groups and announcements (UAT K-07 to K-09, K-12, K-13) ───────────────

let groupId: string;

test('K-07: Blueprint makes a group; its members see it, other artists don’t', async () => {
  groupId = (
    await ok<{ conversationId: string }>('admin', 'POST', '/conversations', {
      kind: 'group',
      title: tag('group'),
      artistIds: [await artistIdOf('artistOn'), await artistIdOf('artistOff')],
    })
  ).conversationId;
  expect(await listedIds('artistOn')).toContain(groupId);
  expect(await listedIds('artistOff')).toContain(groupId);
  const t = await thread('artistOn', groupId);
  expect(t.messages.some((m) => m.kind === 'system' && /created this group/.test(m.text))).toBe(
    true,
  );
  expect(await listedIds('artistOther')).not.toContain(groupId);
  expect([403, 404]).toContain(
    (await call('artistOther', 'GET', `/conversations/${groupId}/messages`)).status,
  );
});

test('K-12: with "Only admins can send messages" on, artists can read but not post', async () => {
  test.skip(!groupId, 'No group was made');
  await ok('admin', 'PATCH', `/conversations/${groupId}`, {
    settings: { onlyAdminsSend: true, artistsShareFiles: false, artistsAddMembers: false },
  });
  const t = await thread('artistOn', groupId);
  expect(t.canSend).toBe(false);
  const post = await call('artistOn', 'POST', `/conversations/${groupId}/messages`, { text: 'hi' });
  expect(post.status).toBe(403);
  // Artists can't change the group's settings either.
  const change = await call('artistOn', 'PATCH', `/conversations/${groupId}`, { title: 'x' });
  expect(change.status).toBe(403);
  await ok('admin', 'POST', `/conversations/${groupId}/messages`, { text: tag('admins only') });
});

test('K-13: deleting the group removes it for its members', async () => {
  test.skip(!groupId, 'No group was made');
  // Only a Blueprint admin deletes a group. (E2E Staff isn't assigned to every
  // artist in it, so for them the group doesn't exist: 404.)
  expect([403, 404]).toContain((await call('staff', 'DELETE', `/conversations/${groupId}`)).status);
  await ok('admin', 'DELETE', `/conversations/${groupId}`);
  expect(await listedIds('artistOn')).not.toContain(groupId);
  expect([403, 404]).toContain(
    (await call('artistOn', 'GET', `/conversations/${groupId}/messages`)).status,
  );
  groupId = '';
});

test('K-08: only Blueprint posts in an announcement list', async () => {
  const id = (
    await ok<{ conversationId: string }>('admin', 'POST', '/conversations', {
      kind: 'announcement',
      title: tag('announcement'),
      artistIds: [await artistIdOf('artistOn')],
    })
  ).conversationId;
  try {
    const text = tag('announced');
    await ok('admin', 'POST', `/conversations/${id}/messages`, { text });
    const t = await thread('artistOn', id);
    expect(t.messages.some((m) => m.text === text)).toBe(true);
    expect(t.canSend).toBe(false);
    const post = await call('artistOn', 'POST', `/conversations/${id}/messages`, { text: 'hi' });
    expect(post.status).toBe(403);
    expect(JSON.stringify(post.data)).toMatch(/Reply privately/);
  } finally {
    await call('admin', 'DELETE', `/conversations/${id}`);
  }
});

test('K-09: with artist groups off, an artist can’t start a group', async () => {
  const settings = await ok<{ artistGroups: boolean }>('admin', 'GET', '/access/settings');
  test.skip(settings.artistGroups, 'Artists may start groups in Access & permissions');
  const res = await call('artistOn', 'POST', '/conversations', {
    kind: 'group',
    title: tag('artist group'),
    artistIds: [await artistIdOf('artistOther')],
  });
  expect(res.status).toBe(403);
});

test.afterAll(async () => {
  if (groupId) await call('admin', 'DELETE', `/conversations/${groupId}`);
});
