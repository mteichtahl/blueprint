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
  method: 'GET' | 'POST',
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
