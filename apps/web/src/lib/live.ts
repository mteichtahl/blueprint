import { useEffect, useRef, useState } from 'react';

/*
 * Live updates (rev 17). The server nudges each person's realtime channels
 * whenever something they can see changes (a gig, a to-do, a plan...). The
 * inbox subscription (lib/inbox.ts) passes those nudges on here, and screens
 * use `useLive` to refetch — so nobody has to reload the page.
 */

/** What changed, matching services/api/src/live/model.ts. */
export type LiveTopic =
  | 'todos'
  | 'gigs'
  | 'plan'
  | 'files'
  | 'reviews'
  | 'meetings'
  | 'artists'
  | 'contacts'
  | 'venues'
  | 'events'
  /** Consultation requests (rev 21). */
  | 'enquiries';

export interface LiveEvent {
  /** A topic, or '*' for "anything may have changed" (a reconnect, the tab coming back). */
  live: LiveTopic | '*';
  artistId?: string;
}

const EVENT = 'bmg:live';
/** Several changes in a row (saving a plan with its to-dos) become one refetch. */
export const LIVE_DEBOUNCE_MS = 400;

export function emitLive(e: LiveEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<LiveEvent>(EVENT, { detail: e }));
}

/** True when a nudge concerns a screen showing these topics (for this artist, if given). */
export function liveMatches(
  e: LiveEvent,
  topics: readonly LiveTopic[],
  artistId?: string | null,
): boolean {
  if (e.live === '*') return true;
  if (!topics.includes(e.live)) return false;
  return !artistId || !e.artistId || e.artistId === artistId;
}

/**
 * A number that goes up whenever something on these topics changes. Put it in
 * the dependencies of the effect (or `useCallback`) that loads the screen's
 * data, and the screen refetches by itself.
 */
export function useLive(topics: readonly LiveTopic[], artistId?: string | null): number {
  const [tick, setTick] = useState(0);
  const key = topics.join(',');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const list = key.split(',') as LiveTopic[];
    const bump = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setTick((t) => t + 1), LIVE_DEBOUNCE_MS);
    };
    const onLive = (ev: Event) => {
      if (liveMatches((ev as CustomEvent<LiveEvent>).detail, list, artistId)) bump();
    };
    window.addEventListener(EVENT, onLive);
    return () => {
      window.removeEventListener(EVENT, onLive);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, artistId]);
  return tick;
}

/**
 * Catch-up when the app comes back to the screen after being hidden for a
 * while (a phone unlocked, a tab switched back): realtime messages may have
 * been missed while the connection slept.
 */
export function useLiveCatchUp(): void {
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 15_000) emitLive({ live: '*' });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
}
