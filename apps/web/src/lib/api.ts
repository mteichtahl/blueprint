import type { AppConfig } from './config.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed response body, e.g. the existing contact on a 409. */
    readonly data?: unknown,
  ) {
    super(message);
  }
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
  if (!res.ok)
    throw new ApiError(
      res.status,
      data.detail ?? data.title ?? data.message ?? 'Request failed',
      data,
    );
  return data as T;
}

export interface Me {
  sub: string;
  role: 'bmg-admin' | 'bmg-staff' | 'artist';
  artistId: string | null;
  /** Always "Artist" for artists; Blueprint people set their own (rev 7). */
  jobTitle?: string;
  mfaLevel: 'cognito' | 'federated';
  stepUpRequired: boolean;
  consent: { termsVersion: string; aiOptIn: boolean; decidedAt: string } | null;
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
  status: 'open' | 'reviewed';
  createdAt: string;
  changedByBmgAt: string | null;
  reviewedAt: string | null;
  feedbackTodoIds: string[];
}

export interface SubmissionDetail extends SubmissionSummary {
  note: string;
  feedback: string | null;
}
