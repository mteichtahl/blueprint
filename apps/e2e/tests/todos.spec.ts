import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok } from '../src/api.ts';
import { noticeFor } from '../src/helpers.ts';

/**
 * UAT script D: to-dos shared between Blueprint and the artist, their threads,
 * and BMG-only to-dos. To-dos have no delete, so each run's are left done.
 */

interface Todo {
  todoId: string;
  title: string;
  done: boolean;
  bmgOnly: boolean;
  commentCount: number;
}

test.describe.configure({ mode: 'serial' });

let artistId: string;
let shared: Todo;
let bmgOnly: Todo;
const extra: string[] = [];
// A week out, so a "1 day before" reminder is still ahead whatever time the run starts.
const nextWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
/** Open to-dos by default; done ones only with `?filter=done` (as on the screens). */
const list = async (as: 'admin' | 'artistOn', filter?: string) =>
  (
    await ok<{ todos: Todo[] }>(
      as,
      'GET',
      `/artists/${artistId}/todos${filter ? `?filter=${filter}` : ''}`,
    )
  ).todos;

test.beforeAll(async () => {
  artistId = await artistIdOf('artistOn');
});

test('D-01: Blueprint adds a to-do the artist can see', async () => {
  shared = await ok<Todo>('admin', 'POST', `/artists/${artistId}/todos`, {
    title: tag('shared to-do'),
    due: nextWeek(),
    reminder: '1d',
  });
  expect(shared.bmgOnly).toBe(false);
  expect((await list('artistOn')).map((t) => t.todoId)).toContain(shared.todoId);
});

test('D-12: a BMG-only to-do stays hidden from the artist', async () => {
  bmgOnly = await ok<Todo>('admin', 'POST', `/artists/${artistId}/todos`, {
    title: tag('BMG-only to-do'),
    bmgOnly: true,
  });
  expect(bmgOnly.bmgOnly).toBe(true);
  expect((await list('admin')).map((t) => t.todoId)).toContain(bmgOnly.todoId);
  expect((await list('artistOn')).map((t) => t.todoId)).not.toContain(bmgOnly.todoId);
  const direct = await call(
    'artistOn',
    'GET',
    `/artists/${artistId}/todos/${bmgOnly.todoId}/comments`,
  );
  expect([403, 404]).toContain(direct.status);
});

test('D-06, D-07: the artist and Blueprint talk on the to-do, and each is told', async () => {
  const since = new Date().toISOString();
  const path = `/artists/${artistId}/todos/${shared.todoId}/comments`;
  const mine = await ok<{ commentId: string }>('artistOn', 'POST', path, {
    text: 'Started on this',
  });
  await ok('admin', 'POST', path, { text: 'Thanks!', parentId: mine.commentId });
  const { thread } = await ok<{ thread: { commentId: string; replies: unknown[] }[] }>(
    'admin',
    'GET',
    path,
  );
  const first = thread.find((c) => c.commentId === mine.commentId);
  expect(first?.replies).toHaveLength(1);
  // The bell: Blueprint hears from the artist, the artist from Blueprint.
  await noticeFor('admin', shared.title, since);
  await noticeFor('artistOn', shared.title, since);
});

test('D-07: people remove only their own comments', async () => {
  const path = `/artists/${artistId}/todos/${shared.todoId}/comments`;
  const bmg = await ok<{ commentId: string }>('admin', 'POST', path, { text: tag('to remove') });
  expect((await call('artistOn', 'DELETE', `${path}/${bmg.commentId}`)).status).toBe(403);
  await ok('admin', 'DELETE', `${path}/${bmg.commentId}`);
  const { thread } = await ok<{ thread: { commentId: string; text: string }[] }>(
    'artistOn',
    'GET',
    path,
  );
  expect(thread.some((c) => c.text === tag('to remove'))).toBe(false);
});

test('D-04: Edit details changes the due date and time', async () => {
  const path = `/artists/${artistId}/todos/${shared.todoId}`;
  const due = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
  const edited = await ok<Todo & { due: string; dueTime: string }>('admin', 'PATCH', path, {
    due,
    dueTime: '10:00',
  });
  expect(edited.due).toBe(due);
  expect(edited.dueTime).toBe('10:00');
  // A due time without a date isn't kept.
  const cleared = await ok<Todo & { due: string | null; dueTime: string | null }>(
    'admin',
    'PATCH',
    path,
    { due: null },
  );
  expect(cleared.due).toBeNull();
  expect(cleared.dueTime).toBeNull();
});

test('D-11: the quick filters sort to-dos by who they came from and when they’re due', async () => {
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const own = await ok<Todo>('artistOn', 'POST', `/artists/${artistId}/todos`, {
    title: tag('artist’s own to-do'),
    due: soon,
  });
  extra.push(own.todoId);
  const idsFor = async (as: 'admin' | 'artistOn', filter: string) =>
    (await list(as, filter)).map((t) => t.todoId);
  expect(await idsFor('artistOn', 'own')).toContain(own.todoId);
  expect(await idsFor('admin', 'from-bmg')).not.toContain(own.todoId);
  expect(await idsFor('admin', 'from-bmg')).toContain(shared.todoId);
  expect(await idsFor('admin', 'due-this-week')).toContain(own.todoId);
  // "All artist to-dos" across artists, for Blueprint only.
  const all = await ok<{ todos: Todo[] }>('staff', 'GET', `/todos?artistId=${artistId}`);
  expect(all.todos.map((t) => t.todoId)).toContain(own.todoId);
  expect((await call('artistOn', 'GET', '/todos')).status).toBe(403);
});

test('D-08, D-09: the artist marks it done, and not done', async () => {
  const path = `/artists/${artistId}/todos/${shared.todoId}`;
  expect((await ok<Todo>('artistOn', 'PATCH', path, { done: true })).done).toBe(true);
  // Blueprint sees it move from the open list to the done list.
  expect((await list('admin')).map((t) => t.todoId)).not.toContain(shared.todoId);
  expect((await list('admin', 'done')).find((t) => t.todoId === shared.todoId)?.done).toBe(true);
  expect((await ok<Todo>('artistOn', 'PATCH', path, { done: false })).done).toBe(false);
  await ok('artistOn', 'PATCH', path, { done: true });
});

test('artists can’t make a to-do BMG-only', async () => {
  const res = await call('artistOn', 'PATCH', `/artists/${artistId}/todos/${shared.todoId}`, {
    bmgOnly: true,
  });
  expect([400, 403]).toContain(res.status);
});

test.afterAll(async () => {
  if (bmgOnly)
    await call('admin', 'PATCH', `/artists/${artistId}/todos/${bmgOnly.todoId}`, { done: true });
  for (const id of extra)
    await call('artistOn', 'PATCH', `/artists/${artistId}/todos/${id}`, { done: true });
});
