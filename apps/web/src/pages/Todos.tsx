import { useCallback, useEffect, useState } from 'react';
import {
  api,
  REMINDER_OPTIONS,
  TODO_FILTERS,
  type ArtistSummary,
  type Reminder,
  type Todo,
} from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { EmojiPicker } from '../components/EmojiPicker.tsx';
import {
  Avatar,
  Bar,
  Button,
  Card,
  Chips,
  DataTable,
  Field,
  Icon,
  Notice,
  Select,
  shortDate,
  Tag,
  TextArea,
} from '../components/ui.tsx';

const SOURCE_LABEL: Record<Todo['source'], string> = {
  bmg: 'From Blueprint',
  feedback: 'From feedback',
  artist: "Artist's own",
};
const today = () => new Date().toISOString().slice(0, 10);
type Filter = (typeof TODO_FILTERS)[number]['id'];

function useTodos(cfg: AppConfig, token: string, path: (filter: string) => string) {
  const [filter, setFilter] = useState<Filter>('');
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setTodos((await api<{ todos: Todo[] }>(cfg, token, 'GET', path(filter))).todos);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, path, filter]);
  useEffect(() => void load(), [load]);
  async function toggle(t: Todo) {
    try {
      await api(cfg, token, 'PATCH', `/artists/${t.artistId}/todos/${t.todoId}`, {
        done: !t.done,
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return { filter, setFilter, todos, error, setError, load, toggle };
}

const REMINDER_SHORT: Record<Reminder, string> = {
  '60m': '60 min before',
  '1d': '1 day before',
  '3d': '3 days before',
  '7d': '7 days before',
};

function DueTag({ t }: { t: Todo }) {
  if (!t.due)
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="src">No date</span>
        <CommentCount t={t} />
      </span>
    );
  return (
    <span className="ml-auto inline-flex flex-wrap items-center justify-end gap-1.5 whitespace-nowrap">
      <Tag tone={!t.done && t.due < today() ? 'c' : 's'}>
        {shortDate(t.due)}
        {t.dueTime ? ` · ${t.dueTime}` : ''}
      </Tag>
      {t.reminder && !t.done && t.reminderFailed && (
        <span title="Open the to-do and save it to try again">
          <Tag tone="k">Reminder not set</Tag>
        </span>
      )}
      {t.reminder && !t.done && !t.reminderFailed && (
        <span title={`Reminder ${REMINDER_SHORT[t.reminder]}`} className="text-muted-foreground">
          <Icon name="bell" size={14} />
          <span className="sr-only">Reminder {REMINDER_SHORT[t.reminder]}</span>
        </span>
      )}
      <CommentCount t={t} />
    </span>
  );
}

/** "💬 3" when a to-do's thread has comments. */
function CommentCount({ t }: { t: Todo }) {
  if (!t.commentCount) return null;
  return (
    <span className="text-[13px] text-muted-foreground" title="Comments">
      💬 {t.commentCount}
      <span className="sr-only"> comments</span>
    </span>
  );
}

const REMINDER_FAILED =
  "The reminder couldn't be set just now. Open the to-do and save it to try again.";

/** Who is told when a to-do is edited (matches the API's rule). */
function notifyNote(t: Todo, isBmg: boolean): string | null {
  if (isBmg) return t.bmgOnly ? null : 'The artist is notified when you save.';
  return t.source === 'artist' ? null : 'Blueprint is notified when you save.';
}

/**
 * Edit a to-do: title, notes, due date and time, and a reminder before it's
 * due. Both Blueprint and the artist can edit; the person it's allocated to is
 * told what changed.
 */
function TodoEditor({
  cfg,
  token,
  todo,
  isBmg,
  onClose,
  onSaved,
}: {
  cfg: AppConfig;
  token: string;
  todo: Todo;
  isBmg: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes ?? '');
  const [due, setDue] = useState(todo.due ?? '');
  const [dueTime, setDueTime] = useState(todo.dueTime ?? '');
  const [reminder, setReminder] = useState<'' | Reminder>(todo.reminder ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const note = notifyNote(todo, isBmg);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api<Todo>(
        cfg,
        token,
        'PATCH',
        `/artists/${todo.artistId}/todos/${todo.todoId}`,
        {
          title: title.trim(),
          notes: notes.trim(),
          due: due || null,
          dueTime: due && dueTime ? dueTime : null,
          reminder: due && reminder ? reminder : null,
        },
      );
      const done = note ? `Saved. ${note.replace(' when you save', '')}` : 'Saved.';
      onSaved(saved.reminderFailed ? `${done} ${REMINDER_FAILED}` : done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="card gap-3 border-[#9AA4B0]"
      aria-label={`Edit "${todo.title}"`}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="card-hd">
        <h3 className="t text-[17px]">Edit to-do</h3>
        <span className="src ml-auto">{SOURCE_LABEL[todo.source]}</span>
      </div>
      <Field
        label="To-do"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <TextArea
        label="Notes"
        value={notes}
        maxLength={2000}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <Field
          label="Time"
          type="time"
          value={dueTime}
          disabled={!due}
          hint="Melbourne time · 9am if blank"
          onChange={(e) => setDueTime(e.target.value)}
        />
        <Select
          label="Reminder"
          value={reminder}
          disabled={!due}
          options={REMINDER_OPTIONS}
          onChange={(e) => setReminder(e.target.value as '' | Reminder)}
        />
      </div>
      {note && <span className="src">{note}</span>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button variant="cta" disabled={busy || !title.trim()} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <TodoThread cfg={cfg} token={token} todo={todo} isBmg={isBmg} />
    </section>
  );
}

interface ThreadComment {
  commentId: string;
  parentId: string | null;
  text: string;
  deleted: boolean;
  authorName: string;
  authorRole: 'artist' | 'bmg-admin' | 'bmg-staff';
  mine: boolean;
  createdAt: string;
}
type ThreadItem = ThreadComment & { replies: ThreadComment[] };

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * The to-do's conversation (rev 7): the artist and Blueprint talk it through
 * under the to-do. Replies are one level deep; people remove their own
 * comments. BMG-only to-dos keep their threads BMG-only.
 */
function TodoThread({
  cfg,
  token,
  todo,
  isBmg,
}: {
  cfg: AppConfig;
  token: string;
  todo: Todo;
  isBmg: boolean;
}) {
  const base = `/artists/${todo.artistId}/todos/${todo.todoId}/comments`;
  const [thread, setThread] = useState<ThreadItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ThreadComment | null>(null);
  const load = useCallback(async () => {
    try {
      setThread((await api<{ thread: ThreadItem[] }>(cfg, token, 'GET', base)).thread);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, base]);
  useEffect(() => void load(), [load]);

  async function remove(c: ThreadComment) {
    try {
      await api(cfg, token, 'DELETE', `${base}/${c.commentId}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const who = todo.bmgOnly ? 'Blueprint only' : isBmg ? 'You and the artist' : 'You and Blueprint';
  const Comment = ({ c, reply }: { c: ThreadComment; reply?: boolean }) => (
    <li className={`flex flex-col gap-0.5 ${reply ? 'ml-6 border-l-2 border-input pl-3' : ''}`}>
      <span className="text-[13px]">
        <b>{c.mine ? 'You' : c.authorName}</b>{' '}
        <span className="text-muted-foreground">{when(c.createdAt)}</span>
      </span>
      {c.deleted ? (
        <span className="src italic">Comment removed</span>
      ) : (
        <span className="whitespace-pre-line text-[15px]">{c.text}</span>
      )}
      {!c.deleted && (
        <span className="flex gap-3 text-[13px]">
          {!reply && (
            <button type="button" className="font-bold underline" onClick={() => setReplyTo(c)}>
              Reply
            </button>
          )}
          {c.mine && (
            <button type="button" className="underline" onClick={() => void remove(c)}>
              Remove
            </button>
          )}
        </span>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-2 border-t border-input pt-3">
      <div className="flex items-center gap-2">
        <h4 className="t text-[15px]">Conversation</h4>
        <span className="src ml-auto">{who}</span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {thread === null ? (
        <p className="src">Loading…</p>
      ) : thread.length === 0 ? (
        <p className="src">No comments yet. Ask a question or give an update.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {thread.map((c) => (
            <li key={c.commentId}>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                <Comment c={c} />
                {c.replies.map((r) => (
                  <Comment key={r.commentId} c={r} reply />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <CommentBox
        key={replyTo?.commentId ?? 'new'}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSend={async (text) => {
          await api(cfg, token, 'POST', base, {
            text,
            ...(replyTo ? { parentId: replyTo.commentId } : {}),
          });
          setReplyTo(null);
          await load();
        }}
      />
    </div>
  );
}

function CommentBox({
  replyTo,
  onCancelReply,
  onSend,
}: {
  replyTo: ThreadComment | null;
  onCancelReply: () => void;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      await onSend(text.trim());
      setText('');
      setEmoji(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      {replyTo && (
        <span className="src flex items-center gap-2">
          Replying to {replyTo.mine ? 'yourself' : replyTo.authorName}
          <button type="button" className="underline" onClick={onCancelReply}>
            Cancel
          </button>
        </span>
      )}
      <textarea
        aria-label={replyTo ? 'Write a reply' : 'Write a comment'}
        className="min-h-20 w-full rounded-lg border border-input bg-white px-3 py-2 text-[15px]"
        maxLength={2000}
        placeholder={replyTo ? 'Write a reply…' : 'Write a comment…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void send();
        }}
      />
      {emoji && <EmojiPicker onPick={(e) => setText((t) => t + e)} />}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="navy"
          disabled={busy || !text.trim()}
          onClick={() => void send()}
        >
          {replyTo ? 'Reply' : 'Comment'}
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={emoji} onClick={() => setEmoji((v) => !v)}>
          😊 Emoji
        </Button>
      </div>
    </div>
  );
}

/** The open editor (one at a time) and the last "saved" message. */
function useEditing(load: () => Promise<void>) {
  const [editing, setEditing] = useState<Todo | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  return {
    editing,
    saved,
    open: (t: Todo) => {
      setSaved(null);
      setEditing(t);
    },
    close: () => setEditing(null),
    done: (msg: string) => {
      setEditing(null);
      setSaved(msg);
      void load();
    },
  };
}

function TodoRows({
  todos,
  onToggle,
  onEdit,
  artistName,
}: {
  todos: Todo[];
  onToggle: (t: Todo) => void;
  onEdit: (t: Todo) => void;
  artistName?: (id: string) => string;
}) {
  return (
    <DataTable>
      <thead>
        <tr>
          <th scope="col" className="w-7">
            <span className="sr-only">Done</span>
          </th>
          <th scope="col">To-do</th>
          {artistName && <th scope="col">Artist</th>}
          <th scope="col">From</th>
          <th scope="col">Due</th>
          <th scope="col">
            <span className="sr-only">Edit</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {todos.map((t) => (
          <tr key={t.todoId}>
            <td>
              <input
                className="chk"
                type="checkbox"
                checked={t.done}
                onChange={() => onToggle(t)}
                aria-label={`Mark "${t.title}" done`}
              />
            </td>
            <td>
              <b className={`block ${t.done ? 'text-muted-foreground line-through' : ''}`}>
                {t.title}
              </b>
              {(t.notes || t.bmgOnly) && (
                <span className="src">
                  {t.bmgOnly ? 'BMG only' : ''}
                  {t.bmgOnly && t.notes ? ' · ' : ''}
                  {t.notes}
                </span>
              )}
            </td>
            {artistName && (
              <td>
                <span className="flex items-center gap-2">
                  <Avatar name={artistName(t.artistId)} size={28} />
                  {artistName(t.artistId)}
                </span>
              </td>
            )}
            <td>
              <Tag tone={t.source === 'artist' ? 's' : 'c'}>{SOURCE_LABEL[t.source]}</Tag>
            </td>
            <td>
              <DueTag t={t} />
            </td>
            <td className="text-right">
              <Button size="sm" variant="ghost" onClick={() => onEdit(t)}>
                <Icon name="pencil" size={14} />
                Edit
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

/** Artist workspace To-do tab (BMG view): progress, quick filters, table and add row. */
export function ArtistTodos({
  cfg,
  token,
  artistId,
  isBmg,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isBmg: boolean;
}) {
  const path = useCallback(
    (f: string) => `/artists/${artistId}/todos${f ? `?filter=${f}` : ''}`,
    [artistId],
  );
  const { filter, setFilter, todos, error, setError, load, toggle } = useTodos(cfg, token, path);
  const all = useAllCounts(cfg, token, artistId, todos);
  const ed = useEditing(load);
  const editor = ed.editing && (
    <TodoEditor
      key={ed.editing.todoId}
      cfg={cfg}
      token={token}
      todo={ed.editing}
      isBmg={isBmg}
      onClose={ed.close}
      onSaved={ed.done}
    />
  );

  if (!isBmg) {
    return (
      <PhoneTodos
        todos={todos}
        error={error}
        onToggle={toggle}
        onEdit={ed.open}
        editing={ed.editing?.todoId ?? null}
        editor={editor}
        saved={ed.saved}
        add={
          <AddTodo
            cfg={cfg}
            token={token}
            artistId={artistId}
            isBmg={false}
            onAdded={load}
            onError={setError}
          />
        }
      />
    );
  }

  return (
    <Card
      title="To-do"
      action={
        all && (
          <span className="src">
            {all.done} of {all.total} done
          </span>
        )
      }
    >
      {all && <Bar pct={all.total ? (all.done / all.total) * 100 : 0} />}
      <Chips label="Quick filters" value={filter} onChange={setFilter} options={TODO_FILTERS} />
      {error && <Notice tone="error">{error}</Notice>}
      {ed.saved && <Notice tone="success">{ed.saved}</Notice>}
      {!todos ? (
        <p className="src">Loading…</p>
      ) : todos.length === 0 ? (
        <p className="src">Nothing here.</p>
      ) : (
        <TodoRows todos={todos} onToggle={toggle} onEdit={ed.open} />
      )}
      {editor}
      <AddTodo
        cfg={cfg}
        token={token}
        artistId={artistId}
        isBmg
        onAdded={load}
        onError={setError}
      />
    </Card>
  );
}

/** Done / total across every to-do for the progress bar (the list itself may be filtered). */
function useAllCounts(cfg: AppConfig, token: string, artistId: string, trigger: unknown) {
  const [counts, setCounts] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    Promise.all([
      api<{ todos: Todo[] }>(cfg, token, 'GET', `/artists/${artistId}/todos`),
      api<{ todos: Todo[] }>(cfg, token, 'GET', `/artists/${artistId}/todos?filter=done`),
    ])
      .then(([open, done]) =>
        setCounts({ done: done.todos.length, total: open.todos.length + done.todos.length }),
      )
      .catch(() => setCounts(null));
  }, [cfg, token, artistId, trigger]);
  return counts;
}

/** The artist's phone To-do: Blueprint's and feedback to-dos first, then their own. */
function PhoneTodos({
  todos,
  error,
  onToggle,
  onEdit,
  editing,
  editor,
  saved,
  add,
}: {
  todos: Todo[] | null;
  error: string | null;
  onToggle: (t: Todo) => void;
  onEdit: (t: Todo) => void;
  editing: string | null;
  editor: React.ReactNode;
  saved: string | null;
  add: React.ReactNode;
}) {
  if (!todos) return <p className="src">Loading…</p>;
  const fromBmg = todos.filter((t) => t.source !== 'artist');
  const own = todos.filter((t) => t.source === 'artist');
  const item = (t: Todo, coral: boolean) =>
    editing === t.todoId ? (
      <div key={t.todoId}>{editor}</div>
    ) : (
      <div
        key={t.todoId}
        className={`flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[10px] border border-input bg-card px-3 py-2.5 shadow-xs ${coral ? 'border-l-[3px] border-l-accent' : ''}`}
      >
        <input
          className="chk"
          type="checkbox"
          checked={t.done}
          aria-label={`Mark "${t.title}" done`}
          onChange={() => onToggle(t)}
        />
        <button
          type="button"
          className="min-w-[min(11rem,100%)] flex-1 text-left"
          onClick={() => onEdit(t)}
        >
          <b className={`block ${t.done ? 'text-muted-foreground line-through' : ''}`}>{t.title}</b>
          <span className="src">
            {t.source === 'feedback' ? 'From your feedback' : t.source === 'bmg' ? 'Blueprint' : ''}
            {t.notes ? `${t.source !== 'artist' ? ' · ' : ''}${t.notes}` : ''}
          </span>
        </button>
        {t.due && <DueTag t={t} />}
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5">
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice tone="success">{saved}</Notice>}
      <div className="eyebrow py-1.5 text-muted-foreground">From Blueprint</div>
      {fromBmg.length ? (
        fromBmg.map((t) => item(t, true))
      ) : (
        <p className="src">Nothing from Blueprint right now.</p>
      )}
      <div className="eyebrow pt-2.5 pb-1.5 text-muted-foreground">My own</div>
      {own.map((t) => item(t, false))}
      <div className="mt-1.5">{add}</div>
    </div>
  );
}

/** BMG's "All artist to-dos": expandable, with quick filters and a per-artist filter. */
export function AllTodos({
  cfg,
  token,
  artists,
}: {
  cfg: AppConfig;
  token: string;
  artists: ArtistSummary[];
}) {
  const [artistId, setArtistId] = useState('');
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));
  const path = useCallback(
    (f: string) =>
      `/todos?${new URLSearchParams({ ...(f ? { filter: f } : {}), ...(artistId ? { artistId } : {}) })}`,
    [artistId],
  );
  const { filter, setFilter, todos, error, load, toggle } = useTodos(cfg, token, path);
  const ed = useEditing(load);
  const overdue = (todos ?? []).filter((t) => !t.done && t.due && t.due < today()).length;

  return (
    <Card>
      <details open className="flex flex-col gap-3.5">
        <summary className="card-hd cursor-pointer list-none">
          <h2 className="t text-[19px]">All artist to-dos</h2>
          {overdue > 0 && <Tag tone="k">{overdue} overdue</Tag>}
          <span className="src ml-auto">Show / hide</span>
        </summary>
        <div className="mt-3.5 flex flex-wrap items-center gap-3">
          <Chips label="Quick filters" value={filter} onChange={setFilter} options={TODO_FILTERS} />
          <label className="ml-auto">
            <span className="sr-only">Artist</span>
            <select className="dd" value={artistId} onChange={(e) => setArtistId(e.target.value)}>
              <option value="">All artists</option>
              {artists.map((a) => (
                <option key={a.artistId} value={a.artistId}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="mt-3.5">
          {!todos ? (
            <p className="src">Loading…</p>
          ) : todos.length === 0 ? (
            <p className="src">Nothing here.</p>
          ) : (
            <TodoRows
              todos={todos}
              onToggle={toggle}
              onEdit={ed.open}
              artistName={(id) => names[id] ?? 'Artist'}
            />
          )}
        </div>
        {ed.saved && <Notice tone="success">{ed.saved}</Notice>}
        {ed.editing && (
          <div className="mt-3.5">
            <TodoEditor
              key={ed.editing.todoId}
              cfg={cfg}
              token={token}
              todo={ed.editing}
              isBmg
              onClose={ed.close}
              onSaved={ed.done}
            />
          </div>
        )}
      </details>
    </Card>
  );
}

function AddTodo({
  cfg,
  token,
  artistId,
  isBmg,
  onAdded,
  onError,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isBmg: boolean;
  onAdded: () => void;
  onError: (msg: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [reminder, setReminder] = useState<'' | Reminder>('');
  const [bmgOnly, setBmgOnly] = useState(false);

  async function add() {
    try {
      const created = await api<Todo>(cfg, token, 'POST', `/artists/${artistId}/todos`, {
        title,
        ...(due ? { due } : {}),
        ...(due && dueTime ? { dueTime } : {}),
        ...(due && reminder ? { reminder } : {}),
        ...(isBmg && bmgOnly ? { bmgOnly } : {}),
      });
      setTitle('');
      setDue('');
      setDueTime('');
      setReminder('');
      setBmgOnly(false);
      onAdded();
      if (created.reminderFailed) onError(`To-do added. ${REMINDER_FAILED}`);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <form
      className="flex min-h-[50px] flex-wrap items-center gap-2 rounded-[10px] border border-input bg-card py-1 pr-1.5 pl-3 shadow-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) void add();
      }}
    >
      <label className="min-w-40 flex-1">
        <span className="sr-only">New to-do</span>
        <input
          className="w-full border-0 bg-transparent text-base outline-none"
          placeholder="Add something to do…"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        <span className="sr-only">Due</span>
        <input
          type="date"
          className="h-9 rounded-lg border border-input bg-white px-2 text-sm"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
      </label>
      {due && (
        <>
          <label>
            <span className="sr-only">Due time (Melbourne)</span>
            <input
              type="time"
              title="Due time (Melbourne). 9am if blank"
              className="h-9 rounded-lg border border-input bg-white px-2 text-sm"
              value={dueTime}
              onChange={(e) => setDueTime(e.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">Reminder</span>
            <select
              className="h-9 rounded-lg border border-input bg-white px-2 text-sm"
              value={reminder}
              onChange={(e) => setReminder(e.target.value as '' | Reminder)}
            >
              {REMINDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {isBmg && (
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            className="switch"
            type="checkbox"
            checked={bmgOnly}
            onChange={(e) => setBmgOnly(e.target.checked)}
          />
          BMG only
        </label>
      )}
      <Button type="submit" variant="cta" size="sm" disabled={!title.trim()}>
        Add
      </Button>
    </form>
  );
}
