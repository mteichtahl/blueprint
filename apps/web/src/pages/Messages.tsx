import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ArtistSummary, type Me } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { inboxChannels, subscribeInbox } from '../lib/realtime.ts';
import { Avatar, Button, Card, Field, Icon, Notice, Tag } from '../components/ui.tsx';

export interface ConversationSummary {
  conversationId: string;
  type: 'bmg-artist' | 'group' | 'broadcast' | 'artist-to-artist';
  title: string;
  artists: { artistId: string; displayName: string }[];
  access: 'read-write' | 'read';
  lastMessageAt: string | null;
  preview: string | null;
  unread: boolean;
}

interface Message {
  messageId: string;
  text: string;
  senderName: string;
  senderRole: string;
  mine: boolean;
  createdAt: string;
}

const time = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
};

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

  return { conversations, error, reload: load, tick };
}

function ConversationAvatar({ c }: { c: ConversationSummary }) {
  if (c.type === 'broadcast')
    return <span className="av bg-[#E6E9ED] text-[11px] text-[#011935]">ALL</span>;
  if (c.type === 'group')
    return (
      <span className="av bg-[#5C6775] text-[#F1F4F7]">
        <Icon name="users" size={18} />
      </span>
    );
  return <Avatar name={c.title} />;
}

function ConversationRow({
  c,
  active,
  onOpen,
}: {
  c: ConversationSummary;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active || undefined}
      className={`flex min-h-[60px] w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left ${active ? 'bg-secondary' : 'hover:bg-secondary/60'}`}
    >
      <ConversationAvatar c={c} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <b className="truncate">{c.title}</b>
          {c.type === 'artist-to-artist' && <Tag tone="s">Private</Tag>}
        </span>
        <span className="src block truncate">{c.preview ?? 'No messages yet'}</span>
      </span>
      <span className="flex flex-col items-end gap-1">
        {c.lastMessageAt && <span className="src">{time(c.lastMessageAt)}</span>}
        {c.unread && <Tag tone="k">New</Tag>}
      </span>
    </button>
  );
}

