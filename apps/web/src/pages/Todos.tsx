import { useCallback, useEffect, useState } from 'react';
import { api, TODO_FILTERS, type ArtistSummary, type Todo } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  Avatar,
  Bar,
  Button,
  Card,
  Chips,
  DataTable,
  Notice,
  shortDate,
  Tag,
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

function DueTag({ t }: { t: Todo }) {
  if (!t.due) return <span className="src">No date</span>;
  return <Tag tone={!t.done && t.due < today() ? 'c' : 's'}>{shortDate(t.due)}</Tag>;
}

function TodoRows({
  todos,
  onToggle,
  artistName,
}: {
  todos: Todo[];
  onToggle: (t: Todo) => void;
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

  if (!isBmg) {
    return (
      <PhoneTodos
        todos={todos}
        error={error}
        onToggle={toggle}
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
      {!todos ? (
        <p className="src">Loading…</p>
      ) : todos.length === 0 ? (
        <p className="src">Nothing here.</p>
      ) : (
        <TodoRows todos={todos} onToggle={toggle} />
      )}
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
  add,
}: {
  todos: Todo[] | null;
  error: string | null;
  onToggle: (t: Todo) => void;
  add: React.ReactNode;
}) {
  if (!todos) return <p className="src">Loading…</p>;
  const fromBmg = todos.filter((t) => t.source !== 'artist');
  const own = todos.filter((t) => t.source === 'artist');
  const item = (t: Todo, coral: boolean) => (
    <label
      key={t.todoId}
      className={`flex min-h-[52px] items-center gap-3 rounded-[10px] border border-input bg-card px-3 py-2.5 shadow-xs ${coral ? 'border-l-[3px] border-l-accent' : ''}`}
    >
      <input className="chk" type="checkbox" checked={t.done} onChange={() => onToggle(t)} />
      <span className="min-w-0 flex-1">
        <b className={`block ${t.done ? 'text-muted-foreground line-through' : ''}`}>{t.title}</b>
        <span className="src">
          {t.source === 'feedback' ? 'From your feedback' : t.source === 'bmg' ? 'Blueprint' : ''}
          {t.notes ? `${t.source !== 'artist' ? ' · ' : ''}${t.notes}` : ''}
        </span>
      </span>
      {t.due && <DueTag t={t} />}
    </label>
  );
  return (
    <div className="flex flex-col gap-1.5">
      {error && <Notice tone="error">{error}</Notice>}
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
  const { filter, setFilter, todos, error, toggle } = useTodos(cfg, token, path);
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
            <TodoRows todos={todos} onToggle={toggle} artistName={(id) => names[id] ?? 'Artist'} />
          )}
        </div>
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
  const [bmgOnly, setBmgOnly] = useState(false);

  async function add() {
    try {
      await api(cfg, token, 'POST', `/artists/${artistId}/todos`, {
        title,
        ...(due ? { due } : {}),
        ...(isBmg && bmgOnly ? { bmgOnly } : {}),
      });
      setTitle('');
      setDue('');
      setBmgOnly(false);
      onAdded();
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
