/**
 * What each workspace event turns into (pure, unit-tested). The handler
 * fetches the to-do / submission / contact and sends the email this returns.
 */
import {
  feedbackGivenEmail,
  submissionUpdatedEmail,
  todoReminderEmail,
  todoUpdatedEmail,
  type BrandContext,
  type RenderedEmail,
} from '@bmg/email';

export type Role = 'artist' | 'bmg-admin' | 'bmg-staff';

export interface TodoItem {
  title: string;
  due?: string;
  dueTime?: string;
  reminder?: string;
  remindAt?: string;
  done?: boolean;
  visibility?: 'normal' | 'bmg-only';
  /** The Blueprint person looking after it (rev 12): the plan owner. */
  bmgOwnerSub?: string;
  /** Rev 15: `bmg` when the artist sent it to their plan owner. */
  assignee?: 'artist' | 'bmg';
  /** Rev 15: sent back to the artist; no reminders. */
  sentBack?: unknown;
}

export interface TodoUpdated {
  artistId: string;
  todoId: string;
  changedFields: string[];
  byRole: Role;
  notify: 'artist' | 'bmg';
}
export interface TodoReminder {
  artistId: string;
  todoId: string;
  remindAt: string;
}
export interface SubmissionUpdated {
  artistId: string;
  submissionId: string;
  priority: string;
  neededBy: string;
}
export interface FeedbackGiven {
  artistId: string;
  submissionId: string;
  todos: number;
}

const KNOWN_FIELDS = new Set(['title', 'notes', 'due', 'dueTime', 'reminder', 'done']);

export type Decision =
  { send: false; reason: string } | { send: true; to: 'artist' | 'bmg'; email: RenderedEmail };

export function onTodoUpdated(
  ctx: BrandContext,
  e: TodoUpdated,
  todo: TodoItem | undefined,
  artistName: string | undefined,
): Decision {
  if (!todo) return { send: false, reason: 'todo-missing' };
  const fields = e.changedFields.filter((f) => KNOWN_FIELDS.has(f));
  if (fields.length === 0) return { send: false, reason: 'nothing-changed' };
  if (e.notify === 'artist') {
    // BMG-only to-dos are never shown to the artist, so never emailed either.
    if (todo.visibility === 'bmg-only') return { send: false, reason: 'bmg-only' };
    if (e.byRole === 'artist') return { send: false, reason: 'own-change' };
  } else if (e.byRole !== 'artist') {
    return { send: false, reason: 'own-change' };
  }
  return {
    send: true,
    to: e.notify,
    email: todoUpdatedEmail(ctx, {
      recipient: e.notify,
      artistName,
      changedBy: e.notify === 'artist' ? 'Blueprint' : (artistName ?? 'An artist'),
      changedFields: fields,
      todo,
    }),
  };
}

export function onTodoReminder(
  ctx: BrandContext,
  e: TodoReminder,
  todo: TodoItem | undefined,
): Decision {
  if (!todo) return { send: false, reason: 'todo-missing' };
  if (todo.done) return { send: false, reason: 'done' };
  if (todo.sentBack) return { send: false, reason: 'sent-back' };
  // The to-do was edited after this schedule was made: a newer schedule exists (or none).
  if (!todo.remindAt || todo.remindAt !== e.remindAt) return { send: false, reason: 'stale' };
  // A to-do the artist sent their plan owner reminds the owner (rev 15).
  if (todo.assignee === 'bmg')
    return { send: true, to: 'bmg', email: todoReminderEmail(ctx, todo) };
  if (todo.visibility === 'bmg-only') return { send: false, reason: 'bmg-only' };
  return { send: true, to: 'artist', email: todoReminderEmail(ctx, todo) };
}

export function onSubmissionUpdated(
  ctx: BrandContext,
  e: SubmissionUpdated,
  title: string | undefined,
): Decision {
  return {
    send: true,
    to: 'artist',
    email: submissionUpdatedEmail(ctx, { title, priority: e.priority, neededBy: e.neededBy }),
  };
}

export function onFeedbackGiven(
  ctx: BrandContext,
  e: FeedbackGiven,
  title: string | undefined,
): Decision {
  return { send: true, to: 'artist', email: feedbackGivenEmail(ctx, { title, todos: e.todos }) };
}
