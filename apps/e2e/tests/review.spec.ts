import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok } from '../src/api.ts';
import { noticeFor } from '../src/helpers.ts';

/**
 * UAT script E: the artist sends something for review, Blueprint changes its
 * priority, gives feedback that becomes to-dos, and completes the review.
 * Submissions have no delete, so each run's ends reviewed (out of the open
 * queue) and its feedback to-dos are left done.
 */

interface Submission {
  submissionId: string;
  title: string;
  priority: 'high' | 'medium' | 'low';
  neededBy: string;
  status: 'open' | 'reviewed';
  artistId: string;
}

test.describe.configure({ mode: 'serial' });

let artistId: string;
let sub: Submission;
const title = tag('demo for review');
const feedbackTodos: string[] = [];
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const base = () => `/artists/${artistId}/submissions`;
const RANK = { high: 1, medium: 2, low: 3 } as const;

test.beforeAll(async () => {
  artistId = await artistIdOf('artistOn');
});

test('E-01: the artist sends something for review', async () => {
  sub = await ok<Submission>('artistOn', 'POST', base(), {
    title,
    type: 'demo',
    priority: 'high',
    neededBy: days(5),
    note: 'E2E note for Blueprint',
  });
  expect(sub.status).toBe('open');
  const theirs = await ok<{ submissions: Submission[] }>('artistOn', 'GET', base());
  expect(theirs.submissions.map((s) => s.submissionId)).toContain(sub.submissionId);
  // Blueprint reads the note on the detail page.
  const detail = await ok<{ note: string }>('admin', 'GET', `${base()}/${sub.submissionId}`);
  expect(detail.note).toBe('E2E note for Blueprint');
});

test('E-01: only artists submit, and only Blueprint completes', async () => {
  const bmg = await call('admin', 'POST', base(), {
    title: tag('from Blueprint'),
    type: 'demo',
    neededBy: days(5),
  });
  expect(bmg.status).toBe(403);
  const done = await call('artistOn', 'PATCH', `${base()}/${sub.submissionId}`, { complete: true });
  expect(done.status).toBe(403);
});

test('E-03: the review queue is sorted by priority, then needed-by date', async () => {
  const { submissions } = await ok<{ submissions: Submission[] }>('admin', 'GET', '/review-queue');
  expect(submissions.map((s) => s.submissionId)).toContain(sub.submissionId);
  for (let i = 1; i < submissions.length; i++) {
    const a = submissions[i - 1]!;
    const b = submissions[i]!;
    const inOrder =
      RANK[a.priority] < RANK[b.priority] ||
      (RANK[a.priority] === RANK[b.priority] && a.neededBy <= b.neededBy);
    expect(inOrder, `${a.priority} ${a.neededBy} before ${b.priority} ${b.neededBy}`).toBe(true);
  }
  // Staff assigned to this artist see it too; artists never see the queue.
  const staff = await ok<{ submissions: Submission[] }>('staff', 'GET', '/review-queue');
  expect(staff.submissions.map((s) => s.submissionId)).toContain(sub.submissionId);
  expect((await call('artistOn', 'GET', '/review-queue')).status).toBe(403);
});

test('E-04: Blueprint changes the priority and date, and the artist is told', async () => {
  const since = new Date().toISOString();
  const changed = await ok<Submission>('admin', 'PATCH', `${base()}/${sub.submissionId}`, {
    priority: 'medium',
    neededBy: days(9),
  });
  expect(changed.priority).toBe('medium');
  expect(changed.neededBy).toBe(days(9));
  await noticeFor('artistOn', title, since);
  // The title and note stay the artist's.
  const rename = await call('admin', 'PATCH', `${base()}/${sub.submissionId}`, { title: 'x' });
  expect(rename.status).toBe(409);
});

test('E-05: feedback with three action points makes three to-dos for the artist', async () => {
  const since = new Date().toISOString();
  const points = [1, 2, 3].map((n) => ({ title: tag(`feedback point ${n}`) }));
  await ok('admin', 'POST', `${base()}/${sub.submissionId}/feedback`, {
    comment: 'E2E feedback',
    points,
  });
  const { todos } = await ok<{ todos: { todoId: string; title: string; source: string }[] }>(
    'artistOn',
    'GET',
    `/artists/${artistId}/todos?filter=from-feedback`,
  );
  const mine = todos.filter((t) => points.some((p) => p.title === t.title));
  expect(mine).toHaveLength(3);
  expect(mine.every((t) => t.source === 'feedback')).toBe(true);
  feedbackTodos.push(...mine.map((t) => t.todoId));
  await noticeFor('artistOn', title, since);
  // The artist reads the feedback on their submission.
  const detail = await ok<{ feedback: string }>('artistOn', 'GET', `${base()}/${sub.submissionId}`);
  expect(detail.feedback).toBe('E2E feedback');
  // Feedback is given once.
  const again = await call('admin', 'POST', `${base()}/${sub.submissionId}/feedback`, {
    comment: 'again',
  });
  expect(again.status).toBe(409);
});

test('completing the review moves it out of the open queue', async () => {
  const done = await ok<Submission>('admin', 'PATCH', `${base()}/${sub.submissionId}`, {
    complete: true,
  });
  expect(done.status).toBe('reviewed');
  const open = await ok<{ submissions: Submission[] }>('admin', 'GET', '/review-queue');
  expect(open.submissions.map((s) => s.submissionId)).not.toContain(sub.submissionId);
  const reviewed = await ok<{ submissions: Submission[] }>(
    'admin',
    'GET',
    '/review-queue?status=reviewed',
  );
  expect(reviewed.submissions.map((s) => s.submissionId)).toContain(sub.submissionId);
  // A reviewed submission can't be changed any more.
  const late = await call('artistOn', 'PATCH', `${base()}/${sub.submissionId}`, { title: 'late' });
  expect(late.status).toBe(409);
});

test('another artist can’t open the submission', async () => {
  const res = await call('artistOther', 'GET', `${base()}/${sub.submissionId}`);
  expect([403, 404]).toContain(res.status);
});

test.afterAll(async () => {
  if (sub?.status === 'open')
    await call('admin', 'PATCH', `${base()}/${sub.submissionId}`, { complete: true });
  for (const id of feedbackTodos)
    await call('artistOn', 'PATCH', `/artists/${artistId}/todos/${id}`, { done: true });
});
