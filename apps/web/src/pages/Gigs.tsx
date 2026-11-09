import { useCallback, useEffect, useState } from 'react';
import { api, type ArtistSummary } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  Bar,
  Button,
  Card,
  Chips,
  DataTable,
  Field,
  Notice,
  Select,
  Tag,
  TextArea,
} from '../components/ui.tsx';

/** Gigs (screens: workspace Gigs tab, BMG Artist gigs, artist My gigs / Plan a gig). */

export type GigStatus = 'idea' | 'pitching' | 'confirmed' | 'booked' | 'played' | 'cancelled';
export type GigDeal = 'tbc' | 'free' | 'fee' | 'door-split' | 'ticketed' | 'other';
export type HelpTopic = 'pitch' | 'budget' | 'promo' | 'setlist';
export interface Gig {
  gigId: string;
  artistId: string;
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  venue?: string;
  notes?: string;
  status: GigStatus;
  deal: GigDeal;
  dealNote?: string;
  ticketUrl?: string;
  checklist: { id: string; title: string; done: boolean }[];
  plannedBy: 'artist' | 'bmg';
  shared: boolean;
  help?: { text: string; topics: HelpTopic[]; askedAt: string; status: 'open' | 'done' };
}

export const STATUS: Record<GigStatus, ['c' | 's' | 'n', string]> = {
  idea: ['s', 'Idea'],
  pitching: ['c', 'Pitching'],
  confirmed: ['n', 'Confirmed'],
  booked: ['n', 'Booked'],
  played: ['s', 'Played'],
  cancelled: ['s', 'Cancelled'],
};
const DEAL: Record<GigDeal, string> = {
  tbc: 'Not set yet',
  free: 'Free',
  fee: 'Fixed fee',
  'door-split': 'Door split',
  ticketed: 'Ticketed',
  other: 'Other',
};
export const HELP: Record<HelpTopic, string> = {
  pitch: 'Pitch email',
  budget: 'Budget',
  promo: 'Promo',
  setlist: 'Set list',
};

const today = () => new Date().toISOString().slice(0, 10);
const isPast = (g: Gig) => g.date < today() || g.status === 'played' || g.status === 'cancelled';
const longDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
/** "7:30 pm – 11:00 pm", with "(next day)" when it runs past midnight. */
export function timeRange(start?: string, end?: string): string {
  if (!start) return '';
  const fmt = (t: string) =>
    new Date(`2000-01-01T${t}:00`)
      .toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
      .replace(':00', '');
  if (!end) return fmt(start);
  return `${fmt(start)} – ${fmt(end)}${end < start ? ' (next day)' : ''}`;
}
const when = (g: Gig) =>
  [longDate(g.date), timeRange(g.startTime, g.endTime)].filter(Boolean).join(', ');

/** "Other" shows what the user wrote. */
const dealLabel = (g: Pick<Gig, 'deal' | 'dealNote'>) =>
  g.deal === 'other' && g.dealNote ? g.dealNote : DEAL[g.deal];

const done = (g: Gig) => `${g.checklist.filter((c) => c.done).length} / ${g.checklist.length}`;
const helpLabel = (g: Gig) =>
  g.help?.topics.length ? g.help.topics.map((t) => HELP[t]).join(' · ') : 'Help';

function useGigs(cfg: AppConfig, token: string, path: string) {
  const [gigs, setGigs] = useState<Gig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setGigs((await api<{ gigs: Gig[] }>(cfg, token, 'GET', path)).gigs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, path]);
  useEffect(() => void load(), [load]);
  async function patch(g: Gig, body: Record<string, unknown>) {
    try {
      await api(cfg, token, 'PATCH', `/artists/${g.artistId}/gigs/${g.gigId}`, body);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  return { gigs, error, setError, load, patch };
}

function Checklist({ gig, onPatch }: { gig: Gig; onPatch: (b: Record<string, unknown>) => void }) {
  return (
    <div className="flex flex-col">
      {gig.checklist.map((c) => (
        <label key={c.id} className="flex min-h-[38px] items-center gap-3">
          <input
            className="chk"
            type="checkbox"
            checked={c.done}
            onChange={() =>
              onPatch({
                checklist: gig.checklist.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)),
              })
            }
          />
          {c.title}
        </label>
      ))}
    </div>
  );
}

