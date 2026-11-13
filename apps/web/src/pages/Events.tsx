import { BackLink, DangerArea, EditDialog } from '../components/patterns.tsx';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  Bar,
  Button,
  Icon,
  Card,
  DataTable,
  Field,
  Notice,
  PageHeader,
  RowCard,
  Select,
  Tag,
  TextArea,
  WaveLoader,
} from '../components/ui.tsx';
import { aud, PRESET_COSTS } from '../components/Money.tsx';
import { VenuePicker, type Venue } from './Venues.tsx';
import { ContactPicker } from './Contacts.tsx';

/** BMG-only events (screen: Events · Industry Mixer Night). */

interface EventInfo {
  eventId: string;
  name: string;
  /** Workshops are events too; older events have no kind. */
  kind?: 'event' | 'workshop';
  date: string;
  venue: string;
  venueId?: string;
  startTime?: string;
  endTime?: string;
  capacity: number;
  ticketTarget: number;
  ticketPriceCents: number;
  ticketsSold: number;
  takingsCents: number;
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
    takingsCents: number;
    profitCents: number;
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

export function Events({
  cfg,
  token,
  openEventId,
}: {
  cfg: AppConfig;
  token: string;
  /** Open this event straight away (a row on Studio HQ's Tickets card). */
  openEventId?: string | null;
}) {
  const [events, setEvents] = useState<EventInfo[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(openEventId ?? null);
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
  const openEvent = events?.find((e) => e.eventId === openId);

  const actions = (
    <>
      <Button variant="default" onClick={() => setListing(true)}>
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
        <EventForm
          cfg={cfg}
          token={token}
          back={listing ? 'All events' : (openEvent?.name ?? 'Events')}
          onCancel={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setListing(false);
            setOpenId(id);
            void loadList();
          }}
        />
      )}
      {!creating && listing && events && (
        <>
          <PageHeader
            eyebrow="BMG only · Events"
            title="All events"
            sub={`${events.length} event${events.length === 1 ? '' : 's'}`}
            actions={
              <>
                {openEvent && <BackLink to={openEvent.name} onClick={() => setListing(false)} />}
                <Button variant="cta" onClick={() => setCreating(true)}>
                  New event
                </Button>
              </>
            }
          />
          {events.length === 0 ? (
            <Notice>No events yet. Start with the Industry Mixer Night.</Notice>
          ) : (
            <EventCards
              events={events}
              onOpen={(id) => {
                setOpenId(id);
                setListing(false);
              }}
            />
          )}
        </>
      )}
      {events === null && <WaveLoader />}
      {!creating && events?.length === 0 && !listing && (
        <>
          <PageHeader eyebrow="BMG only · Events" title="Events" actions={actions} />
          <Notice>No events yet. Start with the Industry Mixer Night.</Notice>
        </>
      )}
      {!creating && openId && !listing && (
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

/** When an event is, relative to today. */
function eventWhen(date: string): { label: string; tone: 'n' | 'c' | 's' } {
  const days = daysTo(date);
  if (days === 0) return { label: 'Today', tone: 'c' };
  if (days < 0) return { label: 'Done', tone: 's' };
  if (days <= 14) return { label: `In ${days} day${days === 1 ? '' : 's'}`, tone: 'c' };
  return { label: 'Upcoming', tone: 'n' };
}

/** All events as cards (upcoming first, then past); tapping one opens its detail. */
function EventCards({
  events,
  onOpen,
}: {
  events: EventInfo[];
  onOpen: (eventId: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events.filter((e) => e.date >= today);
  const past = events.filter((e) => e.date < today).reverse();
  const group = (title: string, list: EventInfo[]) =>
    list.length > 0 && (
      <section className="flex flex-col gap-3" aria-label={title}>
        <span className="eyebrow">{title}</span>
        <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((e) => {
            const when = eventWhen(e.date);
            const d = new Date(`${e.date}T00:00:00`);
            return (
              <li key={e.eventId} className="flex">
                <button
                  type="button"
                  className="card ev-card flex-1 gap-3 text-left"
                  onClick={() => onOpen(e.eventId)}
                >
                  <span className="flex items-start gap-3">
                    <span className="flex w-14 flex-none flex-col items-center rounded-lg bg-primary py-1.5 leading-none text-primary-foreground">
                      <span className="text-[11px] font-bold tracking-wide uppercase opacity-80">
                        {d.toLocaleDateString('en-AU', { month: 'short' })}
                      </span>
                      <span className="t text-[24px]">{d.getDate()}</span>
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <b className="t line-clamp-2 text-[19px] leading-tight">{e.name}</b>
                      {e.kind === 'workshop' && (
                        <span>
                          <Tag tone="c">Workshop</Tag>
                        </span>
                      )}
                      <span className="src">
                        {[
                          d.toLocaleDateString('en-AU', { weekday: 'short' }),
                          eventTimes(e.startTime, e.endTime),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <Tag tone={when.tone}>{when.label}</Tag>
                  </span>
                  <span className="src line-clamp-1">{e.venue || 'Venue not set'}</span>
                  <span className="flex flex-col gap-1.5">
                    <span className="flex text-sm">
                      <span className="flex-1">Tickets</span>
                      <b>
                        {e.ticketsSold}
                        {e.ticketTarget ? ` / ${e.ticketTarget}` : ''}
                      </b>
                    </span>
                    <Bar pct={pct(e.ticketsSold, e.ticketTarget)} color="#D9534F" />
                  </span>
                  <span className="text-sm font-bold underline">Open event</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    );
  return (
    <div className="flex flex-col gap-6">
      {group('Upcoming', upcoming)}
      {group('Past', past)}
    </div>
  );
}

/** "6 pm – 11:30 pm", with "(next day)" when it runs past midnight. */
export const eventTimes = (start?: string, end?: string) =>
  start && end ? `${time12(start)} – ${time12(end)}${end < start ? ' (next day)' : ''}` : '';

/** Create an event, or edit one's details. Start and end times are required (rev 7). */
function EventForm({
  cfg,
  token,
  event,
  back,
  onCancel,
  onSaved,
}: {
  cfg: AppConfig;
  token: string;
  event?: EventInfo;
  /** P8: where Back goes (the event, or the page New event was opened from). */
  back: string;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState({
    name: event?.name ?? '',
    kind: event?.kind ?? 'event',
    date: event?.date ?? '',
    startTime: event?.startTime ?? '',
    endTime: event?.endTime ?? '',
    capacity: event?.capacity ? String(event.capacity) : '',
    ticketTarget: event?.ticketTarget ? String(event.ticketTarget) : '',
    ticketPrice: event?.ticketPriceCents ? String(event.ticketPriceCents / 100) : '',
    compsTarget: event?.compsTarget ? String(event.compsTarget) : '',
  });
  const [venue, setVenue] = useState<{ venueId: string | null; name: string } | null>(
    event?.venue ? { venueId: event.venueId ?? null, name: event.venue } : null,
  );
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const timeError =
    !f.startTime || !f.endTime
      ? 'Add a start and an end time'
      : f.startTime === f.endTime
        ? 'The end time must be after the start time'
        : null;
  /** Picking a venue from the list fills in its capacity if none is set. */
  async function pickVenue(v: { venueId: string | null; name: string } | null) {
    setVenue(v);
    if (!v?.venueId || f.capacity) return;
    try {
      const full = await api<Venue>(cfg, token, 'GET', `/venues/${v.venueId}`);
      if (full.capacity)
        setF((cur) => ({ ...cur, capacity: cur.capacity || String(full.capacity) }));
    } catch {
      // Capacity is only a convenience.
    }
  }
  async function save() {
    const body = {
      name: f.name,
      kind: f.kind,
      date: f.date,
      startTime: f.startTime,
      endTime: f.endTime,
      venue: venue?.name ?? '',
      ...(venue?.venueId ? { venueId: venue.venueId } : {}),
      capacity: Number(f.capacity) || 0,
      ticketTarget: Number(f.ticketTarget) || 0,
      ticketPriceCents: Math.round((Number(f.ticketPrice) || 0) * 100),
      compsTarget: Number(f.compsTarget) || 0,
    };
    try {
      if (event) {
        await api(cfg, token, 'PATCH', `/events/${event.eventId}`, body);
        onSaved(event.eventId);
      } else {
        const e = await api<EventInfo>(cfg, token, 'POST', '/events', body);
        onSaved(e.eventId);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    // Rev 13: Edit details is its own screen (P4), with Back to the event.
    <Card
      title={event ? 'Edit event' : 'New event'}
      action={<BackLink to={back} onClick={onCancel} />}
    >
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Name"
          value={f.name}
          onChange={set('name')}
          placeholder="Industry Mixer Night"
        />
        <Select
          label="Type"
          value={f.kind}
          onChange={set('kind')}
          options={[
            { value: 'event', label: 'Event' },
            { value: 'workshop', label: 'Workshop' },
          ]}
        />
        <Field label="Date" type="date" value={f.date} onChange={set('date')} />
        <Field
          label="Start time"
          type="time"
          required
          value={f.startTime}
          onChange={set('startTime')}
        />
        <Field
          label="End time"
          type="time"
          required
          value={f.endTime}
          onChange={set('endTime')}
          {...(f.startTime && f.endTime && f.endTime < f.startTime
            ? { hint: 'Finishes after midnight' }
            : f.startTime && f.startTime === f.endTime
              ? { hint: 'The end time must be after the start time' }
              : {})}
        />
        <VenuePicker
          cfg={cfg}
          token={token}
          isBmg
          value={venue}
          onChange={(v) => void pickVenue(v)}
        />
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
        <Button
          variant="cta"
          disabled={!f.name.trim() || !f.date || !!timeError}
          onClick={() => void save()}
        >
          {event ? 'Save details' : 'Create event'}
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
  const [editingDetails, setEditingDetails] = useState(false);
  /** A line (guest, speaker, crew role, run sheet item, cost) open for editing. */
  const [line, setLine] = useState<{ part: Part; row: Row } | null>(null);
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
  const addRow = (part: Part, body: Record<string, unknown>) =>
    run(async () => {
      await api(cfg, token, 'POST', `${base}/${part}`, body);
      setAdding(null);
    });

  if (!d)
    return error ? (
      <>
        <PageHeader eyebrow="BMG only · Events" title="Event" actions={actions} />
        <Notice tone="error">{error}</Notice>
      </>
    ) : (
      <WaveLoader />
    );
  const { event: e, summary: s } = d;
  const days = daysTo(e.date);
  if (editingDetails) {
    return (
      <EventForm
        cfg={cfg}
        token={token}
        event={e}
        back={e.name}
        onCancel={() => setEditingDetails(false)}
        onSaved={() => {
          setEditingDetails(false);
          void load();
          onChanged();
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="BMG only · Events"
        title={e.name}
        sub={[
          longDate(e.date),
          eventTimes(e.startTime, e.endTime),
          e.venue,
          days > 0 ? `${days} day${days === 1 ? '' : 's'} to go` : days === 0 ? 'Today' : 'Done',
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setEditingDetails(true)}>
              <Icon name="pencil" size={16} />
              Edit details
            </Button>
            {actions}
          </>
        }
      />
      {error && <Notice tone="error">{error}</Notice>}
      {(!e.startTime || !e.endTime) && (
        <Notice>
          This event has no start and end time yet.{' '}
          <button
            type="button"
            className="font-bold underline"
            onClick={() => setEditingDetails(true)}
          >
            Add them
          </button>
        </Notice>
      )}

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
          {!e.humanitixEventId && !editingSales && (
            <HumanitixLink
              cfg={cfg}
              token={token}
              onLink={(humanitixEventId) =>
                run(async () => {
                  await api(cfg, token, 'PUT', `${base}/humanitix`, { humanitixEventId });
                  onChanged();
                })
              }
            />
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
          <span className="eyebrow">Profit</span>
          <span className={`t text-[36px] ${s.profitCents < 0 ? 'text-[#8E2F2C]' : ''}`}>
            {aud(s.profitCents)}
          </span>
          <span className="src">
            Takings {aud(s.takingsCents)} − costs {aud(s.spentCents)} · budget{' '}
            {money(s.budgetCents)}
          </span>
        </Card>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Card
          className="flex-[3_1_480px]"
          title={
            <span className="flex flex-wrap items-baseline gap-3">
              <h2 className="poster text-[20px] leading-none">Guest list</h2>
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
            <DataTable
              label="Guests"
              cards={d.guests.map((g) => (
                <RowCard
                  key={g.itemId}
                  title={String(g.name)}
                  sub={[String(g.type || ''), g.fromOutreach ? 'From the outreach list' : '']
                    .filter(Boolean)
                    .join(' · ')}
                  openLabel="Edit guest"
                  onOpen={() => setLine({ part: 'guests', row: g })}
                  actions={
                    <StatusSelect
                      label={`Status for ${String(g.name)}`}
                      value={g.status as keyof typeof GUEST_TAG}
                      tags={GUEST_TAG}
                      onChange={(v) => void patchRow('guests', g.itemId, { status: v })}
                    />
                  }
                />
              ))}
            >
              <thead>
                <tr>
                  <th scope="col">Guest</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">From outreach list</th>
                </tr>
              </thead>
              <tbody>
                {d.guests.map((g) => {
                  const status = g.status as keyof typeof GUEST_TAG;
                  return (
                    <tr key={g.itemId}>
                      <td>
                        <LineLink
                          label={String(g.name)}
                          onOpen={() => setLine({ part: 'guests', row: g })}
                        />
                      </td>
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
            <h2 className="poster text-[20px] leading-none">Speakers</h2>
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
                <LineLink
                  label={String(sp.name)}
                  onOpen={() => setLine({ part: 'speakers', row: sp })}
                />
                {sp.role ? <span className="src"> · {String(sp.role)}</span> : null}
              </span>
            </div>
          ))}

          <div className="card-hd mt-2">
            <h2 className="poster text-[20px] leading-none">Crew &amp; volunteers</h2>
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
          {d.crew.map((c) => (
            <CrewRole
              key={c.itemId}
              cfg={cfg}
              token={token}
              role={c as CrewRow}
              onPatch={(body) => patchRow('crew', c.itemId, body)}
              onOpen={() => setLine({ part: 'crew', row: c })}
            />
          ))}
          <p className="src">Everyone on the crew is saved to Contacts.</p>
        </Card>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Card
          className="flex-[3_1_480px]"
          title={
            <span className="flex items-center gap-3">
              <h2 className="poster text-[20px] leading-none">Run sheet</h2>
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
                {
                  k: 'notes',
                  label: 'Notes',
                  optional: true,
                  placeholder: 'Cues, gear, who to call',
                },
              ]}
              onCancel={() => setAdding(null)}
              onSave={(b) => void addRow('run', b)}
            />
          )}
          {d.run.length === 0 && <p className="src">Nothing on the run sheet yet.</p>}
          <div className="flex flex-col">
            {d.run.map((r) => (
              <div key={r.itemId} className="li flex-wrap">
                <b className="w-16 flex-none">{time12(String(r.time))}</b>
                <span className="flex-1">
                  <LineLink
                    label={String(r.item)}
                    onOpen={() => setLine({ part: 'run', row: r })}
                  />
                </span>
                <span className="src">{String(r.who ?? '')}</span>
                {r.notes ? (
                  <span className="src w-full pl-16 whitespace-pre-line">{String(r.notes)}</span>
                ) : null}
              </div>
            ))}
          </div>
        </Card>

        <Card
          className="flex-[2_1_320px]"
          title="Takings, costs and profit"
          action={
            <Button size="sm" variant="ghost" onClick={() => setAdding('budget')}>
              + Add a cost
            </Button>
          }
        >
          <div className="flex flex-wrap items-end gap-3">
            <span className="flex flex-col gap-1.5">
              <span className="text-[15px] font-bold">Tickets sold</span>
              <span className="t text-[22px]">{e.ticketsSold}</span>
            </span>
            <label className="flex flex-col gap-1.5">
              <span className="text-[15px] font-bold">Total event takings ($)</span>
              <SpentInput
                label="Total event takings"
                cents={e.takingsCents ?? 0}
                onSave={(c) => void patchEvent({ takingsCents: c })}
              />
            </label>
          </div>
          {PRESET_COSTS.some((p) => !d.budget.some((b) => String(b.item) === p)) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void run(async () => {
                  for (const item of PRESET_COSTS.filter(
                    (p) => !d.budget.some((b) => String(b.item) === p),
                  )) {
                    await api(cfg, token, 'POST', `${base}/budget`, { item });
                  }
                })
              }
            >
              Add standard costs (venue, photography, videography, content, bands)
            </Button>
          )}
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
          <DataTable
            label="Budget"
            cards={
              <>
                {d.budget.map((b) => (
                  <RowCard
                    key={b.itemId}
                    title={String(b.item)}
                    sub={b.inKind ? 'In-kind' : `Budget ${money(Number(b.budgetCents))}`}
                    openLabel="Edit cost"
                    onOpen={() => setLine({ part: 'budget', row: b })}
                    actions={
                      <SpentInput
                        label={`Spent on ${String(b.item)}`}
                        cents={Number(b.spentCents)}
                        onSave={(c) => void patchRow('budget', b.itemId, { spentCents: c })}
                      />
                    }
                  />
                ))}
                <RowCard
                  title="Total"
                  sub={`Budget ${money(s.budgetCents)} · Spent ${money(s.spentCents)}`}
                  status={
                    <b className={s.profitCents < 0 ? 'text-[#8E2F2C]' : ''}>
                      {aud(s.profitCents)}
                      {s.profitCents < 0 ? ' loss' : ' profit'}
                    </b>
                  }
                />
              </>
            }
          >
            <thead>
              <tr>
                <th scope="col">Cost</th>
                <th scope="col">Budget</th>
                <th scope="col">Spent</th>
              </tr>
            </thead>
            <tbody>
              {d.budget.map((b) => (
                <tr key={b.itemId}>
                  <td>
                    <LineLink
                      label={String(b.item)}
                      onOpen={() => setLine({ part: 'budget', row: b })}
                    />
                  </td>
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
              <tr>
                <td colSpan={2}>
                  <b>Profit</b> <span className="src">(takings − spent)</span>
                </td>
                <td>
                  <b className={s.profitCents < 0 ? 'text-[#8E2F2C]' : ''}>
                    {aud(s.profitCents)}
                    {s.profitCents < 0 && ' loss'}
                  </b>
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
      {line && (
        <LineEditor
          key={line.row.itemId}
          part={line.part}
          row={line.row}
          onCancel={() => setLine(null)}
          onSave={async (body) => {
            await api(cfg, token, 'PATCH', `${base}/${line.part}/${line.row.itemId}`, body);
            setLine(null);
            await load();
          }}
          onRemove={async () => {
            await api(cfg, token, 'DELETE', `${base}/${line.part}/${line.row.itemId}`);
            setLine(null);
            await load();
          }}
        />
      )}
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

/** A line's name: opens its edit dialog (P1: the line opens; no buttons on it). */
function LineLink({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button type="button" className="text-left font-bold hover:underline" onClick={onOpen}>
      {label}
    </button>
  );
}

/** Links the event to its Humanitix event, so ticket sales come in by themselves. */
function HumanitixLink({
  cfg,
  token,
  onLink,
}: {
  cfg: AppConfig;
  token: string;
  onLink: (id: string) => void;
}) {
  const [events, setEvents] = useState<{ id: string; name: string; startDate?: string }[] | null>(
    null,
  );
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    try {
      const r = await api<{ events: { id: string; name: string; startDate?: string }[] }>(
        cfg,
        token,
        'GET',
        '/connectors/humanitix/events',
      );
      setEvents(r.events);
      setPick(r.events[0]?.id ?? '');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (error) return <span className="src">{error}</span>;
  if (!events)
    return (
      <button
        type="button"
        className="src self-start font-bold underline"
        onClick={() => void open()}
      >
        Link to Humanitix
      </button>
    );
  if (events.length === 0)
    return <span className="src">Connect Humanitix in Connectors first.</span>;
  return (
    <span className="flex items-end gap-2">
      <label className="flex flex-1 flex-col gap-1.5">
        <span className="text-[15px] font-bold">Humanitix event</span>
        <select
          className="min-h-11 rounded-lg border border-input bg-white px-3"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
        >
          {events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.name}
              {ev.startDate ? ` · ${new Date(ev.startDate).toLocaleDateString('en-AU')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" variant="navy" disabled={!pick} onClick={() => onLink(pick)}>
        Link
      </Button>
    </span>
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

interface CrewPerson {
  contactId?: string;
  name: string;
  email: string;
  phone: string;
  type: 'crew' | 'volunteer';
}
type CrewRow = Row & {
  role: string;
  needed: number;
  filled: number;
  names?: string;
  people?: CrewPerson[];
};

/**
 * One crew role: who is on it (name, email, phone; crew or volunteer). Adding
 * someone saves them to Contacts, or links them if they're already there.
 */
function CrewRole({
  cfg,
  token,
  role,
  onPatch,
  onOpen,
}: {
  cfg: AppConfig;
  token: string;
  role: CrewRow;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  /** Opens the role's edit dialog: its name, how many, who's on it, and Remove. */
  onOpen: () => void;
}) {
  const people = role.people ?? [];
  const filled = role.people ? people.length : Number(role.filled);
  const needed = Number(role.needed);
  const [adding, setAdding] = useState(false);
  const save = (next: CrewPerson[]) => onPatch({ people: next });
  return (
    <div className="flex flex-col gap-1.5 border-b border-input py-2">
      <div className="flex items-center gap-2">
        <span className="flex-1">
          <LineLink label={role.role} onOpen={onOpen} />
        </span>
        <Tag tone={filled >= needed ? 'n' : 'c'}>
          {filled} / {needed}
        </Tag>
        <Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
          + Person
        </Button>
      </div>
      {!role.people && role.names && (
        <span className="src">
          Names noted: {role.names}. Add each person with their email and phone to save them to
          Contacts.
        </span>
      )}
      {people.map((p, i) => (
        <div
          key={`${p.contactId ?? p.email}-${i}`}
          className="flex items-center gap-2 pl-2 text-[15px]"
        >
          <span className="flex-1">
            <b>{p.name}</b>{' '}
            <span className="src">
              <a href={`mailto:${p.email}`}>{p.email}</a> ·{' '}
              <a href={`tel:${p.phone.replace(/\s/g, '')}`}>{p.phone}</a>
            </span>
          </span>
          <Tag tone={p.type === 'volunteer' ? 's' : 'n'}>
            {p.type === 'volunteer' ? 'Volunteer' : 'Crew'}
          </Tag>
        </div>
      ))}
      {adding && (
        <CrewPersonForm
          cfg={cfg}
          token={token}
          role={role.role}
          onCancel={() => setAdding(false)}
          onSave={async (p) => {
            await save([...people, p]);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function CrewPersonForm({
  cfg,
  token,
  role,
  onSave,
  onCancel,
}: {
  cfg: AppConfig;
  token: string;
  role: string;
  onSave: (p: CrewPerson) => Promise<void>;
  onCancel: () => void;
}) {
  const [p, setP] = useState<CrewPerson>({ name: '', email: '', phone: '', type: 'crew' });
  const [busy, setBusy] = useState(false);
  const set = (k: 'name' | 'email' | 'phone') => (e: { target: { value: string } }) =>
    setP({ ...p, [k]: e.target.value });
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim());
  const phoneOk = p.phone.replace(/\D/g, '').length >= 6;
  const ready = p.name.trim() && emailOk && phoneOk;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-input p-3">
      <ContactPicker
        cfg={cfg}
        token={token}
        isBmg
        label={`Pick someone for ${role} from contacts`}
        value={null}
        defaultTags={[p.type === 'volunteer' ? 'Volunteer' : 'Crew']}
        onChange={(c) =>
          c && setP({ ...p, contactId: c.contactId, name: c.name, email: c.email, phone: c.phone })
        }
      />
      <span className="src">…or type their details:</span>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" value={p.name} onChange={set('name')} />
        <Field label="Email" type="email" value={p.email} onChange={set('email')} />
        <Field label="Phone" type="tel" value={p.phone} onChange={set('phone')} />
      </div>
      <div className="flex gap-2" role="group" aria-label="Crew or volunteer">
        {(['crew', 'volunteer'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className="chip min-h-9"
            aria-pressed={p.type === t}
            onClick={() => setP({ ...p, type: t })}
          >
            {t === 'crew' ? 'Crew' : 'Volunteer'}
          </button>
        ))}
      </div>
      {p.name && (!emailOk || !phoneOk) && (
        <span className="src">Crew and volunteers need a name, email and phone number.</span>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="navy"
          disabled={!ready || busy}
          onClick={() => {
            setBusy(true);
            void onSave({
              ...p,
              name: p.name.trim(),
              email: p.email.trim(),
              phone: p.phone.trim(),
            }).finally(() => setBusy(false));
          }}
        >
          Add to {role}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
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

const LINE_WORDS: Record<Part, { one: string; gone: string }> = {
  guests: { one: 'guest', gone: 'They come off the guest list.' },
  speakers: { one: 'speaker', gone: 'They come off the speaker list.' },
  crew: {
    one: 'crew role',
    gone: "The role and who's on it come off the event. Everyone stays in Contacts.",
  },
  run: { one: 'run sheet item', gone: 'It comes off the run sheet.' },
  budget: { one: 'cost', gone: 'It comes off the budget, and the profit is worked out again.' },
};

/** The display name of a line, for titles. */
const lineName = (part: Part, r: Row) =>
  String((part === 'crew' ? r.role : part === 'run' || part === 'budget' ? r.item : r.name) ?? '');

/**
 * Editing one line of the event (P4 in a dialog): its fields, Save and Cancel,
 * then Remove in the danger area. Quick changes (a guest's status, what a cost
 * cost, adding someone to a crew role) stay on the page as single actions (P3).
 */
function LineEditor({
  part,
  row,
  onSave,
  onRemove,
  onCancel,
}: {
  part: Part;
  row: Row;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onRemove: () => Promise<void>;
  onCancel: () => void;
}) {
  const str = (k: string) => String(row[k] ?? '');
  const [v, setV] = useState<Record<string, string>>(() => ({
    name: str('name'),
    type: str('type'),
    email: str('email'),
    role: str('role'),
    needed: String(row.needed ?? 1),
    time: str('time'),
    item: str('item'),
    who: str('who'),
    notes: str('notes'),
    budget: row.budgetCents ? String(Number(row.budgetCents) / 100) : '',
  }));
  const [flag, setFlag] = useState(
    part === 'guests' ? !!row.fromOutreach : part === 'budget' ? !!row.inKind : false,
  );
  const [people, setPeople] = useState<CrewPerson[]>((row.people as CrewPerson[]) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  const name = lineName(part, row);
  const words = LINE_WORDS[part];

  const required: Record<Part, string[]> = {
    guests: ['name'],
    speakers: ['name'],
    crew: ['role'],
    run: ['time', 'item'],
    budget: ['item'],
  };
  const ready = required[part].every((k) => v[k]?.trim());

  function body(): Record<string, unknown> {
    const t = (k: string) => v[k]!.trim();
    switch (part) {
      case 'guests':
        return {
          name: t('name'),
          type: t('type'),
          ...(t('email') ? { email: t('email') } : {}),
          fromOutreach: flag,
        };
      case 'speakers':
        return { name: t('name'), role: t('role') };
      case 'crew':
        return {
          role: t('role'),
          needed: Math.max(0, Math.round(Number(t('needed')) || 0)),
          ...(row.people ? { people } : {}),
        };
      case 'run':
        return { time: t('time'), item: t('item'), who: t('who'), notes: t('notes') };
      case 'budget':
        return {
          item: t('item'),
          inKind: flag,
          budgetCents: Math.round((Number(t('budget')) || 0) * 100),
        };
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(body());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <EditDialog
      title={`Edit ${words.one}`}
      onSave={save}
      onCancel={onCancel}
      busy={busy}
      canSave={ready}
      error={error}
      danger={
        <DangerArea
          title={`Remove ${name || `this ${words.one}`}`}
          action="Remove"
          what={words.gone}
          onConfirm={onRemove}
        />
      }
    >
      {part === 'guests' && (
        <>
          <Field label="Guest" value={v.name} maxLength={120} onChange={set('name')} required />
          <Field label="Type" value={v.type} maxLength={80} onChange={set('type')} />
          <Field label="Email" type="email" value={v.email} onChange={set('email')} />
          <label className="flex min-h-9 items-center gap-3">
            <input
              className="chk"
              type="checkbox"
              checked={flag}
              onChange={(e) => setFlag(e.target.checked)}
            />
            From the outreach list
          </label>
        </>
      )}
      {part === 'speakers' && (
        <>
          <Field label="Name" value={v.name} maxLength={120} onChange={set('name')} required />
          <Field label="Role" value={v.role} maxLength={120} onChange={set('role')} />
        </>
      )}
      {part === 'crew' && (
        <>
          <Field label="Role" value={v.role} maxLength={120} onChange={set('role')} required />
          <Field
            label="Needed"
            type="number"
            min={0}
            max={100}
            value={v.needed}
            onChange={set('needed')}
          />
          {people.length > 0 && (
            <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
              <legend className="pb-1 text-[15px] font-bold">On this role</legend>
              {people.map((p, i) => (
                <span
                  key={`${p.contactId ?? p.email}-${i}`}
                  className="flex min-h-9 items-center gap-2"
                >
                  <span className="flex-1">
                    {p.name}{' '}
                    <span className="src">{p.type === 'volunteer' ? 'Volunteer' : 'Crew'}</span>
                  </span>
                  {/* Exception: a line inside a form is removed in the form. */}
                  <button
                    type="button"
                    className="src font-bold hover:text-cta"
                    aria-label={`Take ${p.name} off ${v.role || name}`}
                    onClick={() => setPeople(people.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
              <span className="src">They stay in Contacts.</span>
            </fieldset>
          )}
        </>
      )}
      {part === 'run' && (
        <>
          <Field label="Time" type="time" value={v.time} onChange={set('time')} required />
          <Field label="Item" value={v.item} maxLength={200} onChange={set('item')} required />
          <Field label="Who" value={v.who} maxLength={120} onChange={set('who')} />
          <TextArea
            label="Notes"
            value={v.notes}
            maxLength={1000}
            placeholder="Cues, gear, who to call"
            onChange={set('notes')}
          />
        </>
      )}
      {part === 'budget' && (
        <>
          <Field label="Item" value={v.item} maxLength={120} onChange={set('item')} required />
          <Field
            label="Budget ($)"
            type="number"
            min={0}
            step="0.01"
            value={v.budget}
            disabled={flag}
            onChange={set('budget')}
          />
          <label className="flex min-h-9 items-center gap-3">
            <input
              className="chk"
              type="checkbox"
              checked={flag}
              onChange={(e) => setFlag(e.target.checked)}
            />
            In-kind
          </label>
        </>
      )}
    </EditDialog>
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
