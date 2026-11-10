import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';

/**
 * Profile pictures across the app. Anywhere an avatar knows whose it is (an
 * artist id or a user's sub), it shows that person's picture; initials show
 * only when they haven't set one. Pictures are fetched in batches from
 * GET /avatars and kept for the session, so a list of 30 people is one call.
 */

export type AvatarKind = 'artists' | 'users';
const BATCH = 50;

class AvatarStore {
  private cache = new Map<string, string | null>();
  private queued: Record<AvatarKind, Set<string>> = { artists: new Set(), users: new Set() };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private cfg: AppConfig,
    private token: string,
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** The picture, null when there isn't one, or undefined while it's being looked up. */
  get(kind: AvatarKind, id: string): string | null | undefined {
    const key = `${kind}:${id}`;
    if (this.cache.has(key)) return this.cache.get(key);
    this.queued[kind].add(id);
    this.timer ??= setTimeout(() => void this.flush(), 0);
    return undefined;
  }

  /** Your own picture, known straight away (and after you change it). */
  set(kind: AvatarKind, id: string, src: string | null) {
    if (this.cache.get(`${kind}:${id}`) === src) return;
    this.cache.set(`${kind}:${id}`, src);
    this.emit();
  }

  private async flush() {
    this.timer = null;
    const artists = [...this.queued.artists];
    const users = [...this.queued.users];
    this.queued = { artists: new Set(), users: new Set() };
    const calls: Promise<void>[] = [];
    for (let i = 0; i < Math.max(artists.length, users.length); i += BATCH) {
      const a = artists.slice(i, i + BATCH);
      const u = users.slice(i, i + BATCH);
      const q = new URLSearchParams();
      if (a.length) q.set('artists', a.join(','));
      if (u.length) q.set('users', u.join(','));
      calls.push(
        api<{ artists?: Record<string, string>; users?: Record<string, string> }>(
          this.cfg,
          this.token,
          'GET',
          `/avatars?${q.toString()}`,
        )
          .then((r) => {
            for (const id of a) this.cache.set(`artists:${id}`, r.artists?.[id] ?? null);
            for (const id of u) this.cache.set(`users:${id}`, r.users?.[id] ?? null);
          })
          // Can't look them up right now: initials for this session, no retry loop.
          .catch(() => {
            for (const id of a) this.cache.set(`artists:${id}`, null);
            for (const id of u) this.cache.set(`users:${id}`, null);
          }),
      );
    }
    await Promise.all(calls);
    this.emit();
  }
}

const Store = createContext<AvatarStore | null>(null);

export function AvatarProvider({
  cfg,
  token,
  children,
}: {
  cfg: AppConfig;
  token: string;
  children: React.ReactNode;
}) {
  const store = useMemo(() => new AvatarStore(cfg, token), [cfg, token]);
  return <Store.Provider value={store}>{children}</Store.Provider>;
}

/** The signed-in person's own picture: known without asking, and current after they change it. */
export function useOwnAvatar(sub: string, artistId: string | null, avatar: string | null) {
  const store = useContext(Store);
  useEffect(() => {
    store?.set('users', sub, avatar);
    if (artistId) store?.set('artists', artistId, avatar);
  }, [store, sub, artistId, avatar]);
}

const noop = () => () => undefined;
const zero = () => 0;

/** The profile picture for an artist or a user, if they have one (undefined outside the app). */
export function useAvatarSrc(kind: AvatarKind, id: string | null | undefined) {
  const store = useContext(Store);
  useSyncExternalStore(store?.subscribe ?? noop, store?.getVersion ?? zero);
  return store && id ? store.get(kind, id) : undefined;
}
