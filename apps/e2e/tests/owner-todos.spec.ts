import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok, subOf } from '../src/api.ts';
import { noticeFor } from '../src/helpers.ts';

/**
 * Rev 15 and rev 18: artists send to-dos to the Blueprint person who owns
 * their plan ("Ask … to do something", "Ask for a change"). Only the owner
 * gets them, the owner can send one back, turn them off or cap them. The
 * owner's settings are E2E Admin's own and are put back at the end; every
 * to-do made here is left done.
 */

interface Todo {
  todoId: string;
  title: string;
  done: boolean;
  source: string;
  assignee: 'artist' | 'bmg';
  bmgOwnerSub: string | null;
  forName?: string;
  canSendBack?: boolean;
  sentBack: { reason: string; byName: string } | null;
}
interface Settings {
  enabled: boolean;
  maxOpenPerArtist: number;
  perArtist: Record<string, number>;
}

test.describe.configure({ mode: 'serial' });

let artistId: string;
let adminSub: string;
let before: Settings;
const made: string[] = [];
const path = (id = '') => `/artists/${artistId}/todos${id ? `/${id}` : ''}`;
const send = (title: string) =>
  call<Todo & { title?: string }>('artistOn', 'POST', path(), { title, for: 'planOwner' });
const setSettings = (s: Settings) => ok('admin', 'PATCH', '/me', { artistTodos: s });
const open = async (as: 'admin' | 'artistOn', filter?: string) =>
  (await ok<{ todos: Todo[] }>(as, 'GET', `${path()}${filter ? `?filter=${filter}` : ''}`)).todos;

test.beforeAll(async () => {
  artistId = await artistIdOf('artistOn');
  adminSub = await subOf('admin');
  // The tests need E2E Admin to own the plan (plan.spec.ts puts it back too).
  const v = await ok<{
    plan: { outcome: string; measures: unknown[]; phases: unknown[]; version: number };
    owner: { sub: string } | null;
  }>('admin', 'GET', `/artists/${artistId}/plan`);
  if (v.owner?.sub !== adminSub) {
    await ok('admin', 'PUT', `/artists/${artistId}/plan`, {
      outcome: v.plan.outcome,
      measures: v.plan.measures,
      phases: v.plan.phases,
      version: v.plan.version,
      ownerSub: adminSub,
    });
  }
  before = (await ok<{ artistTodos: Settings }>('admin', 'GET', '/me')).artistTodos;
  // Start from "on, default maximum", so earlier runs' settings can't get in the way,
  // and finish any open ones an interrupted run left, so they don't count towards it.
  await setSettings({ enabled: true, maxOpenPerArtist: 10, perArtist: {} });
  for (const t of await open('admin', 'for-bmg')) {
    if (t.title.includes('[e2e ')) await call('admin', 'PATCH', path(t.todoId), { done: true });
  }
});

test('rev 15: the plan shows who the artist’s to-dos go to', async () => {
  const v = await ok<{ ownerTodos: { to: string; enabled: boolean; max: number } | null }>(
    'artistOn',
    'GET',
    `/artists/${artistId}/plan`,
  );
  expect(v.ownerTodos).not.toBeNull();
  expect(v.ownerTodos!.to).toBe('E2E Admin');
  expect(v.ownerTodos!.enabled).toBe(true);
});

test('rev 15: an artist sends their plan owner a to-do, and only the owner gets it', async () => {
  const since = new Date().toISOString();
  const title = tag('for my plan owner');
  const res = await send(title);
  expect(res.status).toBe(201);
  const t = res.data;
  made.push(t.todoId);
  expect(t.assignee).toBe('bmg');
  expect(t.source).toBe('artist');
  expect(t.bmgOwnerSub).toBe(adminSub);
  expect(t.forName).toBe('E2E Admin');

  // "For me" on Blueprint's side, and the owner is told in the app.
  expect((await open('admin', 'for-me')).map((x) => x.todoId)).toContain(t.todoId);
  await noticeFor('admin', title, since);
  // Staff on this artist can see it, but it isn't theirs to send back.
  const staffView = (await ok<{ todos: Todo[] }>('staff', 'GET', path())).todos.find(
    (x) => x.todoId === t.todoId,
  );
  expect(staffView?.canSendBack).toBe(false);
});

test('rev 15: Blueprint can’t send itself to-dos, and artists can’t change the settings', async () => {
  const res = await call('admin', 'POST', path(), { title: tag('not allowed'), for: 'planOwner' });
  expect(res.status).toBe(400);
  const settings = await call('artistOn', 'PATCH', '/me', {
    artistTodos: { enabled: false, maxOpenPerArtist: 1, perArtist: {} },
  });
  expect(settings.status).toBe(403);
});

