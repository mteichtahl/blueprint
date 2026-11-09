import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { Bar, Button, Card, DataTable, Field, Notice, PageHeader, Tag } from '../components/ui.tsx';

/** BMG-only events (screen: Events · Industry Mixer Night). */

interface EventInfo {
  eventId: string;
  name: string;
  date: string;
  venue: string;
  capacity: number;
  ticketTarget: number;
  ticketPriceCents: number;
  ticketsSold: number;
  compsTarget: number;
  surveyAfter: boolean;
  humanitixEventId?: string;
}
type Row = { itemId: string } & Record<string, unknown>;
interface Detail {
  event: EventInfo;
  guests: Row[];
  speakers: Row[];
  crew: Row[];
  run: Row[];
  budget: Row[];
  summary: {
    ticketsSold: number;
    ticketTarget: number;
    compsAccepted: number;
    compsTarget: number;
    inRoom: number;
    capacity: number;
    budgetCents: number;
    spentCents: number;
    ticketIncomeCents: number;
  };
}
type Part = 'guests' | 'speakers' | 'crew' | 'run' | 'budget';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-AU', { maximumFractionDigits: cents % 100 ? 2 : 0 })}`;
const pct = (n: number, d: number) => (d > 0 ? Math.min(100, (n / d) * 100) : 0);
const daysTo = (date: string) =>
  Math.ceil((new Date(`${date}T00:00:00`).getTime() - Date.now()) / 86_400_000);
const longDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
const time12 = (t: string) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

const GUEST_TAG = {
  accepted: ['n', 'Accepted'],
  invited: ['c', 'Invited'],
  declined: ['s', 'Declined'],
} as const;
const SPEAKER_TAG = {
  confirmed: ['n', 'Confirmed'],
  waiting: ['c', 'Waiting'],
  declined: ['s', 'Declined'],
} as const;

