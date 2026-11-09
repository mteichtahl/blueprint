import type { AppConfig } from './config.ts';
import { refreshTokens, revokeToken, type Tokens } from './cognito.ts';

/**
 * The signed-in session, from Blueprint's own sign-in screens (Cognito's
 * user-pool API, no hosted UI).
 *
 * - Access and ID tokens live in memory only.
 * - So that a reload doesn't sign people out, the refresh token is kept in
 *   session storage, encrypted (AES-GCM) with a non-extractable key held in
 *   IndexedDB. Storage never holds a usable token in clear text, and closing
 *   the tab still ends the session (session storage goes with it).
 * - Without IndexedDB or WebCrypto, the session lasts only as long as the page.
 */

const BLOB_KEY = 'bmg.session';
const DB = 'bmg-auth';
const STORE = 'keys';

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

let current: Session | null = null;

function decode<T>(jwt: string): T {
  const part = jwt.split('.')[1] ?? '';
  const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  return JSON.parse(json) as T;
}

export const profileOf = (s: Session) => decode<Profile>(s.idToken);

// ── The encryption key: non-extractable, so script can use it but never read it ──

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) {
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

let keyPromise: Promise<CryptoKey | null> | undefined;
function sessionKey(): Promise<CryptoKey | null> {
  keyPromise ??= (async () => {
    try {
      const db = await openDb();
      const existing = await idb<CryptoKey | undefined>(db, 'readonly', (s) => s.get('session'));
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      await idb(db, 'readwrite', (s) => s.put(key, 'session'));
      return key;
    } catch {
      return null;
    }
  })();
  return keyPromise;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function persist(refreshToken: string | null) {
  try {
    if (!refreshToken) return sessionStorage.removeItem(BLOB_KEY);
    const key = await sessionKey();
    if (!key) return sessionStorage.removeItem(BLOB_KEY);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(refreshToken),
      ),
    );
    sessionStorage.setItem(BLOB_KEY, JSON.stringify({ iv: b64(iv), ct: b64(ct) }));
  } catch {
    // Storage or crypto blocked: the session lasts as long as the page.
  }
}

async function restoreRefreshToken(): Promise<string | null> {
  try {
    const raw = sessionStorage.getItem(BLOB_KEY);
    if (!raw) return null;
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const key = await sessionKey();
    if (!key) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
    return new TextDecoder().decode(plain);
  } catch {
    sessionStorage.removeItem(BLOB_KEY);
    return null;
  }
}

// ── Session ───────────────────────────────────────────────────────────────

/** Keeps the new refresh token when Cognito rotates it, else the old one. */
export async function storeTokens(t: Tokens, previousRefresh?: string): Promise<Session> {
  current = {
    accessToken: t.AccessToken,
    idToken: t.IdToken,
    refreshToken: t.RefreshToken ?? previousRefresh ?? '',
    expiresAt: Date.now() + t.ExpiresIn * 1000,
  };
  await persist(current.refreshToken || null);
  return current;
}

/** The current session, refreshed if the access token has (nearly) expired or the page reloaded. */
export async function currentSession(cfg: AppConfig): Promise<Session | null> {
  if (current && current.expiresAt - Date.now() > 60_000) return current;
  return refresh(cfg);
}

export async function refresh(cfg: AppConfig): Promise<Session | null> {
  const token = current?.refreshToken || (await restoreRefreshToken());
  if (!token) return clear();
  try {
    return await storeTokens(await refreshTokens(cfg, token), token);
  } catch {
    return clear();
  }
}

async function clear(): Promise<null> {
  current = null;
  await persist(null);
  return null;
}

/** Ends the session here and revokes its refresh token at Cognito. */
export async function signOut(cfg: AppConfig): Promise<void> {
  const token = current?.refreshToken || (await restoreRefreshToken());
  await clear();
  if (token) await revokeToken(cfg, token).catch(() => undefined);
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
