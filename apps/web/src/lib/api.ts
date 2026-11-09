import type { AppConfig } from './config.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the BMG API (same origin, via CloudFront) with the Cognito access token. */
export async function api<T>(
  cfg: AppConfig,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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
    throw new ApiError(res.status, data.detail ?? data.title ?? data.message ?? 'Request failed');
  return data as T;
}

export interface Me {
  sub: string;
  role: 'bmg-admin' | 'bmg-staff' | 'artist';
  artistId: string | null;
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
}

export type MeasureId = 'M1' | 'M2' | 'M3' | 'M4';
export interface Milestone {
  id: string;
  title: string;
  done: boolean;
  measures: MeasureId[];
}
export interface Phase {
  id: string;
  name: string;
  goal: string;
  milestones: Milestone[];
}
export interface Plan {
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
  exists: boolean;
}

export interface Todo {
  todoId: string;
  artistId: string;
  title: string;
  notes: string | null;
  due: string | null;
  phaseId: string | null;
  done: boolean;
  source: 'bmg' | 'feedback' | 'artist';
  bmgOnly: boolean;
  createdAt: string;
}

export const TODO_FILTERS = [
  { id: '', label: 'Open' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'due-this-week', label: 'Due this week' },
  { id: 'from-bmg', label: 'From Blueprint' },
  { id: 'from-feedback', label: 'From feedback' },
  { id: 'own', label: "Artist's own" },
  { id: 'done', label: 'Done' },
] as const;
