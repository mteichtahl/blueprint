import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type ArtistSummary, type Me, type Todo } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { EmojiPicker } from '../components/EmojiPicker.tsx';
import { formatSize, uploadFile, waitUntilScanned, type FileItem } from '../lib/files.ts';
import { foldersBase, listFolders, pickerLevel, type Folder } from '../lib/folders.ts';
import { inboxChannels, subscribeInbox } from '../lib/realtime.ts';
import { Avatar, Icon, WaveLoader } from '../components/ui.tsx';
import type { Gig } from './Gigs.tsx';

/* ------------------------------------------------------------------------ */
/* Contract types (docs/chat-api.md)                                        */
/* ------------------------------------------------------------------------ */

export type ChatType = 'bmg-artist' | 'group' | 'announcement' | 'artist-to-artist';
export type TickState = 'sent' | 'delivered' | 'read';

export interface GroupSettings {
  onlyAdminsSend: boolean;
  artistsShareFiles: boolean;
  artistsAddMembers: boolean;
}

export interface ConversationSummary {
  conversationId: string;
  type: ChatType;
  title: string;
  description: string | null;
  artists: { artistId: string; displayName: string }[];
  access: 'read-write' | 'read';
  canSend: boolean;
  settings: GroupSettings | null;
  lastMessageAt: string | null;
  preview: string | null;
  previewSender: string | null;
  previewTicks: TickState | null;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  archived: boolean;
  private: boolean;
  lastSeen: string | null;
}

export interface ChatAttachment {
  kind: 'file' | 'event' | 'todo' | 'submission' | 'gig' | 'feedback';
  id: string;
  artistId?: string;
  scope?: 'library' | 'artist';
  title: string;
  subtitle: string;
}

interface ChatMessage {
  messageId: string;
  createdAt: string;
  kind: 'message' | 'system';
  text: string;
  senderName: string;
  senderRole: string;
  senderArtistId: string | null;
  mine: boolean;
  ticks?: TickState | null;
  starred: boolean;
  /** Quick reactions (rev 14); older API responses may leave it out. */
  reactions?: ReactionCount[];
  replyTo: { messageId: string; senderName: string; text: string } | null;
  attachment: ChatAttachment | null;
}

/** The four quick reactions, in bar order (matches the API's QUICK_REACTIONS). */
export const QUICK_REACTIONS = [
  { emoji: '👍', label: 'Thumbs up' },
  { emoji: '👎', label: 'Thumbs down' },
  { emoji: '😊', label: 'Smile' },
  { emoji: '😢', label: 'Sad' },
] as const;
type QuickReaction = (typeof QUICK_REACTIONS)[number]['emoji'];

interface ReactionCount {
  emoji: QuickReaction;
  count: number;
  mine: boolean;
  names: string[];
}

/**
 * The caller's reaction after tapping `emoji`: the same one again takes it
 * off, a different one swaps it (one reaction per person, like WhatsApp).
 * Returns the new list and what to send (`null` = take mine off).
 */
export function toggleReaction(
  list: ReactionCount[],
  emoji: QuickReaction,
): { next: ReactionCount[]; send: QuickReaction | null } {
  const had = list.find((r) => r.mine)?.emoji ?? null;
  const send = had === emoji ? null : emoji;
  const next = QUICK_REACTIONS.map(({ emoji: e }) => {
    const cur = list.find((r) => r.emoji === e);
    let names = (cur?.names ?? []).filter((n) => !(cur?.mine && n === 'You'));
    if (e === send) names = [...names, 'You'];
    return { emoji: e, count: names.length, mine: e === send, names };
  }).filter((r) => r.count > 0);
  return { next, send };
}

interface ThreadPage {
  conversationId: string;
  type: ChatType;
  access: 'read-write' | 'read';
  canSend: boolean;
  firstUnreadMessageId: string | null;
  messages: ChatMessage[];
  nextBefore: string | null;
}

interface Person {
  artistId: string;
  displayName: string;
}

interface EventLite {
  eventId: string;
  name: string;
  date: string;
  venue: string;
}

/** A quote waiting in the composer; conversationId is set for a private reply to an announcement. */
interface PendingReply {
  messageId: string;
  senderName: string;
  text: string;
  conversationId?: string;
}

/** Everything the chat screens share. */
interface ChatCtx {
  cfg: AppConfig;
  token: string;
  me: Me;
  isBmg: boolean;
  onNavigate: (view: string) => void;
}

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });

function daysAgo(iso: string) {
  const a = new Date(iso);
  a.setHours(0, 0, 0, 0);
  const b = new Date();
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Chat list time: today → time, Yesterday, weekday this week, else a short date. */
export function listTime(iso: string) {
  const n = daysAgo(iso);
  if (n <= 0) return clock(iso);
  if (n === 1) return 'Yesterday';
  if (n < 7) return new Date(iso).toLocaleDateString('en-AU', { weekday: 'long' });
  return new Date(iso).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'numeric',
    year: '2-digit',
  });
}

