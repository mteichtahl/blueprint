import type { AppConfig } from './config.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed response body, e.g. the existing contact on a 409. */
    readonly data?: unknown,
    /** The server wants a sign-in in the last 5 minutes before this action (design 6.3). */
    readonly reauth = false,
  ) {
    super(message);
  }
}

/** Fired on `window` whenever an action is refused for want of a recent sign-in. */
export const REAUTH_EVENT = 'bmg:reauth-needed';

/** What people see instead of the server's "… needs a fresh step-up". */
export const REAUTH_MESSAGE = 'For security, sign in again, then try that again.';

/** True when the error means "sign in again, then retry" (admin actions, recovery codes). */
export function needsFreshSignIn(e: unknown): boolean {
  return e instanceof ApiError && e.reauth;
}

/** Calls the BMG API (same origin, via CloudFront) with the Cognito access token. */
export async function api<T>(
  cfg: AppConfig,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message: string = data.detail ?? data.title ?? data.message ?? 'Request failed';
    // Admin actions need a sign-in in the last 5 minutes (design 6.3). Every
    // screen gets the same plain message, and the app offers "Sign in again".
    if (res.status === 403 && /fresh step-up/i.test(message)) {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(REAUTH_EVENT));
      throw new ApiError(res.status, REAUTH_MESSAGE, data, true);
    }
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export interface Me {
  sub: string;
  role: 'bmg-admin' | 'bmg-staff' | 'artist';
  artistId: string | null;
  /** Always "Artist" for artists; Blueprint people set their own (rev 7). */
  jobTitle?: string;
  /** Profile picture as a data URL, or null when there isn't one. */
  avatar?: string | null;
  mfaLevel: 'cognito' | 'federated';
  stepUpRequired: boolean;
  consent: { termsVersion: string; aiOptIn: boolean; decidedAt: string } | null;
  /** Rev 15, Blueprint only: to-dos from artists (on/off and maximums). */
  artistTodos?: ArtistTodosSettings;
}

/** Rev 15: a Blueprint person's limits on to-dos artists send them. */
export interface ArtistTodosSettings {
  enabled: boolean;
  maxOpenPerArtist: number;
  /** A different maximum for some artists, e.g. during a release week. */
  perArtist: Record<string, number>;
}
export const MAX_OPEN_LIMIT = 50;

/** Rev 15: whether the artist can send their plan owner a to-do right now. */
export interface OwnerTodos {
  /** The owner's name, or "Blueprint" when the plan has no owner. */
  to: string;
  enabled: boolean;
  max: number;
  open: number;
  /** Why they can't send another, or null. */
  refused: string | null;
}

/** Bump when the Terms & Privacy Policy change; everyone is asked again. */
export const TERMS_VERSION = '2026-11-09';

export interface ArtistSummary {
  artistId: string;
  displayName: string;
  status: string;
  createdAt: string;
  /** Blueprint only (Artists & access): terms accepted and the current AI choice. */
  termsVersion?: string | null;
  termsAcceptedAt?: string | null;
  aiOptIn?: boolean | null;
  /** Blueprint only (rev 12): whether there's a plan, and who owns it. */
  hasPlan?: boolean;
  planOwner?: PlanOwner | null;
  planOwnerNeeded?: boolean;
}

/** A plan's Blueprint owner, or someone who could be (rev 12). */
export interface PlanOwner {
  sub: string;
  displayName: string;
  jobTitle: string;
}

export type MeasureId = 'M1' | 'M2' | 'M3' | 'M4';
export interface Milestone {
  id: string;
  title: string;
  done: boolean;
  measures: MeasureId[];
  /** Due date for the timeline (rev 7). */
  due?: string;
}
export interface Phase {
  id: string;
  name: string;
  /** Markdown. */
  goal: string;
  milestones: Milestone[];
  /** Set when the stage came from a custom stage. */
  stageId?: string;
  /** Stage dates for the timeline (rev 7). */
  start?: string;
  end?: string;
}

/** A custom stage from BMG's stage library. */
export interface CustomStage {
  stageId: string;
  name: string;
  /** Markdown. */
  goal: string;
  milestones: string[];
  appliesTo: 'all' | 'selected';
  artistIds: string[];
  createdAt: string;
  updatedAt: string | null;
}
export interface Plan {
  /** Markdown. */
  outcome: string;
  measures: { id: MeasureId; label: string }[];
  phases: Phase[];
  version: number;
  updatedAt: string;
}
export interface PlanResponse {
  plan: Plan;
  gaps: string[];
  phaseLibrary: string[];
  /** Custom stages that apply to this artist (BMG only; empty for artists). */
  stages: CustomStage[];
  exists: boolean;
  /** Rev 12: the plan's Blueprint owner (null before one is picked). */
  owner: PlanOwner | null;
  ownerSince: string | null;
  /** No owner yet, or the owner left or was unassigned (Blueprint only). */
  ownerNeeded: boolean;
  /** Blueprint only: admins and staff assigned to this artist. */
  ownerCandidates?: PlanOwner[];
  /** Blueprint only: open to-dos that would move to a new owner. */
  movableTodos?: number;
  /** Rev 15: to-dos for the plan owner (null before the plan exists). */
  ownerTodos?: OwnerTodos | null;
}

