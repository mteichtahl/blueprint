import { useCallback, useEffect, useState } from 'react';
import { api, TODO_FILTERS, type ArtistSummary, type Todo } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { Button, Card, Field, Notice } from '../components/ui.tsx';

const SOURCE_LABEL: Record<Todo['source'], string> = {
  bmg: 'Blueprint',
  feedback: 'Feedback',
  artist: 'Own',
};

/** One artist's to-dos (artist workspace To-do tab, and the artist's own To-do screen). */
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
  const [filter, setFilter] = useState('');
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = filter ? `?filter=${filter}` : '';
      setTodos(
        (await api<{ todos: Todo[] }>(cfg, token, 'GET', `/artists/${artistId}/todos${q}`)).todos,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, artistId, filter]);
  useEffect(() => void load(), [load]);

  async function toggle(t: Todo) {
    await api(cfg, token, 'PATCH', `/artists/${artistId}/todos/${t.todoId}`, { done: !t.done });
    await load();
  }

  return (
    <div className="space-y-4">
      <AddTodo cfg={cfg} token={token} artistId={artistId} isBmg={isBmg} onAdded={load} />
      <FilterBar value={filter} onChange={setFilter} />
      {error && <Notice tone="error">{error}</Notice>}
      <TodoTable todos={todos} onToggle={toggle} />
    </div>
  );
}

/** BMG's "All artist to-dos", with quick filters and a per-artist filter. */
export function AllTodos({
  cfg,
  token,
  artists,
}: {
  cfg: AppConfig;
  token: string;
  artists: ArtistSummary[];
}) {
  const [filter, setFilter] = useState('');
  const [artistId, setArtistId] = useState('');
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({
        ...(filter ? { filter } : {}),
        ...(artistId ? { artistId } : {}),
      });
      setTodos((await api<{ todos: Todo[] }>(cfg, token, 'GET', `/todos?${q}`)).todos);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, filter, artistId]);
  useEffect(() => void load(), [load]);

  async function toggle(t: Todo) {
    await api(cfg, token, 'PATCH', `/artists/${t.artistId}/todos/${t.todoId}`, { done: !t.done });
    await load();
  }

  return (
    <Card title="All artist to-dos">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterBar value={filter} onChange={setFilter} />
        <select
          className="h-9 rounded-md border border-input bg-white px-2 text-sm shadow-xs"
          value={artistId}
          onChange={(e) => setArtistId(e.target.value)}
          aria-label="Artist"
        >
          <option value="">All artists</option>
          {artists.map((a) => (
            <option key={a.artistId} value={a.artistId}>
              {a.displayName}
            </option>
          ))}
        </select>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <TodoTable todos={todos} onToggle={toggle} artistName={(id) => names[id] ?? id} />
    </Card>
  );
}

function FilterBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick filters">
      {TODO_FILTERS.map((f) => (
        <button
          key={f.id}
          onClick={() => onChange(f.id)}
          aria-pressed={value === f.id}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${value === f.id ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

function TodoTable({
  todos,
  onToggle,
  artistName,
}: {
  todos: Todo[] | null;
  onToggle: (t: Todo) => void;
  artistName?: (id: string) => string;
}) {
  if (!todos) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (todos.length === 0) return <p className="text-sm text-muted-foreground">Nothing here.</p>;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-white">
      {todos.map((t) => (
        <li key={t.todoId} className="flex items-start gap-3 px-4 py-3">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={t.done}
            onChange={() => onToggle(t)}
            aria-label={`Mark "${t.title}" done`}
          />
          <div className="min-w-0 flex-1">
            <p
              className={`text-sm font-semibold ${t.done ? 'text-muted-foreground line-through' : ''}`}
            >
              {t.title}
            </p>
            <p className="text-xs text-muted-foreground">
              {artistName && <>{artistName(t.artistId)} · </>}
              {SOURCE_LABEL[t.source]}
              {t.bmgOnly && ' · BMG-only'}
              {t.due && (
                <span className={!t.done && t.due < today ? 'font-semibold text-destructive' : ''}>
                  {' '}
                  · due {t.due}
                </span>
              )}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AddTodo({
  cfg,
  token,
  artistId,
  isBmg,
  onAdded,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isBmg: boolean;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [bmgOnly, setBmgOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
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
      setError((e as Error).message);
    }
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="min-w-56 flex-1">
        <Field
          label="New to-do"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
        />
      </div>
      <div className="w-40">
        <Field label="Due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      {isBmg && (
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={bmgOnly} onChange={(e) => setBmgOnly(e.target.checked)} />{' '}
          BMG-only
        </label>
      )}
      <Button type="submit">Add</Button>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}