export function Events({ cfg, token }: { cfg: AppConfig; token: string }) {
  const [events, setEvents] = useState<EventInfo[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const list = (await api<{ events: EventInfo[] }>(cfg, token, 'GET', '/events')).events;
      setEvents(list);
      const today = new Date().toISOString().slice(0, 10);
      setOpenId((id) => id ?? (list.find((e) => e.date >= today) ?? list.at(-1))?.eventId ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  useEffect(() => void loadList(), [loadList]);

  const actions = (
    <>
      <Button variant="default" onClick={() => setListing((v) => !v)}>
        All events
      </Button>
      <Button variant="cta" onClick={() => setCreating(true)}>
        New event
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-5">
      {error && <Notice tone="error">{error}</Notice>}
      {creating && (
        <NewEvent
          cfg={cfg}
          token={token}
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
            void loadList();
          }}
        />
      )}
      {listing && events && (
        <Card title="All events">
          {events.length === 0 ? (
            <p className="src">No events yet.</p>
          ) : (
            <div className="flex flex-col">
              {events.map((e) => (
                <button
                  key={e.eventId}
                  type="button"
                  className="li text-left"
                  onClick={() => {
                    setOpenId(e.eventId);
                    setListing(false);
                  }}
                >
                  <b className="flex-1">{e.name}</b>
                  <span className="src">{longDate(e.date)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}
      {events === null && <p className="src">Loading…</p>}
      {events?.length === 0 && !creating && (
        <>
          <PageHeader eyebrow="BMG only · Events" title="Events" actions={actions} />
          <Notice>No events yet. Start with the Industry Mixer Night.</Notice>
        </>
      )}
      {openId && (
        <EventDetail
          key={openId}
          cfg={cfg}
          token={token}
          eventId={openId}
          actions={actions}
          onChanged={loadList}
        />
      )}
    </div>
  );
}

function NewEvent({
  cfg,
  token,
  onCancel,
  onCreated,
}: {
  cfg: AppConfig;
  token: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [f, setF] = useState({
    name: '',
    date: '',
    venue: '',
    capacity: '',
    ticketTarget: '',
    ticketPrice: '',
    compsTarget: '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  async function create() {
    try {
      const e = await api<EventInfo>(cfg, token, 'POST', '/events', {
        name: f.name,
        date: f.date,
        venue: f.venue,
        capacity: Number(f.capacity) || 0,
        ticketTarget: Number(f.ticketTarget) || 0,
        ticketPriceCents: Math.round((Number(f.ticketPrice) || 0) * 100),
        compsTarget: Number(f.compsTarget) || 0,
      });
      onCreated(e.eventId);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Card title="New event">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Name"
          value={f.name}
          onChange={set('name')}
          placeholder="Industry Mixer Night"
        />
        <Field label="Date" type="date" value={f.date} onChange={set('date')} />
        <Field label="Venue" value={f.venue} onChange={set('venue')} />
        <Field
          label="Capacity"
          type="number"
          min={0}
          value={f.capacity}
          onChange={set('capacity')}
        />
        <Field
          label="Ticket target"
          type="number"
          min={0}
          value={f.ticketTarget}
          onChange={set('ticketTarget')}
        />
        <Field
          label="Ticket price ($)"
          type="number"
          min={0}
          step="0.01"
          value={f.ticketPrice}
          onChange={set('ticketPrice')}
        />
        <Field
          label="Industry comps"
          type="number"
          min={0}
          value={f.compsTarget}
          onChange={set('compsTarget')}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="cta" disabled={!f.name.trim() || !f.date} onClick={() => void create()}>
          Create event
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function EventDetail({
  cfg,
  token,
  eventId,
  actions,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  eventId: string;
  actions: ReactNode;
  onChanged: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Part | null>(null);
  const [editingSales, setEditingSales] = useState(false);
  const base = `/events/${eventId}`;

  const load = useCallback(async () => {
    try {
      setD(await api<Detail>(cfg, token, 'GET', base));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, base]);
  useEffect(() => void load(), [load]);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const patchEvent = (body: Partial<EventInfo>) =>
    run(async () => {
      await api(cfg, token, 'PATCH', base, body);
      onChanged();
    });
  const patchRow = (part: Part, id: string, body: Record<string, unknown>) =>
    run(() => api(cfg, token, 'PATCH', `${base}/${part}/${id}`, body));
  const removeRow = (part: Part, id: string) =>
    run(() => api(cfg, token, 'DELETE', `${base}/${part}/${id}`));
  const addRow = (part: Part, body: Record<string, unknown>) =>
    run(async () => {
      await api(cfg, token, 'POST', `${base}/${part}`, body);
      setAdding(null);
    });

  if (!d) return error ? <Notice tone="error">{error}</Notice> : <p className="src">Loading…</p>;
  const { event: e, summary: s } = d;
  const days = daysTo(e.date);

  return (
    <>
      <PageHeader
        eyebrow="BMG only · Events"
        title={e.name}
        sub={[
          longDate(e.date),
          e.venue,
          days > 0 ? `${days} day${days === 1 ? '' : 's'} to go` : days === 0 ? 'Today' : 'Done',
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={actions}
      />
      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex flex-wrap gap-5">
        <Card className="flex-[1_1_200px]">
          <span className="eyebrow">Tickets sold</span>
          <span className="t text-[36px]">
            {s.ticketsSold}{' '}
            <span className="text-lg text-muted-foreground">/ {s.ticketTarget} target</span>
          </span>
          <Bar pct={pct(s.ticketsSold, s.ticketTarget)} color="#D9534F" />
          {editingSales ? (
            <TicketsForm
              sold={e.ticketsSold}
              onSave={(n) => {
                setEditingSales(false);
                void patchEvent({ ticketsSold: n });
              }}
            />
          ) : (
            <span className="src">
              {e.humanitixEventId ? 'Humanitix' : 'Typed in until Humanitix is connected'}
              {e.ticketPriceCents ? ` · ${money(e.ticketPriceCents)}` : ''} ·{' '}
              {!e.humanitixEventId && (
                <button
                  type="button"
                  className="font-bold underline"
                  onClick={() => setEditingSales(true)}
                >
                  Update
                </button>
              )}
            </span>
          )}
        </Card>
        <Card className="flex-[1_1_200px]">
          <span className="eyebrow">Industry comps</span>
          <span className="t text-[36px]">
            {s.compsAccepted}{' '}
            <span className="text-lg text-muted-foreground">/ {s.compsTarget}</span>
          </span>
          <Bar pct={pct(s.compsAccepted, s.compsTarget)} />
          <span className="src">Separate guest list, not ticketed</span>
        </Card>
        <Card className="flex-[1_1_200px]">
          <span className="eyebrow">In the room</span>
          <span className="t text-[36px]">
            {s.inRoom}{' '}
            <span className="text-lg text-muted-foreground">/ {s.capacity} capacity</span>
          </span>
          <Bar pct={pct(s.inRoom, s.capacity)} color="#5C6775" />
          <span className="src">Tickets + comps</span>
        </Card>
        <Card className="flex-[1_1_200px]">
          <span className="eyebrow">Budget</span>
          <span className="t text-[36px]">{money(s.budgetCents)}</span>
          <span className="src">Ticket income so far {money(s.ticketIncomeCents)}</span>
        </Card>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Card
          className="flex-[3_1_480px]"
          title={
            <span className="flex flex-wrap items-baseline gap-3">
              <h2 className="t text-[19px]">Guest list</h2>
              <span className="src">Industry guests you invite for free</span>
            </span>
          }
          action={
            <Button size="sm" variant="cta" onClick={() => setAdding('guests')}>
              Invite guest
            </Button>
          }
        >
          {adding === 'guests' && (
            <RowForm
              fields={[
                { k: 'name', label: 'Guest' },
                { k: 'type', label: 'Type', placeholder: 'Booker' },
                { k: 'email', label: 'Email', type: 'email', optional: true },
              ]}
              checkbox={{ k: 'fromOutreach', label: 'From the outreach list' }}
              onCancel={() => setAdding(null)}
              onSave={(b) => void addRow('guests', b)}
            />
          )}
          {d.guests.length === 0 ? (
            <p className="src">No guests yet.</p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <th scope="col">Guest</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">From outreach list</th>
                  <th scope="col">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.guests.map((g) => {
                  const status = g.status as keyof typeof GUEST_TAG;
                  return (
                    <tr key={g.itemId}>
                      <td>{String(g.name)}</td>
                      <td>{String(g.type || '—')}</td>
                      <td>
                        <StatusSelect
                          label={`Status for ${String(g.name)}`}
                          value={status}
                          tags={GUEST_TAG}
                          onChange={(v) => void patchRow('guests', g.itemId, { status: v })}
                        />
                      </td>
                      <td>{g.fromOutreach ? 'Yes' : 'No'}</td>
                      <td>
                        <RemoveButton onClick={() => void removeRow('guests', g.itemId)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
          <span className="src">
            {s.compsAccepted} accepted of {s.compsTarget} places
          </span>
        </Card>

        <Card className="flex-[2_1_320px]">
          <div className="card-hd">
            <h2 className="t text-[19px]">Speakers</h2>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => setAdding('speakers')}
            >
              Add
            </Button>
          </div>
          {adding === 'speakers' && (
            <RowForm
              fields={[
                { k: 'name', label: 'Name' },
                { k: 'role', label: 'Role', optional: true },
              ]}
              onCancel={() => setAdding(null)}
              onSave={(b) => void addRow('speakers', b)}
            />
          )}
          {d.speakers.length === 0 && <p className="src">No speakers yet.</p>}
          {d.speakers.map((sp) => (
            <div key={sp.itemId} className="li">
              <StatusSelect
                label={`Status for ${String(sp.name)}`}
                value={sp.status as keyof typeof SPEAKER_TAG}
                tags={SPEAKER_TAG}
                onChange={(v) => void patchRow('speakers', sp.itemId, { status: v })}
              />
              <span className="flex-1">
                {String(sp.name)}
                {sp.role ? ` · ${String(sp.role)}` : ''}
              </span>
              <RemoveButton onClick={() => void removeRow('speakers', sp.itemId)} />
            </div>
          ))}

          <div className="card-hd mt-2">
            <h2 className="t text-[19px]">Crew &amp; volunteers</h2>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdding('crew')}>
              Add
            </Button>
          </div>
          {adding === 'crew' && (
            <RowForm
              fields={[
                { k: 'role', label: 'Role', placeholder: 'Door' },
                { k: 'needed', label: 'Needed', type: 'number' },
              ]}
              onCancel={() => setAdding(null)}
              onSave={(b) => void addRow('crew', { ...b, needed: Number(b.needed) || 1 })}
            />
          )}
          {d.crew.length === 0 && <p className="src">No crew roles yet.</p>}
          {d.crew.map((c) => {
            const filled = Number(c.filled);
            const needed = Number(c.needed);
            return (
              <div key={c.itemId} className="li">
                <span className="flex-1">{String(c.role)}</span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`One fewer for ${String(c.role)}`}
                    className="chip min-h-8 px-2"
                    disabled={filled <= 0}
                    onClick={() => void patchRow('crew', c.itemId, { filled: filled - 1 })}
                  >
                    −
                  </button>
                  <Tag tone={filled >= needed ? 'n' : 'c'}>
                    {filled} / {needed}
                  </Tag>
                  <button
                    type="button"
                    aria-label={`One more for ${String(c.role)}`}
                    className="chip min-h-8 px-2"
                    disabled={filled >= needed}
                    onClick={() => void patchRow('crew', c.itemId, { filled: filled + 1 })}
                  >
                    +
                  </button>
                </span>
                <RemoveButton onClick={() => void removeRow('crew', c.itemId)} />
              </div>
            );
          })}
        </Card>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Card
          className="flex-[3_1_480px]"
          title={
            <span className="flex items-center gap-3">
              <h2 className="t text-[19px]">Run sheet</h2>
              <Tag tone="c">Draft</Tag>
            </span>
          }
          action={
            <Button size="sm" variant="ghost" onClick={() => setAdding('run')}>
              Add item
            </Button>
          }
        >
          {adding === 'run' && (
            <RowForm
              fields={[
                { k: 'time', label: 'Time', type: 'time' },
                { k: 'item', label: 'Item' },
                { k: 'who', label: 'Who', optional: true },
              ]}
              onCancel={() => setAdding(null)}
              onSave={(b) => void addRow('run', b)}
            />
          )}
          {d.run.length === 0 && <p className="src">Nothing on the run sheet yet.</p>}
          <div className="flex flex-col">
            {d.run.map((r) => (
              <div key={r.itemId} className="li">
                <b className="w-16 flex-none">{time12(String(r.time))}</b>
                <span className="flex-1">{String(r.item)}</span>
                <span className="src">{String(r.who ?? '')}</span>
                <RemoveButton onClick={() => void removeRow('run', r.itemId)} />
              </div>
            ))}
          </div>
        </Card>

        <Card
          className="flex-[2_1_320px]"
          title="Budget"
          action={
            <Button size="sm" variant="ghost" onClick={() => setAdding('budget')}>
              Add line
            </Button>
          }
        >
          {adding === 'budget' && (
            <RowForm
              fields={[
                { k: 'item', label: 'Item' },
                { k: 'budget', label: 'Budget ($)', type: 'number', optional: true },
              ]}
              checkbox={{ k: 'inKind', label: 'In-kind' }}
              onCancel={() => setAdding(null)}
              onSave={(b) =>
                void addRow('budget', {
                  item: b.item,
                  inKind: b.inKind,
                  budgetCents: Math.round((Number(b.budget) || 0) * 100),
                })
              }
            />
          )}
          <DataTable>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Budget</th>
                <th scope="col">Spent</th>
              </tr>
            </thead>
            <tbody>
              {d.budget.map((b) => (
                <tr key={b.itemId}>
                  <td>{String(b.item)}</td>
                  <td>{b.inKind ? 'In-kind' : money(Number(b.budgetCents))}</td>
                  <td>
                    <SpentInput
                      label={`Spent on ${String(b.item)}`}
                      cents={Number(b.spentCents)}
                      onSave={(c) => void patchRow('budget', b.itemId, { spentCents: c })}
                    />
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <b>Total</b>
                </td>
                <td>
                  <b>{money(s.budgetCents)}</b>
                </td>
                <td>
                  <b>{money(s.spentCents)}</b>
                </td>
              </tr>
            </tbody>
          </DataTable>
          <label className="flex min-h-10 items-center gap-3">
            <input
              className="chk"
              type="checkbox"
              checked={e.surveyAfter}
              onChange={(ev) => void patchEvent({ surveyAfter: ev.target.checked })}
            />
            Send “how did you hear about us” survey after the event
          </label>
        </Card>
      </div>
    </>
  );
}

function StatusSelect<T extends string>({
  label,
  value,
  tags,
  onChange,
}: {
  label: string;
  value: T;
  tags: Record<T, readonly ['c' | 's' | 'n', string]>;
  onChange: (v: T) => void;
}) {
  const [tone] = tags[value] ?? ['s'];
  return (
    <select
      aria-label={label}
      className={`tag t${tone} cursor-pointer border-0`}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {(Object.keys(tags) as T[]).map((k) => (
        <option key={k} value={k}>
          {tags[k][1]}
        </option>
      ))}
    </select>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="src font-bold hover:text-cta"
      aria-label="Remove"
      onClick={onClick}
    >
      ×
    </button>
  );
}

function TicketsForm({ sold, onSave }: { sold: number; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(sold));
  return (
    <span className="flex items-end gap-2">
      <Field
        label="Tickets sold"
        type="number"
        min={0}
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <Button size="sm" variant="navy" onClick={() => onSave(Number(v) || 0)}>
        Save
      </Button>
    </span>
  );
}

function SpentInput({
  label,
  cents,
  onSave,
}: {
  label: string;
  cents: number;
  onSave: (c: number) => void;
}) {
  const [v, setV] = useState(cents ? String(cents / 100) : '');
  return (
    <input
      aria-label={label}
      className="w-24 rounded border border-input bg-transparent px-2 py-1"
      inputMode="decimal"
      placeholder="—"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const c = Math.round((Number(v) || 0) * 100);
        if (c !== cents) onSave(c);
      }}
    />
  );
}

function RowForm({
  fields,
  checkbox,
  onSave,
  onCancel,
}: {
  fields: { k: string; label: string; type?: string; placeholder?: string; optional?: boolean }[];
  checkbox?: { k: string; label: string };
  onSave: (b: Record<string, string | boolean>) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const ready = fields.every((f) => f.optional || v[f.k]?.trim());
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-input p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {fields.map((f) => (
          <Field
            key={f.k}
            label={f.label}
            type={f.type}
            placeholder={f.placeholder}
            value={v[f.k] ?? ''}
            onChange={(e) => setV({ ...v, [f.k]: e.target.value })}
          />
        ))}
      </div>
      {checkbox && (
        <label className="flex min-h-9 items-center gap-3">
          <input
            className="chk"
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          {checkbox.label}
        </label>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="cta"
          disabled={!ready}
          onClick={() =>
            onSave({
              ...Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim())),
              ...(checkbox ? { [checkbox.k]: checked } : {}),
            })
          }
        >
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
