import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { Button, Icon, Notice, Tag } from './ui.tsx';

/**
 * Blueprint Assistant (screens doc "AI assistant, opened from any screen"):
 * slides in from the right on desktop, a bottom sheet on phone. It reads only
 * what the person can see, and asks before it sends, shares or changes
 * anything: proposed actions come back as a checklist, and only "Do it"
 * carries them out, through the normal API.
 */

interface Action {
  type: string;
  summary: string;
  [k: string]: unknown;
}
interface Turn {
  from: 'me' | 'ai';
  text: string;
  actions?: Action[];
  /** What each action would change (moves and access: who gains, who loses). */
  effects?: (string | null)[];
  actionToken?: string;
  done?: { summary: string; ok: boolean; error?: string }[];
}

const STORE = 'bmg.assistant.session';

export function Assistant({
  cfg,
  token,
  open,
  onClose,
  userName,
  roleLabel,
  lookingAt,
  suggestions,
}: {
  cfg: AppConfig;
  token: string;
  open: boolean;
  onClose: () => void;
  userName: string;
  roleLabel: string;
  lookingAt: string;
  suggestions: string[];
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(() => {
    try {
      return sessionStorage.getItem(STORE) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Reopen this browser tab's conversation (history is kept for 30 days).
  useEffect(() => {
    if (!open || !sessionId || turns.length) return;
    api<{ messages: { from: 'me' | 'ai'; text: string }[] }>(
      cfg,
      token,
      'GET',
      `/ai/chat/history?sessionId=${sessionId}`,
    )
      .then((r) => setTurns(r.messages))
      .catch(() => undefined);
  }, [open, sessionId, turns.length, cfg, token]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns, busy]);

  async function ask(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    setText('');
    setError(null);
    setTurns((t) => [...t, { from: 'me', text: m }]);
    setBusy(true);
    try {
      const r = await api<{
        sessionId: string;
        reply: string;
        actions: Action[];
        effects?: (string | null)[];
        actionToken?: string;
      }>(cfg, token, 'POST', '/ai/chat', { message: m, ...(sessionId ? { sessionId } : {}) });
      setSessionId(r.sessionId);
      try {
        sessionStorage.setItem(STORE, r.sessionId);
      } catch {
        /* private mode */
      }
      setTurns((t) => [
        ...t,
        {
          from: 'ai',
          text: r.reply,
          ...(r.actions.length
            ? {
                actions: r.actions,
                actionToken: r.actionToken,
                ...(r.effects ? { effects: r.effects } : {}),
              }
            : {}),
        },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function newConversation() {
    setTurns([]);
    setSessionId(undefined);
    try {
      sessionStorage.removeItem(STORE);
    } catch {
      /* private mode */
    }
  }

  async function doIt(i: number, selected: number[]) {
    const turn = turns[i];
    if (!turn?.actions || !turn.actionToken) return;
    try {
      const r = await api<{ results: NonNullable<Turn['done']> }>(
        cfg,
        token,
        'POST',
        '/ai/actions/confirm',
        { actions: turn.actions, actionToken: turn.actionToken, selected },
      );
      setTurns((t) => t.map((x, j) => (j === i ? { ...x, done: r.results } : x)));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const cancel = (i: number) =>
    setTurns((t) =>
      t.map((x, j) => (j === i ? { ...x, done: [], actions: [], actionToken: undefined } : x)),
    );

  if (!open) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };

  return (
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgba(1,25,53,.38)]"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Blueprint Assistant"
        className="absolute right-0 bottom-0 flex w-[min(460px,100%)] flex-col border-l border-input bg-card shadow-[-16px_0_40px_rgba(1,25,53,.22)] max-sm:h-[88vh] max-sm:rounded-t-2xl max-sm:border-l-0 sm:top-0"
      >
        <header className="bp flex flex-col gap-2.5 px-5 py-[18px] text-[#F1F4F7] max-sm:rounded-t-2xl">
          <div className="flex items-center gap-2.5">
            <Icon name="sparkle" />
            <b className="t flex-1 text-[22px] text-white">Blueprint Assistant</b>
            {turns.length > 0 && (
              <button
                type="button"
                className="text-sm font-bold underline"
                onClick={newConversation}
              >
                New chat
              </button>
            )}
            <button
              type="button"
              aria-label="Close assistant"
              className="flex size-10 items-center justify-center"
              onClick={onClose}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 text-sm">
            <span className="tag block max-w-full truncate !bg-white/15 !text-[#F1F4F7]">
              Looking at: {lookingAt}
            </span>
            <span className="tag block max-w-full truncate !bg-white/15 !text-[#F1F4F7]">
              Signed in as {userName} · {roleLabel}
            </span>
          </div>
        </header>

        <div
          className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-[18px]"
          aria-live="polite"
        >
          {turns.length === 0 && !busy && (
            <p className="src m-0">
              Ask about plans, to-dos, gigs and submissions you can see, or tell me what to do. I'll
              show a checklist before anything changes.
            </p>
          )}
          {turns.map((t, i) =>
            t.from === 'me' ? (
              <div key={i} className="bubble b-out max-w-[88%]">
                {t.text}
              </div>
            ) : (
              <div key={i} className="flex max-w-[94%] flex-col gap-2">
                <div className="leading-normal whitespace-pre-wrap">{t.text}</div>
                {t.actions && t.actions.length > 0 && !t.done && (
                  <Checklist
                    actions={t.actions}
                    effects={t.effects}
                    onDo={(sel) => void doIt(i, sel)}
                    onCancel={() => cancel(i)}
                  />
                )}
                {t.done && t.done.length > 0 && (
                  <div className="flex flex-col gap-1 rounded-lg bg-secondary p-3 text-sm">
                    {t.done.map((d, k) => (
                      <span key={k} className="flex items-center gap-2">
                        <Tag tone={d.ok ? 'n' : 'c'}>{d.ok ? 'Done' : 'Not done'}</Tag>
                        <span>
                          {d.summary}
                          {d.error ? `: ${d.error}` : ''}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
          {busy && <p className="src m-0">Thinking…</p>}
          {error && <Notice tone="error">{error}</Notice>}
          {turns.length === 0 && (
            <div className="mt-auto flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <Button key={s} size="sm" variant="ghost" onClick={() => void ask(s)}>
                  {s}
                </Button>
              ))}
            </div>
          )}
          <div ref={end} />
        </div>

        <form
          className="flex flex-col gap-2 border-t border-input px-5 pt-3 pb-[18px]"
          onSubmit={submit}
        >
          <label className="flex min-h-[52px] items-center gap-2 rounded-lg border border-input py-1 pr-1.5 pl-3.5">
            <span className="sr-only">Ask or tell the assistant</span>
            <input
              ref={input}
              className="min-w-0 flex-1 border-0 bg-transparent text-base outline-0"
              placeholder="Ask about your content, or tell me what to do…"
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
            />
            <Button size="sm" variant="cta" type="submit" disabled={busy || !text.trim()}>
              Send
            </Button>
          </label>
          <span className="src">
            Reads only what you can see. Asks before it sends, shares or changes anything.
          </span>
        </form>
      </aside>
    </div>
  );
}

function Checklist({
  actions,
  effects,
  onDo,
  onCancel,
}: {
  actions: Action[];
  effects?: (string | null)[] | undefined;
  onDo: (selected: number[]) => void;
  onCancel: () => void;
}) {
  const [ticked, setTicked] = useState(() => actions.map(() => true));
  const [sending, setSending] = useState(false);
  const selected = ticked.flatMap((t, i) => (t ? [i] : []));
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border-2 border-[#D9534F] p-3.5">
      <span className="eyebrow">Ready to do · needs your OK</span>
      {actions.map((a, i) => (
        <label key={i} className="flex min-h-9 items-center gap-3">
          <input
            className="chk"
            type="checkbox"
            checked={ticked[i]}
            onChange={() => setTicked(ticked.map((t, j) => (j === i ? !t : t)))}
          />
          <span className="flex-1">
            {a.summary}
            {/* P6: a move or an access change says who gains and who loses access. */}
            {effects?.[i] && <span className="src block">{effects[i]}</span>}
          </span>
        </label>
      ))}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="cta"
          disabled={sending || selected.length === 0}
          onClick={() => {
            setSending(true);
            onDo(selected);
          }}
        >
          Do it
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <span className="src">This checklist expires after a minute. Ask again if it does.</span>
    </div>
  );
}