/** One saved change to a plan (rev 8): who, when and what, newest first. */
export interface PlanChange {
  changeId: string;
  /** The plan version this change produced. */
  version: number;
  at: string;
  /** `meeting`: from a meeting's suggestions; `undone`: one of those undone (rev 11); `owner`: only the owner changed (rev 12). */
  kind: 'created' | 'edited' | 'stage-added' | 'meeting' | 'undone' | 'owner';
  /** "Blueprint", or "Blueprint · <job title>". */
  byName: string;
  changes: string[];
}

/** Same limits as the API (services/api/src/workspace/model.ts). */
export const OUTCOME_MAX = 2000;
export const GOAL_MAX = 4000;

export interface Todo {
  todoId: string;
  artistId: string;
  title: string;
  notes: string | null;
  due: string | null;
  /** 'HH:MM', Blueprint's local time (Melbourne). */
  dueTime: string | null;
  reminder: Reminder | null;
  remindAt: string | null;
  /** The reminder couldn't be scheduled; saving the to-do again retries it. */
  reminderFailed: boolean;
  phaseId: string | null;
  done: boolean;
  source: 'bmg' | 'feedback' | 'artist';
  bmgOnly: boolean;
  /** Comments in the to-do's thread (rev 7). */
  commentCount?: number;
  /** Rev 15: `bmg` when the artist sent it to their plan owner. */
  assignee?: 'artist' | 'bmg';
  /** The Blueprint person looking after it (rev 12): the plan owner. */
  bmgOwnerSub?: string | null;
  /** Rev 15: who it's for, by name ("Blueprint" with no owner). */
  forName?: string;
  /** Rev 15: whether you can send it back (the owner or an admin). */
  canSendBack?: boolean;
  /** Rev 15: sent back to the artist, with why. */
  sentBack?: { reason: string; byName: string; at: string } | null;
  milestoneId?: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export type Reminder = '60m' | '1d' | '3d' | '7d';
export const REMINDER_OPTIONS: { value: '' | Reminder; label: string }[] = [
  { value: '', label: 'No reminder' },
  { value: '60m', label: '60 minutes before' },
  { value: '1d', label: '1 day before' },
  { value: '3d', label: '3 days before' },
  { value: '7d', label: '7 days before' },
];

export const TODO_FILTERS = [
  { id: '', label: 'Open' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'due-this-week', label: 'Due this week' },
  { id: 'from-bmg', label: 'From Blueprint' },
  { id: 'from-feedback', label: 'From feedback' },
  { id: 'own', label: "Artist's own" },
  // Rev 15: to-dos artists sent Blueprint.
  { id: 'for-bmg', label: 'From artists' },
  { id: 'for-me', label: 'For me' },
  { id: 'sent-back', label: 'Sent back' },
  { id: 'done', label: 'Done' },
] as const;

export type Priority = 'high' | 'medium' | 'low';
export const SUBMISSION_TYPES = [
  { id: 'demo', label: 'Demo' },
  { id: 'mix', label: 'Mix' },
  { id: 'master', label: 'Master' },
  { id: 'lyrics', label: 'Lyrics' },
  { id: 'artwork', label: 'Artwork' },
  { id: 'photo', label: 'Photo' },
  { id: 'video', label: 'Video' },
  { id: 'press', label: 'Press' },
  { id: 'social-post', label: 'Social post' },
  { id: 'other', label: 'Other' },
] as const;

export interface SubmissionSummary {
  submissionId: string;
  artistId: string;
  title: string;
  type: (typeof SUBMISSION_TYPES)[number]['id'];
  priority: Priority;
  neededBy: string;
  phaseId: string | null;
  fileIds: string[];
  /** The version of each file as it was sent (rev 8). */
  fileVersions?: Record<string, number>;
  status: 'open' | 'reviewed';
  createdAt: string;
  changedByBmgAt: string | null;
  /** When the review was completed (status `reviewed`). */
  reviewedAt: string | null;
  /** When feedback was sent; the review stays open until it's completed. */
  feedbackAt?: string | null;
  feedbackTodoIds: string[];
}

export interface SubmissionDetail extends SubmissionSummary {
  note: string;
  feedback: string | null;
}
