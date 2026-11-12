import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok } from '../src/api.ts';

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
// Far enough ahead that a 1-day reminder is still in the future in Melbourne,
// whatever the time of day (due dates are Melbourne dates, 9:00 by default).
const inThreeDays = () => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const list = async (as: 'admin' | 'artistOn') =>
  (await ok<{ todos: Todo[] }>(as, 'GET', `/artists/${artistId}/todos`)).todos;

test.beforeAll(async () => {
  artistId = await artistIdOf('artistOn');
});

test('D-01: Blueprint adds a to-do the artist can see', async () => {
  shared = await ok<Todo>('admin', 'POST', `/artists/${artistId}/todos`, {
    title: tag('shared to-do'),
    due: inThreeDays(),
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

test('D-06, D-07: the artist and Blueprint talk on the to-do', async () => {
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
});

test('D-08, D-09: the artist marks it done, and not done', async () => {
  const path = `/artists/${artistId}/todos/${shared.todoId}`;
  expect((await ok<Todo>('artistOn', 'PATCH', path, { done: true })).done).toBe(true);
  expect((await list('admin')).find((t) => t.todoId === shared.todoId)?.done).toBe(true);
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
});
