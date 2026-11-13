import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { call, ok, subOf } from '../src/api.ts';

/**
 * UAT script K (rev 14): team chats are for the Blueprint people in them.
 * Uses the two Blueprint test accounts (E2E Admin, E2E Staff). Artists, and
 * admins who aren't in a team chat, can't list, read or post in it. Only the
 * E2E accounts' own chats are touched; the test group is closed at the end.
 */

test.describe.configure({ mode: 'serial' });

interface Listed {
  conversationId: string;
  team?: boolean;
  members?: { sub: string; admin: boolean }[];
}
interface Thread {
  canSend: boolean;
  messages: { text: string; mine: boolean; ticks?: string; senderName: string; kind: string }[];
}

const listed = async (as: 'admin' | 'staff' | 'artistOn') =>
  (await ok<{ conversations: Listed[] }>(as, 'GET', '/conversations')).conversations;
const thread = (as: 'admin' | 'staff', id: string) =>
  ok<Thread>(as, 'GET', `/conversations/${id}/messages`);

let directId: string;
let groupId: string;
const hello = tag('team hello');
const reply = tag('team reply');

test('K-20: two Blueprint people chat directly, with names and read ticks', async () => {
  const staffSub = await subOf('staff');
  directId = (
    await ok<{ conversationId: string }>('admin', 'POST', '/conversations', {
      kind: 'direct',
      staffSub,
    })
  ).conversationId;
  expect(directId).toMatch(/^sd-/);
  // Starting it from the other end opens the same chat.
  const again = await ok<{ conversationId: string }>('staff', 'POST', '/conversations', {
    kind: 'direct',
    staffSub: await subOf('admin'),
  });
  expect(again.conversationId).toBe(directId);

  await ok('admin', 'POST', `/conversations/${directId}/messages`, { text: hello });
  const theirs = await thread('staff', directId);
  const got = theirs.messages.find((m) => m.text === hello);
  expect(got).toBeTruthy();
  // Each person is named in team chats (artist chats still say "Blueprint").
  expect(got!.senderName).not.toBe('Blueprint');
  expect((await listed('staff')).find((c) => c.conversationId === directId)?.team).toBe(true);

  // Staff opened it above, so the admin's message now shows as read.
  const mine = (await thread('admin', directId)).messages.find((m) => m.text === hello);
  expect(mine?.ticks).toBe('read');

  await ok('staff', 'POST', `/conversations/${directId}/messages`, { text: reply });
  expect((await thread('admin', directId)).messages.some((m) => m.text === reply)).toBe(true);
});

test('K-21: artists can’t see, read, post in or start a team chat', async () => {
  test.skip(!directId, 'No team chat was made');
  expect((await listed('artistOn')).some((c) => c.conversationId === directId)).toBe(false);
  const read = await call('artistOn', 'GET', `/conversations/${directId}/messages`);
  expect(read.status).toBe(404);
  const post = await call('artistOn', 'POST', `/conversations/${directId}/messages`, {
    text: 'hi',
  });
  expect(post.status).toBe(404);
  const start = await call('artistOn', 'POST', '/conversations', {
    kind: 'direct',
    staffSub: await subOf('admin'),
  });
  expect(start.status).toBe(403);
});

test('K-22: an admin who isn’t in a team chat can’t read it', async () => {
  // Staff's "message yourself" chat has only them in it.
  const own = (
    await ok<{ conversationId: string }>('staff', 'POST', '/conversations', {
      kind: 'direct',
      staffSub: await subOf('staff'),
    })
  ).conversationId;
  await ok('staff', 'POST', `/conversations/${own}/messages`, { text: tag('note to self') });
  expect((await listed('admin')).some((c) => c.conversationId === own)).toBe(false);
  expect((await call('admin', 'GET', `/conversations/${own}/messages`)).status).toBe(404);
  expect(
    (await call('admin', 'POST', `/conversations/${own}/messages`, { text: 'hi' })).status,
  ).toBe(404);
});

test('K-23: a team group is members only, never artists', async () => {
  groupId = (
    await ok<{ conversationId: string }>('staff', 'POST', '/conversations', {
      kind: 'group',
      title: tag('team group'),
      staffSubs: [await subOf('admin')],
    })
  ).conversationId;
  expect(groupId).toMatch(/^sg-/);
  const seen = (await listed('admin')).find((c) => c.conversationId === groupId);
  expect(seen?.team).toBe(true);
  expect((await thread('admin', groupId)).messages.some((m) => m.kind === 'system')).toBe(true);

  expect((await call('artistOn', 'GET', `/conversations/${groupId}/messages`)).status).toBe(404);
  // An artist can't be added, even by their sub.
  const addArtist = await call('staff', 'POST', `/conversations/${groupId}/members`, {
    staffSubs: [await subOf('artistOn')],
  });
  expect(addArtist.status).toBe(404);
});

test('K-24: leaving hands over admin, and the last one out closes the group', async () => {
  test.skip(!groupId, 'No team group was made');
  const staffSub = await subOf('staff');
  const adminSub = await subOf('admin');
  await ok('staff', 'DELETE', `/conversations/${groupId}/members/${staffSub}`);
  expect((await call('staff', 'GET', `/conversations/${groupId}/messages`)).status).toBe(404);
  const left = (await listed('admin')).find((c) => c.conversationId === groupId);
  expect(left?.members?.find((m) => m.sub === adminSub)?.admin).toBe(true);
  await ok('admin', 'DELETE', `/conversations/${groupId}/members/${adminSub}`);
  expect((await listed('admin')).some((c) => c.conversationId === groupId)).toBe(false);
});
