import type { E2eAccountKey } from '@bmg/config/e2e';
import { account, baseUrl } from './accounts.ts';
import { freshCode } from './totp.ts';

/** The runtime settings the web stack writes at deploy (apps/web/src/lib/config.ts). */
export interface AppConfig {
  clientId: string;
  region: string;
  userPoolId: string;
  apiBase: string;
}

let configPromise: Promise<AppConfig> | undefined;
export function appConfig(): Promise<AppConfig> {
  configPromise ??= (async () => {
    const res = await fetch(`${await baseUrl()}/config.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`GET /config.json returned ${res.status}`);
    const cfg = (await res.json()) as AppConfig;
    // The app calls the API on its own origin (`/v1`, through CloudFront); Node needs it absolute.
    return {
      ...cfg,
      apiBase: new URL(cfg.apiBase, `${await baseUrl()}/`).toString().replace(/\/+$/, ''),
    };
  })();
  return configPromise;
}

// ── Cognito (the same public user-pool calls the app makes) ────────────────

export class CognitoError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(`${type}: ${message}`);
  }
}

export async function cognito<T>(operation: string, body: Record<string, unknown>): Promise<T> {
  const cfg = await appConfig();
  const res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const type = String(data.__type ?? 'Error')
      .split('#')
      .pop()!;
    throw new CognitoError(type, String(data.message ?? ''));
  }
  return data as T;
}

interface AuthResponse {
  ChallengeName?: string;
  Session?: string;
  AuthenticationResult?: { AccessToken: string; IdToken: string; ExpiresIn: number };
}

/** Starts a password sign-in; the answer is normally the SOFTWARE_TOKEN_MFA challenge. */
export async function startPasswordSignIn(email: string, password: string): Promise<AuthResponse> {
  const cfg = await appConfig();
  return cognito<AuthResponse>('InitiateAuth', {
    ClientId: cfg.clientId,
    AuthFlow: 'USER_AUTH',
    AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
  });
}

export async function answerMfa(email: string, session: string, code: string) {
  const cfg = await appConfig();
  return cognito<AuthResponse>('RespondToAuthChallenge', {
    ClientId: cfg.clientId,
    ChallengeName: 'SOFTWARE_TOKEN_MFA',
    Session: session,
    ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: code },
  });
}

interface Token {
  accessToken: string;
  expiresAt: number;
}
const tokens = new Map<E2eAccountKey, Promise<Token>>();

/** An access token for a test account: password plus a fresh authenticator code. */
export async function accessToken(key: E2eAccountKey): Promise<string> {
  const cached = await tokens.get(key);
  if (cached && cached.expiresAt - Date.now() > 120_000) return cached.accessToken;
  const pending = (async (): Promise<Token> => {
    const a = await account(key);
    const first = await startPasswordSignIn(a.email, a.password);
    const done =
      first.ChallengeName === 'SOFTWARE_TOKEN_MFA'
        ? await answerMfa(a.email, first.Session!, await freshCode(a.email, a.totpSecret))
        : first;
    const result = done.AuthenticationResult;
    if (!result) {
      throw new Error(
        `${key}: sign-in stopped at ${done.ChallengeName ?? 'an unknown step'}. Re-run \`blueprint e2e setup\`.`,
      );
    }
    return { accessToken: result.AccessToken, expiresAt: Date.now() + result.ExpiresIn * 1000 };
  })();
  tokens.set(key, pending);
  try {
    return (await pending).accessToken;
  } catch (err) {
    tokens.delete(key);
    throw err;
  }
}

// ── The BMG API ────────────────────────────────────────────────────────────

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  data: T;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Calls the API as a test account. Never throws on an HTTP error: tests check the status. */
export async function call<T = Record<string, unknown>>(
  as: E2eAccountKey | null,
  method: Method,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const cfg = await appConfig();
  const headers: Record<string, string> = { ...extraHeaders };
  if (as) headers.authorization = `Bearer ${await accessToken(as)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data: data as T };
}

/** Like `call`, but a non-2xx answer fails with the API's own message. */
export async function ok<T = Record<string, unknown>>(
  as: E2eAccountKey,
  method: Method,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await call<T>(as, method, path, body);
  if (res.status < 200 || res.status > 299) {
    throw new Error(`${as} ${method} ${path} → ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

/**
 * The assistant's tool routes (`/ai/tools/…`) answer only requests marked as
 * coming from the assistant; anything else gets 404. The marker isn't a
 * credential: the tools still run as the signed-in person.
 */
export const aiTool = <T = Record<string, unknown>>(as: E2eAccountKey, path: string) =>
  call<T>(as, 'GET', path, undefined, { 'x-bmg-context': 'ai' });

/** Shorthands for the ids setup recorded. */
export async function artistIdOf(key: 'artistOn' | 'artistOff' | 'artistOther'): Promise<string> {
  const id = (await account(key)).artistId;
  if (!id) throw new Error(`${key} has no artistId. Re-run \`blueprint e2e setup\`.`);
  return id;
}

export async function subOf(key: E2eAccountKey): Promise<string> {
  const sub = (await account(key)).sub;
  if (sub) return sub;
  return (await ok<{ sub: string }>(key, 'GET', '/me')).sub;
}