test('rev 15: only the owner (or an admin) sends it back, with a reason', async () => {
  const id = made[0]!;
  expect(
    (await call('staff', 'PATCH', path(id), { sendBack: { reason: 'Not mine' } })).status,
  ).toBe(403);
  expect((await call('artistOn', 'PATCH', path(id), { sendBack: { reason: 'x' } })).status).toBe(
    403,
  );
  const since = new Date().toISOString();
  const back = await ok<Todo>('admin', 'PATCH', path(id), {
    sendBack: { reason: 'Book this one yourself' },
  });
  expect(back.sentBack?.reason).toBe('Book this one yourself');
  // The artist hears about it and sees it under "Sent back"; the reason is in the thread.
  await noticeFor('artistOn', 'Book this one yourself', since);
  expect((await open('artistOn', 'sent-back')).map((x) => x.todoId)).toContain(id);
  expect((await open('artistOn')).map((x) => x.todoId)).not.toContain(id);
  const { thread } = await ok<{ thread: { text: string }[] }>(
    'artistOn',
    'GET',
    `${path(id)}/comments`,
  );
  expect(thread.some((c) => c.text.includes('Book this one yourself'))).toBe(true);
  // Sent back twice is refused.
  expect((await call('admin', 'PATCH', path(id), { sendBack: { reason: 'again' } })).status).toBe(
    409,
  );
});

test('rev 15: the artist sends it again, then keeps one as their own', async () => {
  const id = made[0]!;
  const again = await ok<Todo>('artistOn', 'PATCH', path(id), { sendAgain: true });
  expect(again.sentBack).toBeNull();
  expect(again.assignee).toBe('bmg');
  await ok('admin', 'PATCH', path(id), { sendBack: { reason: tag('second time') } });
  const mine = await ok<Todo>('artistOn', 'PATCH', path(id), { makeMine: true });
  expect(mine.assignee).toBe('artist');
  expect(mine.sentBack).toBeNull();
  expect((await open('artistOn', 'own')).map((x) => x.todoId)).toContain(id);
  // Only the artist answers a sent-back to-do.
  expect((await call('admin', 'PATCH', path(id), { makeMine: true })).status).toBe(403);
});

test('rev 15: the owner can turn them off', async () => {
  await setSettings({ enabled: false, maxOpenPerArtist: 10, perArtist: {} });
  const res = await send(tag('while off'));
  expect(res.status).toBe(409);
  expect(JSON.stringify(res.data)).toMatch(/isn.t taking to-dos/);
  const v = await ok<{ ownerTodos: { enabled: boolean } }>(
    'artistOn',
    'GET',
    `/artists/${artistId}/plan`,
  );
  expect(v.ownerTodos.enabled).toBe(false);
});

test('rev 15: a maximum for one artist caps how many are open', async () => {
  // Ten for everyone else, but only one open at a time for this artist.
  await setSettings({ enabled: true, maxOpenPerArtist: 10, perArtist: { [artistId]: 1 } });
  const first = await send(tag('within the limit'));
  expect(first.status).toBe(201);
  made.push(first.data.todoId);
  const second = await send(tag('over the limit'));
  expect(second.status).toBe(409);
  expect(JSON.stringify(second.data)).toMatch(/open to-do/);
  if (second.status === 201) made.push(second.data.todoId);

  // Once the owner finishes it, the artist can send another, and hears it's done.
  const since = new Date().toISOString();
  await ok('admin', 'PATCH', path(first.data.todoId), { done: true });
  await noticeFor('artistOn', 'within the limit', since);
  const third = await send(tag('after one was done'));
  expect(third.status).toBe(201);
  made.push(third.data.todoId);
});

test('rev 18: "Ask for a change" reaches the owner as a plan-change to-do', async () => {
  await setSettings({ enabled: true, maxOpenPerArtist: 10, perArtist: {} });
  const res = await send(`Plan change: ${tag('move the EP to March')}`);
  expect(res.status).toBe(201);
  made.push(res.data.todoId);
  expect(res.data.title.startsWith('Plan change: ')).toBe(true);
  expect((await open('admin', 'for-bmg')).map((x) => x.todoId)).toContain(res.data.todoId);
});

test.afterAll(async () => {
  for (const id of made) await call('admin', 'PATCH', path(id), { done: true });
  if (before) await call('admin', 'PATCH', '/me', { artistTodos: before });
});
