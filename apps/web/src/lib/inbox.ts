import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Me } from './api.ts';
import type { AppConfig } from './config.ts';
import { emitLive, useLiveCatchUp, type LiveTopic } from './live.ts';
import { inboxChannels, subscribeInbox } from './realtime.ts';
import type { ConversationSummary } from '../pages/Messages.tsx';

/*
 * The inbox lives outside the chat screens so the app shell can show unread
 * counts without loading Chat itself (pages load on first use).
 */

/**
 * Live inbox: loads conversations and reloads whenever AppSync Events nudges
 * this user's channel, with a slow poll as a fallback. Live-update nudges
 * (rev 17) arrive on the same channels and are handed to `useLive` screens.
 */
export function useInbox(cfg: AppConfig, token: string, me: Me) {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const load = useCallback(async () => {
    try {
      setConversations(
        (await api<{ conversations: ConversationSummary[] }>(cfg, token, 'GET', '/conversations'))
          .conversations,
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);

  useEffect(() => void load(), [load, tick]);
  useLiveCatchUp();
  useEffect(() => {
    const stops = inboxChannels(me.role, me.artistId, me.sub).map((ch) =>
      subscribeInbox(
        cfg,
        () => tokenRef.current,
        ch,
        (payload) => {
          // Live updates (rev 17) share these channels: pass them on to the
          // screens, and leave the chat list alone.
          if (payload.live) {
            emitLive({
              live: payload.live as LiveTopic,
              ...(payload.artistId ? { artistId: payload.artistId } : {}),
            });
          } else setTick((t) => t + 1);
        },
        () => {
          setTick((t) => t + 1);
          emitLive({ live: '*' });
        },
      ),
    );
    const poll = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      stops.forEach((s) => s());
      clearInterval(poll);
    };
  }, [cfg, me.role, me.artistId, me.sub]);

  /** Chats with something unread (archived and muted ones don't count). */
  const unreadChats = (conversations ?? []).filter(
    (c) => !c.archived && !c.muted && c.unreadCount > 0,
  ).length;

  return { conversations, error, reload: load, tick, unreadChats };
}

/**
 * Unread messages in Blueprint's chat with one artist (rev 9): the count on
 * the chat icon in that artist's workspace. Archived chats don't count.
 */
export function directUnread(
  conversations: readonly ConversationSummary[] | null,
  artistId: string,
): number {
  return (conversations ?? [])
    .filter(
      (c) =>
        c.type === 'bmg-artist' && !c.archived && c.artists.some((a) => a.artistId === artistId),
    )
    .reduce((n, c) => n + c.unreadCount, 0);
}