function dayPill(iso: string) {
  const n = daysAgo(iso);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  const d = new Date(iso);
  if (n < 7) return d.toLocaleDateString('en-AU', { weekday: 'long' });
  return d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function lastSeenText(iso: string | null) {
  if (!iso) return '';
  if (Date.now() - new Date(iso).getTime() < 2 * 60_000) return 'online';
  const n = daysAgo(iso);
  if (n <= 0) return `last seen today at ${clock(iso)}`;
  if (n === 1) return `last seen yesterday at ${clock(iso)}`;
  return `last seen ${new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`;
}

/** Stable sender colours for group chats (same name, same colour). */
const NAME_COLOURS = ['#B5403C', '#1F6F8B', '#7A4FA3', '#2E7D4F', '#A0611C', '#0F5E9C', '#8A3B6B'];
const nameColour = (s: string) =>
  NAME_COLOURS[[...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % NAME_COLOURS.length];

const isGroupish = (t: ChatType) => t === 'group' || t === 'announcement';
const firstName = (s: string) => s.split(' ')[0];

/** Where an attachment card opens: a view id Home.tsx understands. */
export function attachmentView(a: ChatAttachment, isBmg: boolean): string {
  if (isBmg) {
    switch (a.kind) {
      case 'file':
        return a.scope === 'artist' && a.artistId ? `artist:${a.artistId}` : 'library';
      case 'event':
        return 'events';
      case 'todo':
        return a.artistId ? `artist:${a.artistId}` : 'todos';
      case 'gig':
        return 'gigs';
      default:
        return 'review';
    }
  }
  switch (a.kind) {
    case 'file':
      return 'library';
    case 'todo':
      return 'todo';
    case 'gig':
      return 'gigs';
    case 'event':
      return 'home';
    default:
      return 'submit';
  }
}

function attachmentTag(a: ChatAttachment) {
  switch (a.kind) {
    case 'file': {
      const s = `${a.title} ${a.subtitle}`.toLowerCase();
      if (/\bpdf\b|\.pdf/.test(s)) return 'PDF';
      if (/\b(png|jpe?g|gif|webp|heic|img|image|photo)\b|\.(png|jpe?g|gif|webp|heic)/.test(s))
        return 'IMG';
      return 'DOC';
    }
    case 'event':
      return 'Event';
    case 'todo':
      return 'To-do';
    case 'gig':
      return 'Gig';
    case 'submission':
      return 'For review';
    default:
      return 'Feedback';
  }
}

/* Extra glyphs the chat needs on top of the shared Icon set. */
const GLYPHS = {
  pin: 'M14.5 3.5l6 6-2.5 1-3.5 3.5.5 4-2 2-9-9 2-2 4 .5L13.5 6zM8 16l-4.5 4.5',
  muted: 'M11 5L6 9H3v6h3l5 4zM16 9.5l5 5M21 9.5l-5 5',
  megaphone: 'M3 10v4h3l8 5V5L6 10zM18 8.5a4.5 4.5 0 010 7',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5h.01',
  smile: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8.5 14a4.5 4.5 0 007 0M9 9.5h.01M15 9.5h.01',
  plus: 'M12 5v14M5 12h14',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  reply: 'M10 8V4L3 11l7 7v-4c5 0 8 1.5 11 5-1-6-4-11-11-11z',
  x: 'M6 6l12 12M18 6L6 18',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
  check: 'M5 12l5 5 9-10',
  newchat: 'M4 5h16v11H8l-4 4zM12 7.5v6M9 10.5h6',
  userplus:
    'M15 20v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M8.5 4a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM19 8v6M16 11h6',
  exit: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  arrowR: 'M5 12h14M13 6l6 6-6 6',
} as const;
type GlyphName = keyof typeof GLYPHS;

function G({
  n,
  size = 20,
  filled = false,
  className = '',
}: {
  n: GlyphName;
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={n === 'more' ? 3 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={GLYPHS[n]} />
    </svg>
  );
}

/** One slate tick = sent, two slate = delivered, two coral = read. */
function Ticks({ t }: { t: TickState | null | undefined }) {
  if (!t) return null;
  const one = t === 'sent';
  return (
    <svg
      role="img"
      aria-label={t === 'read' ? 'Read' : t === 'delivered' ? 'Delivered' : 'Sent'}
      width={one ? 11 : 17}
      height="11"
      viewBox={one ? '0 0 11 11' : '0 0 17 11'}
      fill="none"
      stroke={t === 'read' ? '#B5403C' : '#5C6775'}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="wa-ticks"
    >
      <path d={one ? 'M1 6l3 3 6-7.5' : 'M1 6l3 3 6-7.5M7 9l1 1 7.5-8.5'} />
    </svg>
  );
}

function ChatAvatar({ c, size = 48 }: { c: ConversationSummary; size?: number }) {
  if (c.type === 'announcement')
    return (
      <span className="av wa-av-ann" style={{ width: size, height: size }}>
        <G n="megaphone" size={Math.round(size * 0.46)} />
      </span>
    );
  if (c.type === 'group')
    return (
      <span className="av wa-av-grp" style={{ width: size, height: size }}>
        <Icon name="users" size={Math.round(size * 0.44)} />
      </span>
    );
  // A direct chat is titled with the other person's name: show their picture.
  const who = c.artists.find((a) => a.displayName === c.title);
  return <Avatar name={c.title} artistId={who?.artistId} size={size} />;
}

export function useNarrow(query = '(max-width: 899px)') {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

/* ------------------------------------------------------------------------ */
/* Data hooks                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Live inbox: loads conversations and reloads whenever AppSync Events nudges
 * this user's channel, with a slow poll as a fallback.
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
  useEffect(() => {
    const stops = inboxChannels(me.role, me.artistId).map((ch) =>
      subscribeInbox(
        cfg,
        () => tokenRef.current,
        ch,
        () => setTick((t) => t + 1),
      ),
    );
    const poll = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      stops.forEach((s) => s());
      clearInterval(poll);
    };
  }, [cfg, me.role, me.artistId]);

  /** Chats with something unread (archived and muted ones don't count). */
  const unreadChats = (conversations ?? []).filter(
    (c) => !c.archived && !c.muted && c.unreadCount > 0,
  ).length;

  return { conversations, error, reload: load, tick, unreadChats };
}
type Inbox = ReturnType<typeof useInbox>;

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

/** People this user can start chats with or add to groups. */
function useRoster(ctx: ChatCtx, given?: Person[]) {
  const [fetched, setFetched] = useState<Person[] | null>(null);
  useEffect(() => {
    if (given) return;
    let live = true;
    api<{ artists: Person[] }>(ctx.cfg, ctx.token, 'GET', '/directory')
      .then((r) => live && setFetched(r.artists))
      .catch(() => live && setFetched([]));
    return () => {
      live = false;
    };
  }, [ctx.cfg, ctx.token, given]);
  return (given ?? fetched ?? []).filter((a) => a.artistId !== ctx.me.artistId);
}

function useThread(ctx: ChatCtx, conversationId: string, tick: number) {
  const [page, setPage] = useState<ThreadPage | null>(null);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** The unread divider is fixed at the first load; later loads have already marked it read. */
  const anchor = useRef<{ id: string; at: string | null } | null>(null);

  useEffect(() => {
    setPage(null);
    setOlder([]);
    setOlderCursor(undefined);
    anchor.current = null;
  }, [conversationId]);

  const load = useCallback(async () => {
    try {
      const p = await api<ThreadPage>(
        ctx.cfg,
        ctx.token,
        'GET',
        `/conversations/${encodeURIComponent(conversationId)}/messages`,
      );
      if (anchor.current?.id !== conversationId)
        anchor.current = { id: conversationId, at: p.firstUnreadMessageId };
      setPage(p);
      setOlderCursor((c) => (c === undefined ? p.nextBefore : c));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [ctx.cfg, ctx.token, conversationId]);

  useEffect(() => void load(), [load, tick]);

  const loadOlder = async () => {
    if (!olderCursor) return;
    try {
      const p = await api<ThreadPage>(
        ctx.cfg,
        ctx.token,
        'GET',
        `/conversations/${encodeURIComponent(conversationId)}/messages?before=${encodeURIComponent(olderCursor)}`,
      );
      setOlder((o) => [...p.messages, ...o]);
      setOlderCursor(p.nextBefore);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const messages = useMemo(() => {
    const seen = new Set<string>();
    return [...older, ...(page?.messages ?? [])]
      .filter((m) => (seen.has(m.messageId) ? false : (seen.add(m.messageId), true)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [older, page]);

  const patchMessage = (id: string, change: Partial<ChatMessage>) => {
    setPage((p) =>
      p
        ? { ...p, messages: p.messages.map((m) => (m.messageId === id ? { ...m, ...change } : m)) }
        : p,
    );
    setOlder((o) => o.map((m) => (m.messageId === id ? { ...m, ...change } : m)));
  };

  return {
    page,
    messages,
    error,
    reload: load,
    loadOlder,
    hasOlder: !!olderCursor,
    unreadAnchor: anchor.current?.id === conversationId ? anchor.current.at : null,
    patchMessage,
  };
}

/* ------------------------------------------------------------------------ */
/* Chat list                                                                */
/* ------------------------------------------------------------------------ */

type Filter = 'all' | 'unread' | 'groups' | 'artists' | 'announcements' | 'blueprint';

function matchesFilter(c: ConversationSummary, f: Filter) {
  switch (f) {
    case 'unread':
      return c.unreadCount > 0;
    case 'groups':
      return c.type === 'group';
    case 'artists':
      return c.type === 'bmg-artist' || c.type === 'artist-to-artist';
    case 'announcements':
      return c.type === 'announcement';
    case 'blueprint':
      return c.type === 'bmg-artist' || c.type === 'announcement';
    default:
      return true;
  }
}

const sortChats = (list: ConversationSummary[]) =>
  [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''),
  );

function ChatRow({
  c,
  active,
  onOpen,
}: {
  c: ConversationSummary;
  active: boolean;
  onOpen: () => void;
}) {
  const unread = c.unreadCount > 0;
  const who =
    c.previewSender === 'You'
      ? 'You: '
      : c.previewSender && isGroupish(c.type)
        ? `${firstName(c.previewSender)}: `
        : '';
  return (
    <button
      type="button"
      className="wa-row"
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
    >
      {/* The row's name is its visible text (WCAG 2.5.3); "unread" is spoken with the count. */}
      <ChatAvatar c={c} />
      <span className="wa-row-body">
        <span className="wa-top">
          <span className="wa-name">
            {c.title}
            {c.private && <Icon name="lock" size={13} className="wa-lockicon" />}
          </span>
          {c.lastMessageAt && (
            <span className={`wa-time ${unread && !c.muted ? 'wa-time-new' : ''}`}>
              {listTime(c.lastMessageAt)}
            </span>
          )}
        </span>
        <span className="wa-bot">
          <span className="wa-prev">
            {c.previewSender === 'You' && <Ticks t={c.previewTicks} />}
            {c.preview ? (
              <>
                {who}
                {c.preview}
              </>
            ) : (
              <i>{c.description ?? 'No messages yet'}</i>
            )}
          </span>
          {c.muted && <G n="muted" size={16} className="wa-flag" />}
          {c.pinned && <G n="pin" size={16} className="wa-flag" />}
          {unread && (
            <span className={`wa-count ${c.muted ? 'wa-count-muted' : ''}`}>
              {c.unreadCount > 99 ? '99+' : c.unreadCount}
              <span className="sr-only"> unread</span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function ChatList({
  ctx,
  inbox,
  activeId,
  phone,
  onOpen,
  onNew,
}: {
  ctx: ChatCtx;
  inbox: Inbox;
  activeId: string | null;
  phone: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState(false);
  const all = inbox.conversations ?? [];
  const archived = all.filter((c) => c.archived);
  const unreadCount = all.filter((c) => !c.archived && c.unreadCount > 0).length;
  const q = query.trim().toLowerCase();
  const shown = sortChats(
    all.filter(
      (c) =>
        c.archived === showArchived &&
        (showArchived || matchesFilter(c, filter)) &&
        (!q ||
          c.title.toLowerCase().includes(q) ||
          (c.preview ?? '').toLowerCase().includes(q) ||
          c.artists.some((a) => a.displayName.toLowerCase().includes(q))),
    ),
  );
  const pills: { id: Filter; label: string }[] = ctx.isBmg
    ? [
        { id: 'all', label: 'All' },
        { id: 'unread', label: unreadCount ? `Unread ${unreadCount}` : 'Unread' },
        { id: 'groups', label: 'Groups' },
        { id: 'artists', label: 'Artists' },
        { id: 'announcements', label: 'Announcements' },
      ]
    : [
        { id: 'all', label: 'All' },
        { id: 'unread', label: unreadCount ? `Unread ${unreadCount}` : 'Unread' },
        { id: 'groups', label: 'Groups' },
        { id: 'blueprint', label: 'Blueprint' },
      ];

  return (
    <section className="wa-list" aria-label="Chats">
      {showArchived ? (
        <div className="wa-hd">
          <button
            type="button"
            className="ibtn"
            aria-label="Back to chats"
            onClick={() => setShowArchived(false)}
          >
            <Icon name="back" />
          </button>
          <h2 className="wa-hd-title">Archived</h2>
        </div>
      ) : phone ? (
        <div className="wa-phone-hd">
          <h2 className="wa-big">Chats</h2>
          <button type="button" className="ibtn" aria-label="New chat" onClick={onNew}>
            <G n="newchat" size={22} />
          </button>
        </div>
      ) : (
        <div className="wa-hd">
          <h2 className="wa-hd-title">Chats</h2>
          <span className="ml-auto flex">
            <button type="button" className="ibtn" aria-label="New chat" onClick={onNew}>
              <G n="newchat" size={22} />
            </button>
            <span className="relative">
              <button
                type="button"
                className="ibtn"
                aria-label="Menu"
                aria-expanded={menu}
                onClick={() => setMenu((m) => !m)}
              >
                <G n="more" />
              </button>
              {menu && (
                <span className="wa-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onNew();
                    }}
                  >
                    {ctx.isBmg ? 'New group or announcement' : 'New chat'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setShowArchived(true);
                    }}
                  >
                    Archived chats
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setFilter('unread');
                    }}
                  >
                    Show unread
                  </button>
                </span>
              )}
            </span>
          </span>
        </div>
      )}
      <div className="wa-searchrow">
        <label className="search search-fill">
          <Icon name="search" size={16} />
          <input
            aria-label="Search chats"
            placeholder={showArchived ? 'Search archived' : 'Search or start a new chat'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {!showArchived && (
        <div className="wa-filters" role="group" aria-label="Filter chats">
          {pills.map((p) => (
            <button
              key={p.id}
              type="button"
              className="wa-pill"
              aria-pressed={filter === p.id}
              onClick={() => setFilter(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="wa-scroll">
        {!showArchived && archived.length > 0 && (
          <button type="button" className="wa-arch" onClick={() => setShowArchived(true)}>
            <span className="wa-arch-ic">
              <G n="archive" />
            </span>
            <span className="flex-1">Archived</span>
            <span className="wa-time">{archived.length}</span>
          </button>
        )}
        {inbox.error && !inbox.conversations && (
          <p className="wa-empty" role="alert">
            Couldn’t load chats: {inbox.error}
          </p>
        )}
        {!inbox.conversations && !inbox.error && <WaveLoader label="Loading chats" />}
        {inbox.conversations && shown.length === 0 && (
          <p className="wa-empty">
            {q
              ? 'No chats match that search.'
              : showArchived
                ? 'No archived chats.'
                : filter === 'all'
                  ? 'No chats yet. Start one with the new chat button.'
                  : 'Nothing here.'}
          </p>
        )}
        {shown.map((c) => (
          <ChatRow
            key={c.conversationId}
            c={c}
            active={c.conversationId === activeId}
            onOpen={() => onOpen(c.conversationId)}
          />
        ))}
        <p className="wa-locknote">
          <Icon name="lock" size={13} /> Chats between artists are private to them. Blueprint can’t
          see them.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* New chat flow                                                            */
/* ------------------------------------------------------------------------ */

const DEFAULT_SETTINGS: GroupSettings = {
  onlyAdminsSend: false,
  artistsShareFiles: true,
  artistsAddMembers: false,
};

function SettingSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="wa-setting">
      <span className="flex-1">
        <span className="block">{label}</span>
        {hint && <span className="wa-sub block">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function NewChat({
  ctx,
  roster,
  phone,
  onClose,
  onCreated,
}: {
  ctx: ChatCtx;
  roster: Person[];
  phone: boolean;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [step, setStep] = useState<'menu' | 'pick' | 'details'>('menu');
  const [kind, setKind] = useState<'group' | 'announcement'>('group');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [settings, setSettings] = useState<GroupSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Access & permissions: what artists may start (Blueprint is never limited).
  const [rules, setRules] = useState({ artistDirectChats: true, artistGroups: false });
  useEffect(() => {
    if (ctx.isBmg) return;
    api<{ artistDirectChats: boolean; artistGroups: boolean }>(
      ctx.cfg,
      ctx.token,
      'GET',
      '/access/settings',
    )
      .then((r) =>
        setRules({ artistDirectChats: r.artistDirectChats, artistGroups: r.artistGroups }),
      )
      .catch(() => undefined);
  }, [ctx.isBmg, ctx.cfg, ctx.token]);
  const canGroup = ctx.isBmg || rules.artistGroups;
  const q = query.trim().toLowerCase();
  const matches = roster.filter((a) => !q || a.displayName.toLowerCase().includes(q));
  const contacts = ctx.isBmg || rules.artistDirectChats ? matches : [];
  const name = (id: string) => roster.find((a) => a.artistId === id)?.displayName ?? id;

  async function create(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const { conversationId } = await api<{ conversationId: string }>(
        ctx.cfg,
        ctx.token,
        'POST',
        '/conversations',
        body,
      );
      onCreated(conversationId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const back = () =>
    step === 'details' ? setStep('pick') : step === 'pick' ? setStep('menu') : onClose();
  const heading =
    step === 'menu'
      ? 'New chat'
      : step === 'pick'
        ? kind === 'group'
          ? 'Add group members'
          : 'Choose who hears it'
        : kind === 'group'
          ? 'New group'
          : 'New announcement';

  return (
    <section className="wa-list" aria-label={heading}>
      <div className={phone ? 'wa-phone-hd' : 'wa-hd'}>
        <button type="button" className="ibtn" aria-label="Back" onClick={back}>
          <Icon name="back" />
        </button>
        <h2 className={phone ? 'wa-big wa-big-sm' : 'wa-hd-title'}>{heading}</h2>
      </div>
      {step !== 'details' && (
        <div className="wa-searchrow">
          <label className="search search-fill">
            <Icon name="search" size={16} />
            <input
              aria-label="Search people"
              placeholder="Search name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      )}
      {step === 'pick' && picked.length > 0 && (
        <div className="wa-chips" aria-label="Selected">
          {picked.map((id) => (
            <span key={id} className="wa-chipsel">
              <Avatar name={name(id)} artistId={id} size={24} />
              {firstName(name(id))}
              <button
                type="button"
                className="wa-chipx"
                aria-label={`Remove ${name(id)}`}
                onClick={() => setPicked((p) => p.filter((x) => x !== id))}
              >
                <G n="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="wa-scroll">
        {error && (
          <p className="wa-empty" role="alert">
            {error}
          </p>
        )}
        {step === 'menu' && (
          <>
            <button
              type="button"
              className="wa-row"
              disabled={!canGroup}
              title={canGroup ? undefined : 'Ask Blueprint to set one up'}
              onClick={() => {
                setKind('group');
                setStep('pick');
              }}
            >
              <span className="av wa-av-act">
                <Icon name="users" size={22} />
              </span>
              <span className="wa-row-body wa-row-solo">
                <span className="wa-name">New group</span>
                {!canGroup && <span className="wa-sub">Ask Blueprint to set one up</span>}
                {!ctx.isBmg && canGroup && (
                  <span className="wa-sub">Blueprint is in every group</span>
                )}
              </span>
            </button>
            {ctx.isBmg && (
              <button
                type="button"
                className="wa-row"
                onClick={() => {
                  setKind('announcement');
                  setStep('pick');
                }}
              >
                <span className="av wa-av-act">
                  <G n="megaphone" size={22} />
                </span>
                <span className="wa-row-body wa-row-solo">
                  <span className="wa-name">New announcement</span>
                  <span className="wa-sub">Only Blueprint posts; artists reply privately</span>
                </span>
              </button>
            )}
            <div className="wa-sechd">Contacts</div>
            {!ctx.isBmg && (!q || 'blueprint'.includes(q)) && (
              <button
                type="button"
                className="wa-row"
                disabled={busy}
                onClick={() => create({ kind: 'direct' })}
              >
                <Avatar name="Blueprint" size={48} />
                <span className="wa-row-body wa-row-solo">
                  <span className="wa-name">Blueprint</span>
                  <span className="wa-sub">Your team at Blueprint Music Group</span>
                </span>
              </button>
            )}
            {contacts.map((a) => (
              <button
                key={a.artistId}
                type="button"
                className="wa-row"
                disabled={busy}
                onClick={() => create({ kind: 'direct', artistId: a.artistId })}
              >
                <Avatar name={a.displayName} artistId={a.artistId} size={48} />
                <span className="wa-row-body wa-row-solo">
                  <span className="wa-name">{a.displayName}</span>
                  <span className="wa-sub">Artist</span>
                </span>
              </button>
            ))}
            {contacts.length === 0 && q && <p className="wa-empty">No one matches that name.</p>}
            {!ctx.isBmg && !rules.artistDirectChats && (
              <p className="wa-empty">Blueprint has turned off chats between artists.</p>
            )}
          </>
        )}
        {step === 'pick' && (
          <>
            {matches.map((a) => {
              const on = picked.includes(a.artistId);
              return (
                <label key={a.artistId} className="wa-row wa-row-check">
                  <Avatar name={a.displayName} artistId={a.artistId} size={48} />
                  <span className="wa-row-body wa-row-solo">
                    <span className="wa-name">{a.displayName}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="chk"
                    checked={on}
                    aria-label={a.displayName}
                    onChange={() =>
                      setPicked((p) =>
                        on ? p.filter((x) => x !== a.artistId) : [...p, a.artistId],
                      )
                    }
                  />
                </label>
              );
            })}
            {matches.length === 0 && <p className="wa-empty">No artists match.</p>}
          </>
        )}
        {step === 'details' && (
          <div className="wa-form">
            <div className="wa-form-top">
              <span
                className={`av ${kind === 'group' ? 'wa-av-grp' : 'wa-av-ann'}`}
                style={{ width: 64, height: 64 }}
              >
                {kind === 'group' ? <Icon name="users" size={28} /> : <G n="megaphone" size={28} />}
              </span>
              <label className="flex-1">
                <span className="wa-sub">
                  {kind === 'group' ? 'Group name' : 'Announcement name'}
                </span>
                <input
                  className="wa-line"
                  value={title}
                  maxLength={100}
                  autoFocus
                  placeholder={
                    kind === 'group' ? 'e.g. Mixer Night performers' : 'e.g. Studio news'
                  }
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
            </div>
            <label className="block">
              <span className="wa-sub">Description (optional)</span>
              <textarea
                className="wa-line"
                rows={2}
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            {kind === 'group' && ctx.isBmg && (
              <div className="wa-sec wa-sec-flat">
                <div className="wa-sechd">Group settings</div>
                <SettingSwitch
                  label="Only admins can send messages"
                  checked={settings.onlyAdminsSend}
                  onChange={(v) => setSettings((s) => ({ ...s, onlyAdminsSend: v }))}
                />
                <SettingSwitch
                  label="Artists can share files"
                  checked={settings.artistsShareFiles}
                  onChange={(v) => setSettings((s) => ({ ...s, artistsShareFiles: v }))}
                />
                <SettingSwitch
                  label="Artists can add members"
                  checked={settings.artistsAddMembers}
                  onChange={(v) => setSettings((s) => ({ ...s, artistsAddMembers: v }))}
                />
              </div>
            )}
            <p className="wa-sub">
              {kind === 'group' ? 'Members' : 'Goes to'}: Blueprint, {!ctx.isBmg && 'you, '}
              {picked.map((id) => name(id)).join(', ')}
            </p>
          </div>
        )}
      </div>
      {step === 'pick' && (
        <div className="wa-next">
          <button
            type="button"
            className="wa-send"
            aria-label="Next"
            disabled={picked.length === 0}
            onClick={() => setStep('details')}
          >
            <G n="arrowR" size={22} />
          </button>
        </div>
      )}
      {step === 'details' && (
        <div className="wa-next">
          <button
            type="button"
            className="wa-send"
            aria-label={kind === 'group' ? 'Create group' : 'Create announcement'}
            disabled={!title.trim() || busy}
            onClick={() =>
              create({
                kind,
                title: title.trim(),
                description: description.trim(),
                artistIds: picked,
                ...(kind === 'group' && ctx.isBmg ? { settings } : {}),
              })
            }
          >
            <G n="check" size={22} />
          </button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Share menu                                                               */
/* ------------------------------------------------------------------------ */

type ShareKind = 'upload' | 'document' | 'photo' | 'review' | 'gig' | 'todo' | 'event';
const SHARE: Record<ShareKind, { label: string; colour: string; icon: ReactNode }> = {
  upload: { label: 'Upload a file', colour: '#34506E', icon: <Icon name="upload" size={22} /> },
  document: { label: 'Document', colour: '#7A4FA3', icon: <Icon name="file" size={22} /> },
  photo: { label: 'Photo', colour: '#1F6F8B', icon: <G n="image" size={22} /> },
  review: { label: 'Submit for review', colour: '#D9534F', icon: <Icon name="upload" size={22} /> },
  gig: { label: 'Gig', colour: '#011935', icon: <Icon name="mic" size={22} /> },
  todo: { label: 'To-do', colour: '#2E7D4F', icon: <Icon name="todo" size={22} /> },
  event: { label: 'Event', colour: '#A0611C', icon: <Icon name="calendar" size={22} /> },
};

function SharePanel({
  ctx,
  conv,
  phone,
  onSend,
  onClose,
}: {
  ctx: ChatCtx;
  conv: ConversationSummary;
  phone: boolean;
  onSend: (a: ChatAttachment) => Promise<void>;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState<ShareKind | null>(null);
  const [items, setItems] = useState<
    { key: string; title: string; subtitle: string; attachment: ChatAttachment }[] | null
  >(null);
  const [status, setStatus] = useState<string | null>(null);
  // Documents (rev 10): browse the library's folders, one level at a time.
  const [docs, setDocs] = useState<{ files: FileItem[]; folders: Folder[] } | null>(null);
  const [docAt, setDocAt] = useState<string | null>(null);
  const [accept, setAccept] = useState('image/*');
  const fileInput = useRef<HTMLInputElement>(null);

  /** The artist this chat is about: the artist themself, or the one artist in a BMG direct chat. */
  const artistId = ctx.isBmg
    ? conv.type === 'bmg-artist'
      ? (conv.artists[0]?.artistId ?? null)
      : null
    : ctx.me.artistId;
  const filesAllowed =
    ctx.isBmg || conv.type !== 'group' || (conv.settings?.artistsShareFiles ?? true);
  const kinds: ShareKind[] = [
    ...(filesAllowed ? (['upload', 'document', 'photo'] as const) : []),
    'review',
    ...(artistId ? (['gig', 'todo'] as const) : []),
    ...(ctx.isBmg ? (['event'] as const) : []),
  ];

  async function pick(kind: ShareKind) {
    setStatus(null);
    if (kind === 'review') {
      onClose();
      ctx.onNavigate(ctx.isBmg ? 'review' : 'submit');
      return;
    }
    if (kind === 'photo' || kind === 'upload') {
      setAccept(kind === 'photo' ? 'image/*' : '');
      // Let the accept attribute update before the file dialog opens.
      requestAnimationFrame(() => fileInput.current?.click());
      return;
    }
    setPicking(kind);
    setItems(null);
    try {
      if (kind === 'document') {
        const path = ctx.isBmg ? '/library/files' : `/artists/${ctx.me.artistId}/files`;
        const [files, folders] = await Promise.all([
          api<{ files: FileItem[] }>(ctx.cfg, ctx.token, 'GET', path).then((r) => r.files),
          listFolders(ctx.cfg, ctx.token, foldersBase(path))
            .then((r) => r.folders)
            .catch(() => [] as Folder[]),
        ]);
        const usable = files.filter((f) => f.status === 'available' && f.visibility !== 'private');
        setDocAt(null);
        setDocs({ files: usable, folders });
        setItems(
          usable.map((f) => ({
            key: f.fileId,
            title: f.displayName,
            subtitle: `${f.fileType.label} · ${formatSize(f.size)}`,
            attachment: fileAttachment(f),
          })),
        );
      } else if (kind === 'gig' && artistId) {
        const gigs = (
          await api<{ gigs: Gig[] }>(ctx.cfg, ctx.token, 'GET', `/artists/${artistId}/gigs`)
        ).gigs;
        setItems(
          gigs.map((g) => {
            const sub = [shortDay(g.date), g.venue].filter(Boolean).join(' · ');
            return {
              key: g.gigId,
              title: g.title,
              subtitle: sub,
              attachment: { kind: 'gig', id: g.gigId, artistId, title: g.title, subtitle: sub },
            };
          }),
        );
      } else if (kind === 'todo' && artistId) {
        const todos = (
          await api<{ todos: Todo[] }>(ctx.cfg, ctx.token, 'GET', `/artists/${artistId}/todos`)
        ).todos;
        setItems(
          todos.map((t) => {
            const sub = t.due ? `Due ${shortDay(t.due)}` : 'No due date';
            return {
              key: t.todoId,
              title: t.title,
              subtitle: sub,
              attachment: { kind: 'todo', id: t.todoId, artistId, title: t.title, subtitle: sub },
            };
          }),
        );
      } else if (kind === 'event') {
        const events = (await api<{ events: EventLite[] }>(ctx.cfg, ctx.token, 'GET', '/events'))
          .events;
        setItems(
          events.map((ev) => {
            const sub = [shortDay(ev.date), ev.venue].filter(Boolean).join(' · ');
            return {
              key: ev.eventId,
              title: ev.name,
              subtitle: sub,
              attachment: { kind: 'event', id: ev.eventId, title: ev.name, subtitle: sub },
            };
          }),
        );
      }
    } catch (e) {
      setItems([]);
      setStatus((e as Error).message);
    }
  }

  function fileAttachment(f: FileItem): ChatAttachment {
    const where = f.scope === 'library' ? 'from the library' : 'from files';
    return {
      kind: 'file',
      id: f.fileId,
      scope: f.scope,
      ...(f.artistId ? { artistId: f.artistId } : {}),
      title: f.displayName,
      subtitle: `${f.fileType.label} · ${formatSize(f.size)} · ${where}`,
    };
  }

  async function uploadPhoto(file: File) {
    const target = ctx.isBmg
      ? conv.type === 'bmg-artist' && artistId
        ? { path: `/artists/${artistId}/files`, extra: { visibility: 'normal' } }
        : {
            path: '/library/files',
            extra: {
              sharing: 'selected',
              sharedWithArtistIds: conv.artists.map((a) => a.artistId),
            },
          }
      : {
          // An artist's upload goes into their own files and is shared with the
          // other artists in the chat. Between artists it's private: Blueprint
          // can't open it, like the chat itself (rev 7).
          path: `/artists/${ctx.me.artistId}/files`,
          extra: {
            visibility: conv.type === 'artist-to-artist' ? 'private' : 'normal',
            sharedWithArtistIds: conv.artists
              .map((a) => a.artistId)
              .filter((id) => id !== ctx.me.artistId),
          },
        };
    try {
      setStatus(`Uploading ${file.name}…`);
      const created = await uploadFile(ctx.cfg, ctx.token, target.path, file, target.extra);
      setStatus('Checking for malware…');
      const settled = await waitUntilScanned(
        ctx.cfg,
        ctx.token,
        `${target.path}/${created.fileId}`,
      );
      if (!settled)
        return setStatus(
          'Still checking it for malware. It’s in your files; share it from Document once it’s ready.',
        );
      if (settled.status === 'rejected')
        return setStatus(settled.rejectReason ?? 'That file was blocked by the malware scan.');
      await onSend(fileAttachment(settled));
      onClose();
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  const input = (
    <input
      ref={fileInput}
      type="file"
      accept={accept || undefined}
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) void uploadPhoto(f);
      }}
    />
  );

  if (picking) {
    // Documents show one folder level at a time; Back steps out of a folder first.
    const level =
      picking === 'document' && docs ? pickerLevel(docs.folders, docs.files, docAt) : null;
    const shown = level
      ? (items ?? []).filter((it) => level.files.some((f) => f.fileId === it.key))
      : items;
    return (
      <div
        className={phone ? 'wa-tray wa-tray-pick' : 'wa-share wa-share-pick'}
        role="dialog"
        aria-label={SHARE[picking].label}
      >
        <div className="wa-share-hd">
          <button
            type="button"
            className="ibtn"
            aria-label={
              level?.here
                ? `Back to ${level.here.parentId ? (docs!.folders.find((f) => f.folderId === level.here!.parentId)?.name ?? 'the folder above') : 'all documents'}`
                : 'Back'
            }
            onClick={() => (level?.here ? setDocAt(level.here.parentId ?? null) : setPicking(null))}
          >
            <Icon name="back" />
          </button>
          <b className="min-w-0 truncate">
            {level?.here ? level.here.name : `Share a ${SHARE[picking].label.toLowerCase()}`}
          </b>
        </div>
        <div className="wa-share-list">
          {!items && <WaveLoader />}
          {level?.folders.map((f) => (
            <button
              key={f.folderId}
              type="button"
              className="wa-share-item"
              onClick={() => setDocAt(f.folderId)}
            >
              <span className="wa-tag">
                <Icon name="folder" size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <b className="block truncate">{f.name}</b>
                <span className="wa-sub block truncate">Folder</span>
              </span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
          {shown?.length === 0 && !level?.folders.length && !status && (
            <p className="wa-empty">
              {level?.here ? 'Nothing in this folder.' : 'Nothing to share yet.'}
            </p>
          )}
          {status && (
            <p className="wa-empty" role="status">
              {status}
            </p>
          )}
          {shown?.map((it) => (
            <button
              key={it.key}
              type="button"
              className="wa-share-item"
              onClick={async () => {
                try {
                  await onSend(it.attachment);
                  onClose();
                } catch (e) {
                  setStatus((e as Error).message);
                }
              }}
            >
              <span className="wa-tag">{attachmentTag(it.attachment)}</span>
              <span className="min-w-0 flex-1">
                <b className="block truncate">{it.title}</b>
                <span className="wa-sub block truncate">{it.subtitle}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={phone ? 'wa-tray' : 'wa-share'} role="menu" aria-label="Share">
      {input}
      {kinds.map((k) => (
        <button
          key={k}
          type="button"
          role="menuitem"
          className={phone ? 'wa-tray-it' : 'wa-share-it'}
          onClick={() => void pick(k)}
        >
          <span className="wa-circ" style={{ background: SHARE[k].colour }}>
            {SHARE[k].icon}
          </span>
          <span>{SHARE[k].label}</span>
        </button>
      ))}
      {status && (
        <p className="wa-share-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

const shortDay = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

/* ------------------------------------------------------------------------ */
/* Conversation                                                             */
/* ------------------------------------------------------------------------ */

/** The API path for a shared file's download link (signed for the person asking). */
export function downloadPath(a: ChatAttachment): string | null {
  if (a.kind !== 'file') return null;
  if (a.scope === 'library') return `/library/files/${a.id}/download`;
  return a.artistId ? `/artists/${a.artistId}/files/${a.id}/download` : null;
}

function AttachmentCard({
  a,
  onOpen,
  ctx,
}: {
  a: ChatAttachment;
  onOpen: () => void;
  ctx?: ChatCtx;
}) {
  const tag = a.kind === 'event' ? a.subtitle.split(' · ')[0] || 'Event' : attachmentTag(a);
  const dl = downloadPath(a);
  const [state, setState] = useState<string | null>(null);
  async function download() {
    if (!ctx || !dl) return;
    setState('Getting the link…');
    try {
      const { url } = await api<{ url: string }>(ctx.cfg, ctx.token, 'POST', dl);
      setState(null);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      const msg = (e as Error).message;
      // Deleted since it was posted (rev 8): the card stays, the file doesn't.
      setState(/no such file/i.test(msg) ? 'This file was deleted' : msg);
    }
  }
  return (
    <span className="flex flex-col">
      <button
        type="button"
        className="wa-att"
        onClick={dl && ctx ? () => void download() : onOpen}
        aria-label={dl && ctx ? `Download ${a.title}` : `Open ${a.title}`}
      >
        <span className={`wa-tag wa-tag-${a.kind}`}>{tag}</span>
        <span className="min-w-0 flex-1">
          <b className="block truncate">{a.title}</b>
          <span className="wa-sub block truncate">{a.subtitle}</span>
        </span>
        {dl && ctx && <Icon name="download" size={18} />}
      </button>
      {state && (
        <span className="wa-sub px-1" role="status">
          {state}
        </span>
      )}
    </span>
  );
}

function Conversation({
  ctx,
  conv,
  inbox,
  phone,
  infoOpen,
  pendingReply,
  onPendingUsed,
  onBack,
  backLabel = 'Back to chats',
  backCount,
  onInfo,
  onReplyPrivately,
  searchSignal,
}: {
  ctx: ChatCtx;
  conv: ConversationSummary;
  inbox: Inbox;
  phone: boolean;
  infoOpen: boolean;
  pendingReply: PendingReply | null;
  onPendingUsed: () => void;
  onBack?: () => void;
  /** What the back button returns to (phone). */
  backLabel?: string;
  backCount?: number;
  onInfo: () => void;
  onReplyPrivately: (m: ChatMessage) => void;
  searchSignal: number;
}) {
  const thread = useThread(ctx, conv.conversationId, inbox.tick);
  const [text, setText] = useState('');
  const [reply, setReply] = useState<PendingReply | null>(null);
  const [emoji, setEmoji] = useState(false);
  const [share, setShare] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastCount = useRef(0);

  useEffect(() => {
    setText('');
    setReply(null);
    setEmoji(false);
    setShare(false);
    setMenu(false);
    setSearch(null);
    setError(null);
    lastCount.current = 0;
  }, [conv.conversationId]);

  useEffect(() => {
    if (pendingReply) {
      setReply(pendingReply);
      onPendingUsed();
      inputRef.current?.focus();
    }
  }, [pendingReply, onPendingUsed]);

  useEffect(() => {
    if (searchSignal) setSearch((s) => s ?? '');
  }, [searchSignal]);

  // Keep the newest message in view when messages arrive.
  useEffect(() => {
    const n = thread.messages.length;
    if (n > lastCount.current && scroller.current) {
      const divider = scroller.current.querySelector('.wa-unread');
      if (lastCount.current === 0 && divider) divider.scrollIntoView({ block: 'center' });
      else scroller.current.scrollTop = scroller.current.scrollHeight;
    }
    lastCount.current = n;
  }, [thread.messages.length]);

  const canSend = thread.page?.canSend ?? conv.canSend;
  const artistInAnnouncement = !ctx.isBmg && conv.type === 'announcement';

  async function post(body: Record<string, unknown>) {
    await api(
      ctx.cfg,
      ctx.token,
      'POST',
      `/conversations/${encodeURIComponent(conv.conversationId)}/messages`,
      body,
    );
    await thread.reload();
    void inbox.reload();
  }

  async function send() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await post({
        text: t,
        ...(reply
          ? {
              replyTo: {
                messageId: reply.messageId,
                conversationId: reply.conversationId ?? conv.conversationId,
              },
            }
          : {}),
      });
      setText('');
      setReply(null);
      setEmoji(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function me(change: Record<string, unknown>) {
    setError(null);
    try {
      await api(
        ctx.cfg,
        ctx.token,
        'PATCH',
        `/conversations/${encodeURIComponent(conv.conversationId)}/me`,
        change,
      );
      void inbox.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function react(m: ChatMessage, emoji: QuickReaction) {
    const before = m.reactions ?? [];
    const { next, send } = toggleReaction(before, emoji);
    thread.patchMessage(m.messageId, { reactions: next });
    setError(null);
    try {
      const res = await api<{ reactions: ReactionCount[] }>(
        ctx.cfg,
        ctx.token,
        'PATCH',
        `/conversations/${encodeURIComponent(conv.conversationId)}/me`,
        { react: { messageId: m.messageId, createdAt: m.createdAt, emoji: send } },
      );
      thread.patchMessage(m.messageId, { reactions: res.reactions });
    } catch (e) {
      thread.patchMessage(m.messageId, { reactions: before });
      setError((e as Error).message);
    }
  }

  async function star(m: ChatMessage) {
    thread.patchMessage(m.messageId, { starred: !m.starred });
    await me({ star: { messageId: m.messageId, starred: !m.starred } });
  }

  function exportTxt() {
    const lines = thread.messages.map((m) => {
      const d = new Date(m.createdAt);
      const when = `${d.toLocaleDateString('en-AU')}, ${clock(m.createdAt)}`;
      if (m.kind === 'system') return `[${when}] ${m.text}`;
      const att = m.attachment ? ` [${m.attachment.title}]` : '';
      return `[${when}] ${m.mine ? 'You' : m.senderName}: ${m.text}${att}`;
    });
    const blob = new Blob([`Chat: ${conv.title}\n\n${lines.join('\n')}\n`], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${conv.title.replace(/[^\w -]+/g, '').trim() || 'chat'}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const subtitle = isGroupish(conv.type)
    ? ['Blueprint', ...conv.artists.map((a) => firstName(a.displayName))].join(', ')
    : lastSeenText(conv.lastSeen) || (conv.private ? 'Private chat' : '');

  const q = (search ?? '').trim().toLowerCase();
  const visible = q
    ? thread.messages.filter(
        (m) =>
          m.text.toLowerCase().includes(q) ||
          (m.attachment?.title.toLowerCase().includes(q) ?? false),
      )
    : thread.messages;

  // Group into days, runs and the unread divider.
  const rows: ReactNode[] = [];
  let lastDay = '';
  let prev: ChatMessage | null = null;
  const anchor = q ? null : thread.unreadAnchor;
  const unreadN = anchor
    ? thread.messages.filter(
        (m) =>
          !m.mine &&
          m.kind === 'message' &&
          m.createdAt >= (thread.messages.find((x) => x.messageId === anchor)?.createdAt ?? '~'),
      ).length
    : 0;
  for (const m of visible) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      rows.push(
        <div key={`d-${day}`} className="wa-dayrow">
          <span className="wa-day">{dayPill(m.createdAt)}</span>
        </div>,
      );
      lastDay = day;
      prev = null;
    }
    if (anchor && m.messageId === anchor && unreadN > 0)
      rows.push(
        <div key="unread" className="wa-unread" role="separator">
          {unreadN} unread message{unreadN === 1 ? '' : 's'}
        </div>,
      );
    if (m.kind === 'system') {
      rows.push(
        <div key={m.messageId} className="wa-dayrow">
          <span className="wa-sys">{m.text}</span>
        </div>,
      );
      prev = null;
      continue;
    }
    const first =
      !prev ||
      prev.mine !== m.mine ||
      (prev.senderArtistId ?? prev.senderName) !== (m.senderArtistId ?? m.senderName);
    prev = m;
    rows.push(
      <MessageBubble
        key={m.messageId}
        ctx={ctx}
        m={m}
        first={first}
        showName={first && !m.mine && isGroupish(conv.type)}
        canReply={canSend}
        replyPrivately={artistInAnnouncement && !m.mine}
        onReply={() => {
          setReply({
            messageId: m.messageId,
            senderName: m.mine ? 'You' : m.senderName,
            text: m.text || m.attachment?.title || '',
          });
          inputRef.current?.focus();
        }}
        onReplyPrivately={() => onReplyPrivately(m)}
        onStar={() => void star(m)}
        onReact={(e) => void react(m, e)}
        onOpen={(a) => ctx.onNavigate(attachmentView(a, ctx.isBmg))}
      />,
    );
  }

  const readOnlyNote =
    conv.type === 'announcement'
      ? ctx.isBmg
        ? 'Only Blueprint can send to this announcement.'
        : 'Only Blueprint can send messages here. Use “Reply privately” on a message to answer in your Blueprint chat.'
      : conv.settings?.onlyAdminsSend
        ? 'Only admins can send messages to this group.'
        : 'You can’t send messages to this chat.';

  return (
    <section className="wa-pane" aria-label={`Chat with ${conv.title}`}>
      <div className="wa-hd">
        {onBack && (
          <button
            type="button"
            className="wa-backbtn"
            aria-label={`${backLabel}${backCount ? `, ${backCount} unread` : ''}`}
            onClick={onBack}
          >
            <Icon name="back" />
            {!!backCount && <span className="wa-backcount">{backCount}</span>}
          </button>
        )}
        <button
          type="button"
          className="wa-hd-who"
          onClick={onInfo}
          aria-label={`${conv.title} info`}
          aria-expanded={infoOpen}
        >
          <ChatAvatar c={conv} size={40} />
          <span className="min-w-0">
            <span className="wa-name block truncate">{conv.title}</span>
            {subtitle && <span className="wa-sub block truncate">{subtitle}</span>}
          </span>
        </button>
        <span className="ml-auto flex">
          <button
            type="button"
            className="ibtn"
            aria-label="Search in chat"
            aria-pressed={search !== null}
            onClick={() => setSearch((s) => (s === null ? '' : null))}
          >
            <Icon name="search" size={19} />
          </button>
          {!phone && (
            <button
              type="button"
              className="ibtn"
              aria-label={isGroupish(conv.type) ? 'Group info' : 'Contact info'}
              aria-pressed={infoOpen}
              onClick={onInfo}
            >
              <G n="info" />
            </button>
          )}
          <span className="relative">
            <button
              type="button"
              className="ibtn"
              aria-label="Chat menu"
              aria-expanded={menu}
              onClick={() => {
                setMenu((x) => !x);
                setConfirmClear(false);
              }}
            >
              <G n="more" />
            </button>
            {menu && (
              <span className="wa-menu wa-menu-r" role="menu">
                {phone && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onInfo();
                    }}
                  >
                    {isGroupish(conv.type) ? 'Group info' : 'Contact info'}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void me({ muted: !conv.muted });
                  }}
                >
                  {conv.muted ? 'Unmute notifications' : 'Mute notifications'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void me({ pinned: !conv.pinned });
                  }}
                >
                  {conv.pinned ? 'Unpin chat' : 'Pin chat'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void me({ archived: !conv.archived });
                  }}
                >
                  {conv.archived ? 'Unarchive chat' : 'Archive chat'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    exportTxt();
                  }}
                >
                  Export chat (.txt)
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="wa-danger"
                  onClick={async () => {
                    if (!confirmClear) return setConfirmClear(true);
                    setMenu(false);
                    setConfirmClear(false);
                    await me({ clear: true });
                    await thread.reload();
                  }}
                >
                  {confirmClear ? 'Click again to clear for you' : 'Clear chat'}
                </button>
              </span>
            )}
          </span>
        </span>
      </div>
      {search !== null && (
        <div className="wa-searchrow wa-searchrow-chat">
          <label className="search search-fill">
            <Icon name="search" size={16} />
            <input
              aria-label="Search this chat"
              placeholder="Search…"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <span className="wa-sub">{q ? `${visible.length} found` : ''}</span>
        </div>
      )}
      <div className="wa-wall" ref={scroller} aria-live="polite">
        {thread.hasOlder && !q && (
          <div className="wa-dayrow">
            <button
              type="button"
              className="wa-day wa-more"
              onClick={() => void thread.loadOlder()}
            >
              Load earlier messages
            </button>
          </div>
        )}
        {!thread.page && !thread.error && (
          <div className="wa-dayrow">
            <WaveLoader inline size={40} />
          </div>
        )}
        {thread.error && (
          <div className="wa-dayrow">
            <span className="wa-sys" role="alert">
              Couldn’t load messages: {thread.error}
            </span>
          </div>
        )}
        {conv.private && (
          <div className="wa-dayrow">
            <span className="wa-sys">
              <Icon name="lock" size={12} /> Chats between artists are private to them. Blueprint
              can’t see them.
            </span>
          </div>
        )}
        {thread.page && thread.messages.length === 0 && (
          <div className="wa-dayrow">
            <span className="wa-sys">No messages yet. Say hello 👋</span>
          </div>
        )}
        {rows}
      </div>
      {error && (
        <p className="wa-err" role="alert">
          {error}
        </p>
      )}
      {canSend ? (
        <div className="wa-composewrap">
          {reply && (
            <div className="wa-replybar">
              <div className="wa-quote flex-1">
                <b
                  style={{
                    color: reply.senderName === 'You' ? '#B5403C' : nameColour(reply.senderName),
                  }}
                >
                  {reply.conversationId
                    ? `Replying privately to ${reply.senderName}`
                    : reply.senderName}
                </b>
                <span className="block truncate">{reply.text}</span>
              </div>
              <button
                type="button"
                className="ibtn"
                aria-label="Cancel reply"
                onClick={() => setReply(null)}
              >
                <G n="x" size={18} />
              </button>
            </div>
          )}
          {emoji && (
            <EmojiPicker
              onPick={(e) => {
                // Insert at the cursor, not just at the end.
                const el = inputRef.current;
                const at = el?.selectionStart ?? null;
                setText((t) =>
                  at === null ? t + e : t.slice(0, at) + e + t.slice(el!.selectionEnd ?? at),
                );
                requestAnimationFrame(() => {
                  if (el && at !== null) el.setSelectionRange(at + e.length, at + e.length);
                  el?.focus();
                });
              }}
            />
          )}
          {share && (
            <SharePanel
              ctx={ctx}
              conv={conv}
              phone={phone}
              onClose={() => setShare(false)}
              onSend={(a) =>
                post({
                  text: '',
                  attachment: a,
                  ...(reply
                    ? {
                        replyTo: {
                          messageId: reply.messageId,
                          conversationId: reply.conversationId ?? conv.conversationId,
                        },
                      }
                    : {}),
                }).then(() => setReply(null))
              }
            />
          )}
          <div className="wa-compose">
            <button
              type="button"
              className="ibtn"
              aria-label="Emoji"
              aria-pressed={emoji}
              onClick={() => {
                setEmoji((x) => !x);
                setShare(false);
              }}
            >
              <G n="smile" size={22} />
            </button>
            <button
              type="button"
              className="ibtn"
              aria-label="Share"
              aria-expanded={share}
              onClick={() => {
                setShare((x) => !x);
                setEmoji(false);
              }}
            >
              <G n="plus" size={24} />
            </button>
            <input
              ref={inputRef}
              className="wa-input"
              aria-label="Type a message"
              placeholder="Type a message"
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {text.trim() ? (
              <button
                type="button"
                className="wa-send"
                aria-label="Send"
                disabled={sending}
                onClick={() => void send()}
              >
                <G n="send" size={20} />
              </button>
            ) : (
              <button
                type="button"
                className="ibtn"
                aria-label="Voice note"
                title="Voice notes are coming soon"
                disabled
              >
                <Icon name="mic" size={22} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="wa-readonly">{readOnlyNote}</p>
      )}
    </section>
  );
}

function MessageBubble({
  m,
  first,
  showName,
  canReply,
  replyPrivately,
  onReply,
  onReplyPrivately,
  onStar,
  onReact,
  onOpen,
  ctx,
}: {
  ctx: ChatCtx;
  m: ChatMessage;
  first: boolean;
  showName: boolean;
  canReply: boolean;
  replyPrivately: boolean;
  onReply: () => void;
  onReplyPrivately: () => void;
  onStar: () => void;
  onReact: (emoji: QuickReaction) => void;
  onOpen: (a: ChatAttachment) => void;
}) {
  const reactions = m.reactions ?? [];
  return (
    <div
      className={`wa-msgrow ${m.mine ? 'wa-msgrow-out' : ''} ${reactions.length ? 'wa-msgrow-reacted' : ''}`}
    >
      <div className={`wa-msg ${m.mine ? 'wa-out' : ''} ${first ? 'wa-first' : ''}`} tabIndex={0}>
        {showName && (
          <span className="wa-from" style={{ color: nameColour(m.senderName) }}>
            {m.senderName}
          </span>
        )}
        {m.replyTo && (
          <span className="wa-quote">
            <b style={{ color: nameColour(m.replyTo.senderName) }}>{m.replyTo.senderName}</b>
            <span className="block">{m.replyTo.text}</span>
          </span>
        )}
        {m.attachment && (
          <AttachmentCard a={m.attachment} ctx={ctx} onOpen={() => onOpen(m.attachment!)} />
        )}
        {m.text && <span className="wa-text">{m.text}</span>}
        <span className="wa-meta">
          {m.starred && <G n="star" size={11} filled className="wa-staricon" />}
          {clock(m.createdAt)}
          {m.mine && <Ticks t={m.ticks} />}
        </span>
        {replyPrivately && (
          <button type="button" className="wa-privreply" onClick={onReplyPrivately}>
            <G n="reply" size={14} /> Reply privately
          </button>
        )}
        <span className="wa-acts">
          <span className="wa-quickreacts" role="group" aria-label="React">
            {QUICK_REACTIONS.map((q) => {
              const on = reactions.some((r) => r.mine && r.emoji === q.emoji);
              return (
                <button
                  key={q.emoji}
                  type="button"
                  className="wa-actbtn wa-reactbtn"
                  aria-label={
                    on ? `Remove ${q.label.toLowerCase()}` : `React ${q.label.toLowerCase()}`
                  }
                  aria-pressed={on}
                  title={q.label}
                  onClick={() => onReact(q.emoji)}
                >
                  <span aria-hidden="true">{q.emoji}</span>
                </button>
              );
            })}
          </span>
          {canReply && !replyPrivately && (
            <button
              type="button"
              className="wa-actbtn"
              aria-label="Reply"
              title="Reply"
              onClick={onReply}
            >
              <G n="reply" size={16} />
            </button>
          )}
          <button
            type="button"
            className="wa-actbtn"
            aria-label={m.starred ? 'Unstar' : 'Star'}
            aria-pressed={m.starred}
            title={m.starred ? 'Unstar' : 'Star'}
            onClick={onStar}
          >
            <G n="star" size={16} filled={m.starred} />
          </button>
        </span>
        {reactions.length > 0 && (
          <span className="wa-reactions">
            {reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`wa-reaction ${r.mine ? 'wa-reaction-mine' : ''}`}
                aria-pressed={r.mine}
                aria-label={`${r.emoji} ${r.count}: ${r.names.join(', ')}${r.mine ? '. Tap to remove yours' : ''}`}
                title={r.names.join(', ')}
                onClick={() => onReact(r.emoji)}
              >
                <span aria-hidden="true">{r.emoji}</span>
                {r.count > 1 && <span className="wa-reaction-n">{r.count}</span>}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Info panes                                                               */
/* ------------------------------------------------------------------------ */

/** Attachments and starred messages for the info panes, read from the open thread. */
function useThreadExtras(ctx: ChatCtx, conversationId: string, tick: number) {
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  useEffect(() => {
    let live = true;
    api<ThreadPage>(
      ctx.cfg,
      ctx.token,
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
    )
      .then((p) => live && setMsgs(p.messages))
      .catch(() => live && setMsgs([]));
    return () => {
      live = false;
    };
  }, [ctx.cfg, ctx.token, conversationId, tick]);
  return {
    attachments: msgs.filter((m) => m.attachment).map((m) => m.attachment!),
    starred: msgs.filter((m) => m.starred && m.kind === 'message'),
  };
}

function MediaGrid({ ctx, items }: { ctx: ChatCtx; items: ChatAttachment[] }) {
  if (!items.length) return <p className="wa-sub">No media, links or docs yet.</p>;
  return (
    <div className="wa-media">
      {items
        .slice(-6)
        .reverse()
        .map((a, i) => (
          <button
            key={`${a.id}-${i}`}
            type="button"
            className="wa-tile"
            title={a.title}
            onClick={() => ctx.onNavigate(attachmentView(a, ctx.isBmg))}
          >
            <span className={`wa-tag wa-tag-${a.kind}`}>{attachmentTag(a)}</span>
            <span className="wa-tile-t">{a.title}</span>
          </button>
        ))}
    </div>
  );
}

function InfoShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="wa-info" aria-label={title}>
      <div className="wa-hd">
        <button
          type="button"
          className="ibtn"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
        >
          <G n="x" />
        </button>
        <h2 className="wa-hd-title">{title}</h2>
      </div>
      <div className="wa-scroll">{children}</div>
    </aside>
  );
}

function GroupInfo({
  ctx,
  conv,
  inbox,
  roster,
  onClose,
  onSearch,
  onGone,
}: {
  ctx: ChatCtx;
  conv: ConversationSummary;
  inbox: Inbox;
  roster: Person[];
  onClose: () => void;
  onSearch: () => void;
  onGone: () => void;
}) {
  const extras = useThreadExtras(ctx, conv.conversationId, inbox.tick);
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(conv.description ?? '');
  const [adding, setAdding] = useState(false);
  const [addPick, setAddPick] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'delete' | 'exit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = ctx.me.role === 'bmg-admin';
  const isGroup = conv.type === 'group';
  const canAdd = ctx.isBmg || (isGroup && !!conv.settings?.artistsAddMembers);
  const path = `/conversations/${encodeURIComponent(conv.conversationId)}`;
  useEffect(() => setDesc(conv.description ?? ''), [conv.description]);

  async function call(method: 'PATCH' | 'POST' | 'DELETE', p: string, body?: unknown) {
    setError(null);
    try {
      await api(ctx.cfg, ctx.token, method, p, body);
      await inbox.reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  const settings = conv.settings ?? DEFAULT_SETTINGS;
  const memberIds = new Set(conv.artists.map((a) => a.artistId));
  const addable = roster.filter((a) => !memberIds.has(a.artistId));

  return (
    <InfoShell title={isGroup ? 'Group info' : 'Announcement info'} onClose={onClose}>
      <div className="wa-sec wa-sec-hero">
        <ChatAvatar c={conv} size={96} />
        <h3 className="wa-hero-name">{conv.title}</h3>
        <span className="wa-sub">
          {isGroup ? 'Group' : 'Announcement'} · {conv.artists.length + 1} members
        </span>
        <div className="wa-acts-row">
          <button type="button" className="wa-act" onClick={onSearch}>
            <Icon name="search" size={20} />
            Search
          </button>
          <button
            type="button"
            className="wa-act"
            aria-pressed={conv.muted}
            onClick={() => void call('PATCH', `${path}/me`, { muted: !conv.muted })}
          >
            <G n="muted" />
            {conv.muted ? 'Unmute' : 'Mute'}
          </button>
          {canAdd && (
            <button type="button" className="wa-act" onClick={() => setAdding(true)}>
              <G n="userplus" />
              Add
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="wa-err" role="alert">
          {error}
        </p>
      )}
      <div className="wa-sec">
        <div className="wa-sechd">Description</div>
        {editing ? (
          <>
            <textarea
              className="wa-line"
              rows={3}
              maxLength={500}
              value={desc}
              aria-label="Description"
              onChange={(e) => setDesc(e.target.value)}
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="wa-pill"
                aria-pressed="true"
                onClick={async () => {
                  if (await call('PATCH', path, { description: desc.trim() })) setEditing(false);
                }}
              >
                Save
              </button>
              <button type="button" className="wa-pill" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-start gap-2">
            <p className="m-0 flex-1 whitespace-pre-wrap">
              {conv.description || <i className="wa-sub">No description</i>}
            </p>
            {ctx.isBmg && (
              <button
                type="button"
                className="ibtn"
                aria-label="Edit description"
                onClick={() => setEditing(true)}
              >
                <Icon name="pencil" size={18} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="wa-sec">
        <div className="wa-sechd">
          Media, links and docs <span className="wa-sub">{extras.attachments.length || ''}</span>
        </div>
        <MediaGrid ctx={ctx} items={extras.attachments} />
      </div>
      <div className="wa-sec wa-sec-flush">
        <div className="wa-sechd wa-pad">{conv.artists.length + 1} members</div>
        {canAdd && !adding && (
          <button type="button" className="wa-mem" onClick={() => setAdding(true)}>
            <span className="av wa-av-act">
              <G n="userplus" />
            </span>
            <span className="flex-1 text-left font-bold">Add member</span>
          </button>
        )}
        {adding && (
          <div className="wa-addbox">
            {addable.length === 0 && <p className="wa-sub">Everyone’s already here.</p>}
            {addable.map((a) => (
              <label key={a.artistId} className="wa-mem">
                <Avatar name={a.displayName} artistId={a.artistId} size={40} />
                <span className="flex-1">{a.displayName}</span>
                <input
                  type="checkbox"
                  className="chk"
                  checked={addPick.includes(a.artistId)}
                  onChange={(e) =>
                    setAddPick((p) =>
                      e.target.checked ? [...p, a.artistId] : p.filter((x) => x !== a.artistId),
                    )
                  }
                />
              </label>
            ))}
            <div className="flex gap-2 px-4 py-2">
              <button
                type="button"
                className="wa-pill"
                aria-pressed="true"
                disabled={!addPick.length}
                onClick={async () => {
                  if (await call('POST', `${path}/members`, { artistIds: addPick })) {
                    setAddPick([]);
                    setAdding(false);
                  }
                }}
              >
                Add {addPick.length || ''}
              </button>
              <button
                type="button"
                className="wa-pill"
                onClick={() => {
                  setAdding(false);
                  setAddPick([]);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="wa-mem">
          <Avatar name="Blueprint" size={40} />
          <span className="flex-1">
            <b className="block">Blueprint{ctx.isBmg ? ' (You)' : ''}</b>
            <span className="wa-sub">Blueprint Music Group</span>
          </span>
          <span className="wa-badge">Group admin</span>
        </div>
        {conv.artists.map((a) => (
          <div key={a.artistId} className="wa-mem">
            <Avatar name={a.displayName} artistId={a.artistId} size={40} />
            <span className="flex-1">
              <b className="block">
                {a.displayName}
                {a.artistId === ctx.me.artistId ? ' (You)' : ''}
              </b>
              <span className="wa-sub">Artist</span>
            </span>
            {ctx.isBmg && isGroup && (
              <button
                type="button"
                className="ibtn"
                aria-label={`Remove ${a.displayName}`}
                title="Remove from group"
                onClick={() =>
                  void call('DELETE', `${path}/members/${encodeURIComponent(a.artistId)}`)
                }
              >
                <G n="x" size={18} />
              </button>
            )}
          </div>
        ))}
      </div>
      {ctx.isBmg && isGroup && (
        <div className="wa-sec">
          <div className="wa-sechd">Group settings</div>
          {(
            [
              ['onlyAdminsSend', 'Only admins can send messages'],
              ['artistsShareFiles', 'Artists can share files'],
              ['artistsAddMembers', 'Artists can add members'],
            ] as const
          ).map(([k, label]) => (
            <SettingSwitch
              key={k}
              label={label}
              checked={settings[k]}
              onChange={(v) => void call('PATCH', path, { settings: { ...settings, [k]: v } })}
            />
          ))}
        </div>
      )}
      <div className="wa-sec wa-sec-flush">
        <button
          type="button"
          className="wa-mem wa-danger"
          onClick={async () => {
            if (await call('PATCH', `${path}/me`, { archived: !conv.archived })) onGone();
          }}
        >
          <G n="archive" /> {conv.archived ? 'Unarchive' : 'Archive'}{' '}
          {isGroup ? 'group' : 'announcement'}
        </button>
        {!ctx.isBmg && isGroup && ctx.me.artistId && (
          <button
            type="button"
            className="wa-mem wa-danger"
            onClick={async () => {
              if (confirm !== 'exit') return setConfirm('exit');
              if (await call('DELETE', `${path}/members/${encodeURIComponent(ctx.me.artistId!)}`))
                onGone();
            }}
          >
            <G n="exit" /> {confirm === 'exit' ? 'Click again to leave' : 'Exit group'}
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            className="wa-mem wa-danger"
            onClick={async () => {
              if (confirm !== 'delete') return setConfirm('delete');
              if (await call('DELETE', path)) onGone();
            }}
          >
            <Icon name="trash" />{' '}
            {confirm === 'delete'
              ? 'Click again to delete for everyone'
              : `Delete ${isGroup ? 'group' : 'announcement'}`}
          </button>
        )}
      </div>
    </InfoShell>
  );
}

function ContactInfo({
  ctx,
  conv,
  inbox,
  onClose,
  onOpenChat,
}: {
  ctx: ChatCtx;
  conv: ConversationSummary;
  inbox: Inbox;
  onClose: () => void;
  onOpenChat?: (id: string) => void;
}) {
  const extras = useThreadExtras(ctx, conv.conversationId, inbox.tick);
  const other = ctx.isBmg
    ? conv.artists[0]
    : conv.artists.find((a) => a.artistId !== ctx.me.artistId);
  // Groups in common: for BMG, groups with this artist; for an artist, groups with
  // the other artist (or every group, when the other side is Blueprint).
  const common = (inbox.conversations ?? []).filter(
    (c) => c.type === 'group' && (!other || c.artists.some((a) => a.artistId === other.artistId)),
  );
  const path = `/conversations/${encodeURIComponent(conv.conversationId)}/me`;
  return (
    <InfoShell title="Contact info" onClose={onClose}>
      <div className="wa-sec wa-sec-hero">
        <Avatar
          name={conv.title}
          artistId={conv.artists.find((a) => a.displayName === conv.title)?.artistId}
          size={96}
        />
        <h3 className="wa-hero-name">{conv.title}</h3>
        <span className="wa-sub">
          {lastSeenText(conv.lastSeen) || (other ? 'Artist' : 'Blueprint Music Group')}
        </span>
        {conv.private && (
          <span className="wa-sub">
            <Icon name="lock" size={12} /> Private between artists
          </span>
        )}
      </div>
      <div className="wa-sec">
        <div className="wa-sechd">
          Media, links and docs <span className="wa-sub">{extras.attachments.length || ''}</span>
        </div>
        <MediaGrid ctx={ctx} items={extras.attachments} />
      </div>
      <div className="wa-sec">
        <div className="wa-sechd">Starred messages</div>
        {extras.starred.length === 0 && (
          <p className="wa-sub m-0">None yet. Star a message to keep it here.</p>
        )}
        {extras.starred.map((m) => (
          <div key={m.messageId} className="wa-starred">
            <span className="wa-sub">
              {m.mine ? 'You' : m.senderName} · {listTime(m.createdAt)}
            </span>
            <span className="block truncate">{m.text || m.attachment?.title}</span>
          </div>
        ))}
      </div>
      <div className="wa-sec">
        <SettingSwitch
          label="Mute notifications"
          hint="No email or push for this chat"
          checked={conv.muted}
          onChange={(v) => {
            void api(ctx.cfg, ctx.token, 'PATCH', path, { muted: v }).then(() => inbox.reload());
          }}
        />
      </div>
      <div className="wa-sec wa-sec-flush">
        <div className="wa-sechd wa-pad">
          {common.length} group{common.length === 1 ? '' : 's'} in common
        </div>
        {common.map((g) => (
          <button
            key={g.conversationId}
            type="button"
            className="wa-mem"
            onClick={() => onOpenChat?.(g.conversationId)}
            disabled={!onOpenChat}
          >
            <ChatAvatar c={g} size={40} />
            <span className="min-w-0 flex-1 text-left">
              <b className="block truncate">{g.title}</b>
              <span className="wa-sub block truncate">
                {['Blueprint', ...g.artists.map((a) => firstName(a.displayName))].join(', ')}
              </span>
            </span>
          </button>
        ))}
      </div>
    </InfoShell>
  );
}

/* ------------------------------------------------------------------------ */
/* Screens                                                                  */
/* ------------------------------------------------------------------------ */

interface ChatProps {
  cfg: AppConfig;
  token: string;
  me: Me;
  /** BMG: the roster for new chats and adding members. Artists use /directory. */
  artists?: Person[];
  /** Opens a view in the host app (attachment cards, Submit for review). */
  onNavigate?: (view: string) => void;
  /** Open this conversation first (deep links, "Open in Chat"). */
  initialConversationId?: string | null;
}

function Chat({
  cfg,
  token,
  me,
  artists,
  onNavigate,
  initialConversationId,
  phone,
}: ChatProps & { phone: boolean }) {
  const ctx = useMemo<ChatCtx>(
    () => ({
      cfg,
      token,
      me,
      isBmg: me.role !== 'artist',
      onNavigate: onNavigate ?? (() => undefined),
    }),
    [cfg, token, me, onNavigate],
  );
  const inbox = useInbox(cfg, token, me);
  const rosterInput = useMemo(
    () => artists?.map((a) => ({ artistId: a.artistId, displayName: a.displayName })),
    [artists],
  );
  const roster = useRoster(ctx, rosterInput);
  const [activeId, setActiveId] = useState<string | null>(initialConversationId ?? null);
  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [info, setInfo] = useState(false);
  const [pending, setPending] = useState<PendingReply | null>(null);
  const [searchSignal, setSearchSignal] = useState(0);

  useEffect(() => {
    if (initialConversationId) setActiveId(initialConversationId);
  }, [initialConversationId]);

  // Desktop opens the newest chat so the three panes aren't empty.
  const list = inbox.conversations;
  useEffect(() => {
    if (!phone && !activeId && list?.length) {
      const first = sortChats(list.filter((c) => !c.archived))[0];
      if (first) setActiveId(first.conversationId);
    }
  }, [phone, activeId, list]);

  const active = list?.find((c) => c.conversationId === activeId) ?? null;
  const usePending = useCallback(() => setPending(null), []);

  async function replyPrivately(m: ChatMessage) {
    if (!active) return;
    const dm = list?.find((c) => c.type === 'bmg-artist');
    try {
      if (!dm) {
        const { conversationId } = await api<{ conversationId: string }>(
          cfg,
          token,
          'POST',
          '/conversations',
          { kind: 'direct' },
        );
        await inbox.reload();
        setActiveId(conversationId);
      } else setActiveId(dm.conversationId);
      setPending({
        messageId: m.messageId,
        senderName: `${active.title}`,
        text: m.text || m.attachment?.title || '',
        conversationId: active.conversationId,
      });
      setInfo(false);
    } catch {
      /* the composer shows errors on send */
    }
  }

  const open = (id: string) => {
    setActiveId(id);
    setMode('list');
    setInfo(false);
  };

  const left =
    mode === 'new' ? (
      <NewChat
        ctx={ctx}
        roster={roster}
        phone={phone}
        onClose={() => setMode('list')}
        onCreated={async (id) => {
          await inbox.reload();
          open(id);
        }}
      />
    ) : (
      <ChatList
        ctx={ctx}
        inbox={inbox}
        activeId={activeId}
        phone={phone}
        onOpen={open}
        onNew={() => setMode('new')}
      />
    );

  const infoPane =
    active && info ? (
      isGroupish(active.type) ? (
        <GroupInfo
          ctx={ctx}
          conv={active}
          inbox={inbox}
          roster={roster}
          onClose={() => setInfo(false)}
          onSearch={() => {
            setSearchSignal((n) => n + 1);
            if (phone) setInfo(false);
          }}
          onGone={() => {
            setInfo(false);
            setActiveId(null);
          }}
        />
      ) : (
        <ContactInfo
          ctx={ctx}
          conv={active}
          inbox={inbox}
          onClose={() => setInfo(false)}
          onOpenChat={open}
        />
      )
    ) : null;

  const pane = active ? (
    <Conversation
      ctx={ctx}
      conv={active}
      inbox={inbox}
      phone={phone}
      infoOpen={info}
      pendingReply={pending}
      onPendingUsed={usePending}
      onBack={phone ? () => setActiveId(null) : undefined}
      backCount={
        (list ?? []).filter(
          (c) => c.conversationId !== activeId && !c.archived && c.unreadCount > 0,
        ).length
      }
      onInfo={() => setInfo((x) => !x)}
      onReplyPrivately={(m) => void replyPrivately(m)}
      searchSignal={searchSignal}
    />
  ) : null;

  if (phone) {
    return <div className="wa wa-phone">{infoPane ?? pane ?? left}</div>;
  }
  return (
    <div className="wa">
      {left}
      {pane ?? (
        <section className="wa-pane wa-pane-empty">
          <div className="wa-emptyhero">
            <G n="newchat" size={48} />
            <p className="wa-name">Chat with your artists</p>
            <p className="wa-sub">Pick a chat on the left, or start a new one.</p>
            <p className="wa-sub">
              <Icon name="lock" size={12} /> Chats between artists are private to them. Blueprint
              can’t see them.
            </p>
          </div>
        </section>
      )}
      {infoPane}
    </div>
  );
}

/** Blueprint's Chat page: list, conversation and info side by side. */
export function BmgChat(props: Omit<ChatProps, 'artists'> & { artists: ArtistSummary[] }) {
  const narrow = useNarrow();
  return <Chat {...props} phone={narrow} />;
}
/** @deprecated Use BmgChat. */
export const BmgMessages = BmgChat;

/** The artist's Chat screen: phone layout on small screens, three panes on desktop. */
export function ArtistChats(props: ChatProps) {
  const narrow = useNarrow();
  return <Chat {...props} phone={narrow} />;
}

/** Workspace → Chat tab: Blueprint's direct chat with this artist, WhatsApp layout. */
export function ArtistChatTab({
  cfg,
  token,
  me,
  artist,
  onNavigate,
  onOpenChat,
  onBack,
  panel = false,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artist: ArtistSummary;
  onNavigate?: (view: string) => void;
  onOpenChat?: (conversationId: string) => void;
  /** Phone: leaves the full-screen chat for the rest of the workspace. Panel: closes the panel. */
  onBack?: () => void;
  /** Workspace side panel (rev 9): the narrow phone layout beside the open tab. */
  panel?: boolean;
}) {
  const ctx = useMemo<ChatCtx>(
    () => ({
      cfg,
      token,
      me,
      isBmg: me.role !== 'artist',
      onNavigate: onNavigate ?? (() => undefined),
    }),
    [cfg, token, me, onNavigate],
  );
  const inbox = useInbox(cfg, token, me);
  // The side panel is phone-width, so it uses the phone layout on any screen.
  const narrow = useNarrow() || panel;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Phone opens on the conversation (composer in reach); desktop shows contact info beside it.
  const [info, setInfo] = useState(!narrow);
  useEffect(() => {
    let live = true;
    setConversationId(null);
    api<{ conversationId: string }>(cfg, token, 'POST', '/conversations', {
      kind: 'direct',
      artistId: artist.artistId,
    })
      .then((r) => {
        if (!live) return;
        setConversationId(r.conversationId);
        void inbox.reload();
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [cfg, token, artist.artistId, inbox.reload]);
  const conv = inbox.conversations?.find((c) => c.conversationId === conversationId) ?? null;
  const noop = useCallback(() => undefined, []);

  if (error)
    return (
      <p className="wa-err" role="alert">
        Couldn’t open the chat: {error}
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {onOpenChat && conversationId && (!narrow || panel) && (
        <div className="flex justify-end">
          <button type="button" className="wa-link" onClick={() => onOpenChat(conversationId)}>
            Open in Chat <Icon name="arrow" size={14} />
          </button>
        </div>
      )}
      <div className={`wa wa-tab ${narrow ? 'wa-phone' : ''} ${panel ? 'wa-panel' : ''}`}>
        {conv ? (
          <>
            {!(narrow && info) && (
              <Conversation
                ctx={ctx}
                conv={conv}
                inbox={inbox}
                phone={narrow}
                infoOpen={info}
                pendingReply={null}
                onPendingUsed={noop}
                onBack={narrow ? onBack : undefined}
                backLabel={`Back to ${artist.displayName}’s workspace`}
                onInfo={() => setInfo((x) => !x)}
                onReplyPrivately={noop}
                searchSignal={0}
              />
            )}
            {info && (
              <ContactInfo
                ctx={ctx}
                conv={conv}
                inbox={inbox}
                onClose={() => setInfo(false)}
                onOpenChat={onOpenChat}
              />
            )}
          </>
        ) : (
          <section className="wa-pane wa-pane-empty">
            <WaveLoader label={`Opening the chat with ${artist.displayName}`} />
          </section>
        )}
      </div>
    </div>
  );
}
