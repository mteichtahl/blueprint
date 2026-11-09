import type { AppConfig } from './config.ts';
import { refreshTokens, revokeToken, type Tokens } from './cognito.ts';

/**
 * The signed-in session, from Blueprint's own sign-in screens (Cognito's
 * user-pool API, no hosted UI). Tokens stay in session storage, so closing the
 * tab signs out; the strict CSP limits what scripts can run on the page.
 */

const KEY = 'bmg.session';

export interface Session {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  /** ms since epoch when the access token expires. */
  expiresAt: number;
}

export interface Profile {
  email?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
}

function decode<T>(jwt: string): T {
  const part = jwt.split('.')[1] ?? '';
  const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  return JSON.parse(json) as T;
}

export const profileOf = (s: Session) => decode<Profile>(s.idToken);

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function save(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the session lasts as long as the page.
  }
}

/** Keeps the new refresh token when Cognito rotates it, else the old one. */
export function storeTokens(t: Tokens, previousRefresh?: string): Session {
  const s: Session = {
    accessToken: t.AccessToken,
    idToken: t.IdToken,
    refreshToken: t.RefreshToken ?? previousRefresh ?? '',
    expiresAt: Date.now() + t.ExpiresIn * 1000,
  };
  save(s);
  return s;
}

/** The current session, refreshed if the access token has (nearly) expired. */
export async function currentSession(cfg: AppConfig): Promise<Session | null> {
  const s = load();
  if (!s) return null;
  if (s.expiresAt - Date.now() > 60_000) return s;
  return refresh(cfg, s);
}

export async function refresh(cfg: AppConfig, s = load()): Promise<Session | null> {
  if (!s?.refreshToken) {
    save(null);
    return null;
  }
  try {
    return storeTokens(await refreshTokens(cfg, s.refreshToken), s.refreshToken);
  } catch {
    save(null);
    return null;
  }
}

/** Ends the session here and revokes its refresh token at Cognito. */
export async function signOut(cfg: AppConfig): Promise<void> {
  const s = load();
  save(null);
  if (s?.refreshToken) await revokeToken(cfg, s.refreshToken).catch(() => undefined);
}

/** Remembered between visits so the email box is pre-filled (not a secret). */
const EMAIL_KEY = 'bmg.lastEmail';
export const lastEmail = () => {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
};
export const rememberEmail = (email: string) => {
  try {
    localStorage.setItem(EMAIL_KEY, email);
  } catch {
    // ignore
  }
};