const STATUS_OPTIONS = (Object.keys(STATUS) as GigStatus[]).map((s) => ({
  value: s,
  label: STATUS[s][1],
}));
const DEAL_OPTIONS = (Object.keys(DEAL) as GigDeal[]).map((d) => ({
  value: d,
  label: DEAL[d],
}));

/** Add or edit a gig: the Plan a gig fields. Artists also choose sharing and help. */
function GigForm({
  cfg,
  token,
  artistId,
  gig,
  isArtist,
  onSaved,
  onCancel,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  gig?: Gig;
  isArtist: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    title: gig?.title ?? '',
    date: gig?.date ?? '',
    startTime: gig?.startTime ?? '',
    endTime: gig?.endTime ?? '',
    venue: gig?.venue ?? '',
    status: gig?.status ?? ('idea' as GigStatus),
    deal: gig?.deal ?? ('tbc' as GigDeal),
    dealNote: gig?.dealNote ?? '',
    ticketUrl: gig?.ticketUrl ?? '',
    notes: gig?.notes ?? '',
    shared: gig?.shared ?? true,
  });
  const [topics, setTopics] = useState<HelpTopic[]>([]);
  const [helpText, setHelpText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const timeError =
    f.endTime && !f.startTime
      ? 'Add a start time too'
      : f.startTime && f.startTime === f.endTime
        ? 'The end time must be after the start time'
        : null;

  async function save() {
    const body = {
      title: f.title,
      date: f.date,
      ...(gig
        ? { startTime: f.startTime || null, endTime: f.endTime || null }
        : {
            ...(f.startTime ? { startTime: f.startTime } : {}),
            ...(f.endTime ? { endTime: f.endTime } : {}),
          }),
      status: f.status,
      deal: f.deal,
      ...(f.deal === 'other' ? { dealNote: f.dealNote.trim() } : {}),
      ...(f.venue ? { venue: f.venue } : {}),
      ...(f.ticketUrl ? { ticketUrl: f.ticketUrl } : {}),
      ...(f.notes ? { notes: f.notes } : {}),
      ...(isArtist ? { shared: f.shared } : {}),
    };
    try {
      const saved = gig
        ? (await api(cfg, token, 'PATCH', `/artists/${artistId}/gigs/${gig.gigId}`, body), gig)
        : await api<Gig>(cfg, token, 'POST', `/artists/${artistId}/gigs`, body);
      if (isArtist && (topics.length || helpText.trim())) {
        await api(cfg, token, 'PATCH', `/artists/${artistId}/gigs/${saved.gigId}`, {
          askHelp: { topics, text: helpText.trim() },
        });
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <Notice tone="error">{error}</Notice>}
      <Field label="Gig" value={f.title} onChange={set('title')} placeholder="Headline set" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" type="date" value={f.date} onChange={set('date')} />
        <Select label="Status" value={f.status} onChange={set('status')} options={STATUS_OPTIONS} />
        <Field label="Start time" type="time" value={f.startTime} onChange={set('startTime')} />
        <Field
          label="End time"
          type="time"
          value={f.endTime}
          onChange={set('endTime')}
          {...(timeError
            ? { hint: timeError }
            : f.startTime && f.endTime && f.endTime < f.startTime
              ? { hint: 'Finishes after midnight' }
              : {})}
        />
        <Field label="Venue" value={f.venue} onChange={set('venue')} />
        <Select label="Deal" value={f.deal} onChange={set('deal')} options={DEAL_OPTIONS} />
        {f.deal === 'other' && (
          <Field
            label="Describe the deal"
            value={f.dealNote}
            onChange={set('dealNote')}
            maxLength={300}
            placeholder="e.g. 70/30 door split after costs, plus rider"
          />
        )}
        <Field
          label="Tickets"
          type="url"
          value={f.ticketUrl}
          onChange={set('ticketUrl')}
          placeholder="Ticket link"
        />
      </div>
      <TextArea label="Notes" value={f.notes} onChange={set('notes')} />
      {isArtist && (
        <div className="bp flex flex-col gap-2 rounded-lg p-3.5 text-[#F1F4F7]">
          <label className="flex min-h-9 items-center font-bold">
            <span className="flex-1">Share with Blueprint</span>
            <input
              className="chk"
              type="checkbox"
              style={{ accentColor: '#D9534F' }}
              checked={f.shared}
              disabled={gig?.plannedBy === 'bmg'}
              onChange={(e) => setF({ ...f, shared: e.target.checked })}
            />
          </label>
          <span className="text-sm text-[#D3D8DE]">Ask Blueprint to help with:</span>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(HELP) as HelpTopic[]).map((t) => {
              const on = topics.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={on}
                  className={`min-h-[38px] rounded-lg border px-3.5 text-sm font-bold ${on ? 'border-[#F1F4F7] bg-[#F1F4F7] text-primary' : 'border-[#5C6775] text-[#F1F4F7]'}`}
                  onClick={() => setTopics(on ? topics.filter((x) => x !== t) : [...topics, t])}
                >
                  {HELP[t]}
                  {on && ' ✓'}
                </button>
              );
            })}
          </div>
          {topics.length > 0 && (
            <input
              aria-label="Anything Blueprint should know"
              className="min-h-11 rounded-lg border-0 px-3 text-primary"
              placeholder="Anything Blueprint should know?"
              value={helpText}
              onChange={(e) => setHelpText(e.target.value)}
            />
          )}
          {gig?.help?.status === 'open' && (
            <span className="text-sm font-bold text-[#E8726E]">
              You asked for help with {helpLabel(gig).toLowerCase()}
            </span>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="cta"
          disabled={!f.title.trim() || !f.date || !!timeError}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The help request card: reply in the artist's chat, add a to-do, mark done. */
function HelpCard({
  cfg,
  token,
  gig,
  artistName,
  onDone,
}: {
  cfg: AppConfig;
  token: string;
  gig: Gig;
  artistName: string;
  onDone: () => void;
}) {
  const [reply, setReply] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = artistName.split(' ')[0];

  async function sendReply() {
    try {
      const { conversationId } = await api<{ conversationId: string }>(
        cfg,
        token,
        'POST',
        '/conversations',
        { kind: 'direct', artistId: gig.artistId },
      );
      await api(cfg, token, 'POST', `/conversations/${conversationId}/messages`, {
        text: `Re ${gig.title}: ${reply.trim()}`,
      });
      setReply('');
      setNote(`Sent to your chat with ${first}.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function addTodo(topic: HelpTopic) {
    try {
      await api(cfg, token, 'POST', `/artists/${gig.artistId}/todos`, {
        title: `${HELP[topic]} for ${gig.title}`,
        due: gig.date,
      });
      setNote(`Added “${HELP[topic]} for ${gig.title}” to ${first}'s to-dos.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card className="!border-2 !border-[#D9534F]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="eyebrow flex-1">
          Help request · {gig.title}, {longDate(gig.date)}
        </span>
        <span className="src">Sent by {first}</span>
      </div>
      {gig.help?.text && (
        <div className="border-l-[3px] border-[#D9534F] bg-secondary px-3.5 py-2.5">
          “{gig.help.text}” · {first}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      <div className="flex flex-wrap gap-3">
        {(gig.help?.topics ?? []).map((t) => (
          <div
            key={t}
            className="flex flex-[1_1_200px] flex-col gap-2 rounded-lg border border-input p-3"
          >
            <b>{HELP[t]}</b>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => void addTodo(t)}>
                Add to-do
              </Button>
            </div>
          </div>
        ))}
      </div>
      <label className="flex min-h-[50px] items-center gap-2 rounded-lg border border-input py-1 pr-1.5 pl-3.5">
        <span className="sr-only">Reply to {first}</span>
        <input
          className="min-w-0 flex-1 border-0 bg-transparent outline-0"
          value={reply}
          placeholder={`Reply to ${first}…`}
          onChange={(e) => setReply(e.target.value)}
        />
        <Button size="sm" variant="cta" disabled={!reply.trim()} onClick={() => void sendReply()}>
          Reply
        </Button>
      </label>
      <label className="flex min-h-9 items-center gap-3">
        <input className="chk" type="checkbox" onChange={onDone} />
        Mark help as done
      </label>
    </Card>
  );
}

type Filter = 'upcoming' | 'past' | 'help';
const FILTERS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'help', label: 'Help wanted' },
] as const;
const matches = (g: Gig, f: Filter) =>
  f === 'help' ? g.help?.status === 'open' : f === 'past' ? isPast(g) : !isPast(g);

/** Workspace Gigs tab (BMG): stats, all gigs, the open help request and its checklist. */
export function GigsTab({
  cfg,
  token,
  artist,
}: {
  cfg: AppConfig;
  token: string;
  artist: ArtistSummary;
}) {
  const { gigs, error, load, patch } = useGigs(cfg, token, `/artists/${artist.artistId}/gigs`);
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Gig | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const first = artist.displayName.split(' ')[0];
  const all = gigs ?? [];
  const played = all.filter((g) => g.status === 'played').length;
  const upcoming = all.filter((g) => !isPast(g));
  const helping = all.filter((g) => g.help?.status === 'open');
  const byArtist = all.filter((g) => g.plannedBy === 'artist').length;
  const open = all.find((g) => g.gigId === openId) ?? helping[0] ?? upcoming[0] ?? undefined;

  return (
    <div className="flex flex-col gap-5">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-5">
        <Card className="flex-[1_1_200px]">
          <span className="eyebrow">Shows played</span>
          <span className="t text-[34px]">{played}</span>
          <Bar pct={all.length ? (played / all.length) * 100 : 0} color="#D9534F" />
        </Card>
        <Card className="flex-[1_1_200px]">
          <span className="eyebrow">Upcoming</span>
          <span className="t text-[34px]">{upcoming.length}</span>
          <span className="src">
            {helping.length ? `${helping.length} asking for help` : 'No help requests'}
          </span>
        </Card>
        <Card className="flex-[1_1_200px]">
          <span className="eyebrow">Planned by</span>
          <span className="t text-[34px]">
            {first} {byArtist} · BMG {all.length - byArtist}
          </span>
          <span className="src">{first} adds gigs in their app</span>
        </Card>
      </div>

      <Card
        title="All gigs"
        action={
          <>
            <Chips label="Filter gigs" value={filter} onChange={setFilter} options={FILTERS} />
            <Button size="sm" variant="cta" onClick={() => setAdding(true)}>
              Add a gig for {first}
            </Button>
          </>
        }
      >
        {saved && <Notice tone="success">{saved}</Notice>}
        {(adding || editing) && (
          <GigForm
            key={editing?.gigId ?? 'new'}
            cfg={cfg}
            token={token}
            artistId={artist.artistId}
            {...(editing ? { gig: editing } : {})}
            isArtist={false}
            onCancel={() => {
              setAdding(false);
              setEditing(null);
            }}
            onSaved={() => {
              setSaved(editing ? `Saved ${editing.title}. ${first} can see the change.` : null);
              setAdding(false);
              setEditing(null);
              void load();
            }}
          />
        )}
        {gigs === null ? (
          <p className="src">Loading…</p>
        ) : (
          <GigTable
            gigs={all.filter((g) => matches(g, filter))}
            artistName={first}
            selected={open?.gigId}
            onOpen={setOpenId}
            onEdit={(g) => {
              setAdding(false);
              setSaved(null);
              setEditing(g);
            }}
            empty={`No ${filter === 'help' ? 'help requests' : `${filter} gigs`} for ${first} yet.`}
          />
        )}
      </Card>

      {open && (
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex-[3_1_480px]">
            {open.help?.status === 'open' ? (
              <HelpCard
                cfg={cfg}
                token={token}
                gig={open}
                artistName={artist.displayName}
                onDone={() => void patch(open, { helpDone: true })}
              />
            ) : (
              <Card
                title={open.title}
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setAdding(false);
                      setSaved(null);
                      setEditing(open);
                    }}
                  >
                    Edit gig
                  </Button>
                }
              >
                <p className="src">
                  {when(open)}
                  {open.venue ? ` · ${open.venue}` : ''}
                </p>
                {open.deal !== 'tbc' && (
                  <p className="m-0">
                    <b>Deal:</b> {dealLabel(open)}
                  </p>
                )}
                {open.notes && <p>{open.notes}</p>}
                {open.ticketUrl && (
                  <a className="font-bold" href={open.ticketUrl} target="_blank" rel="noreferrer">
                    Ticket link
                  </a>
                )}
              </Card>
            )}
          </div>
          <Card className="flex-[2_1_300px]">
            <span className="eyebrow">
              Gig checklist ({open.plannedBy === 'artist' ? `${first}'s` : 'Blueprint'})
            </span>
            <Checklist gig={open} onPatch={(b) => void patch(open, b)} />
          </Card>
        </div>
      )}
    </div>
  );
}

function GigTable({
  gigs,
  artistName,
  names,
  selected,
  onOpen,
  onEdit,
  empty,
}: {
  gigs: Gig[];
  artistName?: string;
  names?: Record<string, string>;
  selected?: string;
  onOpen: (gigId: string, artistId: string) => void;
  /** BMG desktop: an Edit button on each row. */
  onEdit?: (gig: Gig) => void;
  empty: string;
}) {
  if (gigs.length === 0) return <p className="src">{empty}</p>;
  return (
    <DataTable>
      <thead>
        <tr>
          <th scope="col">Date</th>
          {names && <th scope="col">Artist</th>}
          <th scope="col">Gig</th>
          <th scope="col">Status</th>
          <th scope="col">Deal</th>
          <th scope="col">Checklist</th>
          <th scope="col">Planned by</th>
          <th scope="col">Help</th>
          {onEdit && (
            <th scope="col">
              <span className="sr-only">Edit</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {gigs.map((g) => {
          const [tone, label] = STATUS[g.status];
          const helpOpen = g.help?.status === 'open';
          const who = names?.[g.artistId] ?? artistName ?? 'Artist';
          return (
            <tr
              key={g.gigId}
              className={`cursor-pointer ${helpOpen ? 'bg-[#FFF7F6] dark:bg-[#3a1f1e]' : ''} ${isPast(g) ? 'text-muted-foreground' : ''}`}
              aria-selected={selected === g.gigId}
              onClick={() => onOpen(g.gigId, g.artistId)}
            >
              <td>
                {longDate(g.date)}
                {g.startTime && (
                  <span className="src block">{timeRange(g.startTime, g.endTime)}</span>
                )}
              </td>
              {names && <td>{who}</td>}
              <td>
                <button type="button" className="text-left font-bold">
                  {g.title}
                </button>
                {g.venue && <span className="src block">{g.venue}</span>}
              </td>
              <td>
                <Tag tone={tone}>{label}</Tag>
              </td>
              <td>{dealLabel(g)}</td>
              <td>{done(g)}</td>
              <td>{g.plannedBy === 'bmg' ? 'Blueprint' : who.split(' ')[0]}</td>
              <td>{helpOpen ? <Tag tone="k">{helpLabel(g)}</Tag> : '—'}</td>
              {onEdit && (
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${g.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(g);
                    }}
                  >
                    Edit
                  </Button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

/** BMG "Artist gigs": every shared gig across artists, with help requests first. */
export function AllGigs({
  cfg,
  token,
  artists,
  onOpenArtist,
}: {
  cfg: AppConfig;
  token: string;
  artists: ArtistSummary[];
  onOpenArtist: (artistId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('help');
  const { gigs, error, load } = useGigs(cfg, token, `/gigs?filter=${filter}`);
  const [editing, setEditing] = useState<Gig | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));
  return (
    <Card
      title="Artist gigs"
      action={<Chips label="Filter gigs" value={filter} onChange={setFilter} options={FILTERS} />}
    >
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice tone="success">{saved}</Notice>}
      {editing && (
        <GigForm
          key={editing.gigId}
          cfg={cfg}
          token={token}
          artistId={editing.artistId}
          gig={editing}
          isArtist={false}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setSaved(`Saved ${editing.title}.`);
            setEditing(null);
            void load();
          }}
        />
      )}
      {gigs === null ? (
        <p className="src">Loading…</p>
      ) : (
        <GigTable
          gigs={gigs}
          names={names}
          onOpen={(_, artistId) => onOpenArtist(artistId)}
          onEdit={(g) => {
            setSaved(null);
            setEditing(g);
          }}
          empty={
            filter === 'help'
              ? 'No artist is asking for help right now.'
              : `No ${filter} gigs shared with Blueprint.`
          }
        />
      )}
      <p className="src">Only gigs an artist shares with Blueprint appear here.</p>
    </Card>
  );
}

/** Artist app: My gigs (cards by date) and Plan a gig. */
export function ArtistGigs({
  cfg,
  token,
  artistId,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
}) {
  const { gigs, error, load, patch } = useGigs(cfg, token, `/artists/${artistId}/gigs`);
  const [view, setView] = useState<'upcoming' | 'ideas' | 'past'>('upcoming');
  const [editing, setEditing] = useState<Gig | 'new' | null>(null);
  const all = gigs ?? [];
  const ideas = all.filter((g) => g.status === 'idea' && !isPast(g));
  const upcoming = all.filter((g) => g.status !== 'idea' && !isPast(g));
  const past = all.filter(isPast).reverse();
  const shown = view === 'ideas' ? ideas : view === 'past' ? past : upcoming;

  if (editing) {
    const gig = editing === 'new' ? undefined : editing;
    return (
      <div className="flex flex-col gap-3">
        <h2 className="t text-[22px]">{gig ? gig.title : 'Plan a gig'}</h2>
        <GigForm
          cfg={cfg}
          token={token}
          artistId={artistId}
          gig={gig}
          isArtist
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
        {gig && gig.checklist.length > 0 && (
          <div className="card !gap-0.5 !p-3">
            <b className="text-[15px]">Checklist</b>
            <Checklist
              gig={gig}
              onPatch={(b) =>
                void patch(gig, b).then((ok) =>
                  ok ? setEditing({ ...gig, ...(b as Partial<Gig>) }) : undefined,
                )
              }
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1.5" role="group" aria-label="Show gigs">
          {(
            [
              ['upcoming', `Upcoming · ${upcoming.length}`],
              ['ideas', `Ideas · ${ideas.length}`],
              ['past', 'Past'],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={view === id ? 'navy' : 'ghost'}
              className="flex-1"
              aria-pressed={view === id}
              onClick={() => setView(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <Button variant="cta" onClick={() => setEditing('new')}>
        Plan a gig
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
      {gigs === null && <p className="src">Loading…</p>}
      {gigs !== null && shown.length === 0 && (
        <p className="src">
          {view === 'ideas'
            ? 'No gig ideas yet.'
            : view === 'past'
              ? 'No past gigs yet.'
              : 'Nothing booked yet. Plan your next gig.'}
        </p>
      )}
      {shown.map((g) => (
        <GigCard key={g.gigId} gig={g} onOpen={() => setEditing(g)} />
      ))}
      <p className="src leading-snug">
        Gigs you share with Blueprint show up in your workspace for the team, so they can help with
        booking, promo and budgets.
      </p>
    </div>
  );
}

function GigCard({ gig, onOpen }: { gig: Gig; onOpen: () => void }) {
  const [tone, label] = STATUS[gig.status];
  const d = new Date(`${gig.date}T00:00:00`);
  const helpOpen = gig.help?.status === 'open';
  const idea = gig.status === 'idea';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex items-stretch gap-3 rounded-lg border bg-card p-3 text-left shadow-2xs ${helpOpen ? 'border-[#D9534F]' : idea ? 'border-dashed border-[#5C6775]' : 'border-input'}`}
    >
      <span
        className={`flex w-[54px] flex-none flex-col items-center justify-center rounded ${helpOpen ? 'bg-[#FBE3E2] text-[#8E2F2C]' : gig.plannedBy === 'bmg' ? 'bg-primary text-primary-foreground' : 'bg-[#E6E9ED] text-primary'}`}
      >
        <b className="t text-xl">{d.getDate()}</b>
        <span className="text-[13px] uppercase">
          {d.toLocaleDateString('en-AU', { month: 'short' })}
        </span>
      </span>
      <span className="flex flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <b className="flex-1">{gig.title}</b>
          <Tag tone={tone}>{label}</Tag>
        </span>
        {(gig.startTime || gig.venue) && (
          <span className="src">
            {[
              timeRange(gig.startTime, gig.endTime),
              gig.venue,
              gig.deal !== 'tbc' ? dealLabel(gig) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {helpOpen ? (
          <span className="text-sm font-bold text-[#8E2F2C]">Blueprint is helping</span>
        ) : gig.plannedBy === 'bmg' ? (
          <span className="src">Added by Blueprint</span>
        ) : (
          <span className="src">
            Checklist {gig.checklist.filter((c) => c.done).length} of {gig.checklist.length}
            {!gig.shared && ' · not shared'}
          </span>
        )}
      </span>
    </button>
  );
}
