import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { AppConfig } from './config.ts';
import { subscribeInbox } from './realtime.ts';

export interface AppNotification {
  id: string;
  kind: 'review' | 'feedback' | 'message' | 'file';
  title: string;
  body: string;
  link: string;
  read: boolean;
  createdAt: string;
}

export interface Preferences {
  email: boolean;
  push: boolean;
  quietHours: { start: string; end: string } | null;
}

/** The bell: notifications for the signed-in user, live on their own channel. */
export function useNotifications(cfg: AppConfig, token: string, sub: string) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const load = useCallback(async () => {
    try {
      const res = await api<{ notifications: AppNotification[]; unread: number }>(
        cfg,
        token,
        'GET',
        '/notifications',
      );
      setItems(res.notifications);
      setUnread(res.unread);
    } catch {
      // The bell is best-effort; the rest of the app works without it.
    }
  }, [cfg, token]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const stop = subscribeInbox(
      cfg,
      () => tokenRef.current,
      `/inbox/user-${sub}`,
      () => void load(),
    );
    const poll = setInterval(() => void load(), 60_000);
    return () => {
      stop();
      clearInterval(poll);
    };
  }, [cfg, sub, load]);
  const markRead = useCallback(
    async (ids: string[] | 'all') => {
      await api(cfg, token, 'POST', '/notifications/read', ids === 'all' ? { all: true } : { ids });
      await load();
    },
    [cfg, token, load],
  );
  return { items, unread, markRead };
}