/** One conversation: bubbles plus a composer (hidden where the viewer can only read). */
export function Thread({
  cfg,
  token,
  conversationId,
  title,
  canWrite = true,
  refreshKey,
  onSent,
  compact = false,
}: {
  cfg: AppConfig;
  token: string;
  conversationId: string;
  title?: string;
  canWrite?: boolean;
  /** Changes when a realtime nudge arrives. */
  refreshKey?: number;
  onSent?: () => void;
  compact?: boolean;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const path = `/conversations/${conversationId}/messages`;

  const load = useCallback(async () => {
    try {
      setMessages((await api<{ messages: Message[] }>(cfg, token, 'GET', path)).messages);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, path]);
  useEffect(() => {
    setMessages(null);
  }, [conversationId]);
  useEffect(() => void load(), [load, refreshKey]);
  useEffect(() => {
    // Braces matter: newer browsers return a promise from scrollIntoView.
    void end.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(cfg, token, 'POST', path, { text });
      setText('');
      await load();
      onSent?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex min-h-0 flex-col gap-3 ${compact ? '' : 'h-full'}`}>
      {title && (
        <div className="card-hd border-b border-border pb-3">
          <h2 className="t text-[22px]">{title}</h2>
        </div>
      )}
      <div
        className={`flex flex-1 flex-col gap-2.5 overflow-y-auto ${compact ? '' : 'min-h-[320px]'}`}
      >
        {messages === null && <p className="src">Loading…</p>}
        {messages?.length === 0 && <p className="src">No messages yet. Say hello.</p>}
        {messages?.map((m, i) => {
          const showName = !m.mine && messages[i - 1]?.senderName !== m.senderName;
          return (
            <div
              key={m.messageId}
              className={`flex flex-col ${m.mine ? 'items-end' : 'items-start'}`}
            >
              {showName && <span className="src mb-1 font-bold">{m.senderName}</span>}
              <div className={`bubble ${m.mine ? 'b-out' : 'b-in'}`}>{m.text}</div>
              <span className="src mt-0.5 text-[11px]">{time(m.createdAt)}</span>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {canWrite ? (
        <form
          className="flex min-h-[50px] items-center gap-2 rounded-[10px] border border-input bg-card py-1 pr-1.5 pl-3.5 shadow-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className="flex-1">
            <span className="sr-only">Message</span>
            <input
              className="w-full border-0 bg-transparent text-base outline-none"
              placeholder="Write a message…"
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" variant="cta" disabled={busy || !text.trim()}>
            Send
          </Button>
        </form>
      ) : (
        <p className="src m-0 text-center">Only Blueprint posts here.</p>
      )}
    </div>
  );
}

/** BMG's Messages & groups: list with New chat / New group, thread on the right. */
export function BmgMessages({
  cfg,
  token,
  me,
  artists,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artists: ArtistSummary[];
}) {
  const { conversations, error, reload, tick } = useInbox(cfg, token, me);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<'chat' | 'group' | null>(null);
  const open = conversations?.find((c) => c.conversationId === openId) ?? conversations?.[0];

  async function start(body: Record<string, unknown>) {
    const res = await api<{ conversationId: string }>(cfg, token, 'POST', '/conversations', body);
    setCreating(null);
    await reload();
    setOpenId(res.conversationId);
  }

  return (
    <div className="flex flex-wrap items-stretch gap-5">
      <Card
        className="flex-[1_1_320px] gap-2 p-3"
        title={<h2 className="t px-2 pt-2 text-[19px]">Conversations</h2>}
        action={
          <span className="flex gap-2 pt-2 pr-2">
            <Button size="sm" variant="ghost" onClick={() => setCreating('chat')}>
              New chat
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating('group')}>
              New group
            </Button>
          </span>
        }
      >
        {error && <Notice tone="error">{error}</Notice>}
        {creating && (
          <NewConversationForm
            kind={creating}
            artists={artists}
            onCancel={() => setCreating(null)}
            onCreate={start}
          />
        )}
        {conversations === null && <p className="src px-2">Loading…</p>}
        {conversations?.map((c) => (
          <ConversationRow
            key={c.conversationId}
            c={c}
            active={open?.conversationId === c.conversationId}
            onOpen={() => setOpenId(c.conversationId)}
          />
        ))}
        <p className="src px-2 pt-2">Artist-to-artist chats stay private to the two artists.</p>
      </Card>
      <Card className="min-h-[520px] flex-[2_1_520px]">
        {open ? (
          <Thread
            cfg={cfg}
            token={token}
            conversationId={open.conversationId}
            title={open.type === 'broadcast' ? 'All artists · broadcast' : open.title}
            refreshKey={tick}
            onSent={() => void reload()}
          />
        ) : (
          <p className="src">Pick a conversation.</p>
        )}
      </Card>
    </div>
  );
}

function NewConversationForm({
  kind,
  artists,
  onCancel,
  onCreate,
}: {
  kind: 'chat' | 'group';
  artists: ArtistSummary[];
  onCancel: () => void;
  onCreate: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [artistId, setArtistId] = useState(artists[0]?.artistId ?? '');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    onCreate(
      kind === 'chat' ? { kind: 'direct', artistId } : { kind: 'group', title, artistIds: picked },
    ).catch((e) => setError((e as Error).message));

  return (
    <div className="tile gap-3">
      {kind === 'chat' ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-[15px] font-bold">Message an artist</span>
          <select className="dd" value={artistId} onChange={(e) => setArtistId(e.target.value)}>
            {artists.map((a) => (
              <option key={a.artistId} value={a.artistId}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <Field
            label="Group name"
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
          />
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0 text-[15px]">
            <legend className="mb-1 font-bold">Artists</legend>
            {artists.map((a) => (
              <label key={a.artistId} className="flex items-center gap-2">
                <input
                  className="chk"
                  type="checkbox"
                  checked={picked.includes(a.artistId)}
                  onChange={(e) =>
                    setPicked((p) =>
                      e.target.checked ? [...p, a.artistId] : p.filter((x) => x !== a.artistId),
                    )
                  }
                />
                {a.displayName}
              </label>
            ))}
          </fieldset>
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="cta"
          disabled={kind === 'chat' ? !artistId : !title.trim() || picked.length === 0}
          onClick={() => void submit()}
        >
          {kind === 'chat' ? 'Open chat' : 'Create group'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Workspace Chat tab: Blueprint's direct chat with this artist. */
export function ArtistChatTab({
  cfg,
  token,
  me,
  artist,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  artist: ArtistSummary;
}) {
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { tick } = useInbox(cfg, token, me);
  useEffect(() => {
    api<{ conversationId: string }>(cfg, token, 'POST', '/conversations', {
      kind: 'direct',
      artistId: artist.artistId,
    })
      .then((r) => setId(r.conversationId))
      .catch((e) => setError((e as Error).message));
  }, [cfg, token, artist.artistId]);
  return (
    <Card className="min-h-[520px]">
      {error && <Notice tone="error">{error}</Notice>}
      {id && (
        <Thread
          cfg={cfg}
          token={token}
          conversationId={id}
          title={`Chat with ${artist.displayName}`}
          refreshKey={tick}
        />
      )}
    </Card>
  );
}

/** Artist phone Chats: Blueprint, All artists, groups and other artists. */
export function ArtistChats({ cfg, token, me }: { cfg: AppConfig; token: string; me: Me }) {
  const { conversations, error, reload, tick } = useInbox(cfg, token, me);
  const [openId, setOpenId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<{ artistId: string; displayName: string }[]>([]);
  const [pick, setPick] = useState('');
  const open = conversations?.find((c) => c.conversationId === openId);

  useEffect(() => {
    api<{ artists: { artistId: string; displayName: string }[] }>(cfg, token, 'GET', '/directory')
      .then((r) => setDirectory(r.artists))
      .catch(() => setDirectory([]));
  }, [cfg, token]);

  async function start(artistId?: string) {
    const res = await api<{ conversationId: string }>(cfg, token, 'POST', '/conversations', {
      kind: 'direct',
      ...(artistId ? { artistId } : {}),
    });
    await reload();
    setOpenId(res.conversationId);
  }

  if (openId) {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          className="self-start text-sm font-bold underline"
          onClick={() => setOpenId(null)}
        >
          ← All chats
        </button>
        <section className="card">
          <Thread
            cfg={cfg}
            token={token}
            conversationId={openId}
            title={open?.title ?? 'Chat'}
            canWrite={open?.access !== 'read'}
            refreshKey={tick}
            onSent={() => void reload()}
            compact
          />
        </section>
      </div>
    );
  }

  const hasBmg = conversations?.some((c) => c.type === 'bmg-artist');
  return (
    <div className="flex flex-col gap-2">
      {error && <Notice tone="error">{error}</Notice>}
      <section className="card gap-1 p-2">
        {conversations === null && <p className="src p-2">Loading…</p>}
        {!hasBmg && conversations && (
          <button
            type="button"
            className="flex min-h-[60px] items-center gap-3 rounded-[10px] px-2.5 text-left hover:bg-secondary/60"
            onClick={() => void start()}
          >
            <Avatar name="Blueprint" />
            <span className="flex-1">
              <b className="block">Blueprint</b>
              <span className="src">Start a chat with the Blueprint team</span>
            </span>
          </button>
        )}
        {conversations?.map((c) => (
          <ConversationRow
            key={c.conversationId}
            c={c}
            active={false}
            onOpen={() => setOpenId(c.conversationId)}
          />
        ))}
      </section>
      {directory.length > 0 && (
        <section className="card gap-2">
          <span className="eyebrow">Message another artist</span>
          <div className="flex gap-2">
            <select
              className="dd flex-1"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              aria-label="Artist"
            >
              <option value="">Choose an artist…</option>
              {directory.map((a) => (
                <option key={a.artistId} value={a.artistId}>
                  {a.displayName}
                </option>
              ))}
            </select>
            <Button size="sm" variant="cta" disabled={!pick} onClick={() => void start(pick)}>
              Open
            </Button>
          </div>
          <span className="src">Chats between artists are private. Blueprint can’t read them.</span>
        </section>
      )}
    </div>
  );
}
