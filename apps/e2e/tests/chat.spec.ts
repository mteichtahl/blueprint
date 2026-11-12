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
