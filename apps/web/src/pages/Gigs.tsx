import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BackLink, WorkPage, WorkSection } from '../components/patterns.tsx';
import { api, type ArtistSummary } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  Bar,
  Button,
  Card,
  Chips,
  DataTable,
  DateBlock,
  Field,
  Notice,
  RowCard,
  Select,
  Tag,
  TextArea,
  usePhone,
  WaveLoader,
} from '../components/ui.tsx';
import { MoneyEditor, type MoneyFigures } from '../components/Money.tsx';
import { VenuePicker } from './Venues.tsx';
import { GigMedia } from '../components/GigMedia.tsx';

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
  venueId?: string;
  notes?: string;
  status: GigStatus;
  deal: GigDeal;
  dealNote?: string;
  ticketUrl?: string;
  money?: MoneyFigures;
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
    status: gig?.status ?? ('idea' as GigStatus),
    deal: gig?.deal ?? ('tbc' as GigDeal),
    dealNote: gig?.dealNote ?? '',
    ticketUrl: gig?.ticketUrl ?? '',
    notes: gig?.notes ?? '',
    shared: gig?.shared ?? true,
  });
  const [venue, setVenue] = useState<{ venueId: string | null; name: string } | null>(
    gig?.venue ? { venueId: gig.venueId ?? null, name: gig.venue } : null,
  );
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
      ...(gig
        ? { venue: venue?.name ?? '', venueId: venue?.venueId ?? null }
        : venue
          ? { venue: venue.name, ...(venue.venueId ? { venueId: venue.venueId } : {}) }
          : {}),
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
        <VenuePicker cfg={cfg} token={token} isBmg={!isArtist} value={venue} onChange={setVenue} />
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

/**
 * The gig page (rev 13, P3 work page): the work on a gig happens here, on
 * every screen (workspace Gigs, BMG Artist gigs, the artist's My gigs). The
 * help request, checklist, money and photos sit in sections and save as they
 * go; the gig's own fields sit behind Edit details. Gigs aren't deleted (set
 * the status to Cancelled), so there's no danger area.
 */
function GigPage({
  cfg,
  token,
  gig,
  isArtist,
  artistName,
  back,
  more,
  onChanged,
  onPatch,
}: {
  cfg: AppConfig;
  token: string;
  gig: Gig;
  isArtist: boolean;
  artistName: string;
  back: { to: string; onClick: () => void };
  /** Extra header actions (Open the artist's workspace). */
  more?: ReactNode;
  /** After any change: reload the list the gig came from. */
  onChanged: () => Promise<void> | void;
  onPatch: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const first = artistName.split(' ')[0];
  const phone = usePhone();
  useEffect(() => {
    if (phone) window.scrollTo?.({ top: 0 });
  }, [phone, editing]);
  if (editing) {
    return (
      <Card
        title={<h2 className="poster text-[20px] leading-none">Edit gig</h2>}
        action={<BackLink to={gig.title} onClick={() => setEditing(false)} />}
      >
        <GigForm
          cfg={cfg}
          token={token}
          artistId={gig.artistId}
          gig={gig}
          isArtist={isArtist}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setSaved(isArtist ? 'Saved.' : `Saved. ${first} can see the change.`);
            void onChanged();
          }}
        />
      </Card>
    );
  }
  const [tone, label] = STATUS[gig.status];
  const helpOpen = gig.help?.status === 'open';
  return (
    <WorkPage
      kind="Gig"
      title={gig.title}
      lead={<DateBlock date={gig.date} />}
      sub={[
        longDate(gig.date),
        timeRange(gig.startTime, gig.endTime),
        gig.venue,
        gig.deal !== 'tbc' ? dealLabel(gig) : '',
      ]
        .filter(Boolean)
        .join(' · ')}
      badges={
        <>
          <Tag tone={tone}>{label}</Tag>
          {helpOpen && <Tag tone="k">{helpLabel(gig)}</Tag>}
          {isArtist && !gig.shared && <Tag tone="s">Not shared</Tag>}
          {gig.plannedBy === 'bmg' && <Tag tone="n">Added by Blueprint</Tag>}
        </>
      }
      back={back}
      onEdit={() => {
        setSaved(null);
        setEditing(true);
      }}
      more={more}
    >
      {saved && <Notice tone="success">{saved}</Notice>}
      {gig.notes && <p className="m-0 whitespace-pre-line">{gig.notes}</p>}
      {gig.ticketUrl && (
        <a href={gig.ticketUrl} target="_blank" rel="noreferrer" className="w-fit">
          Tickets
        </a>
      )}
      {helpOpen &&
        (isArtist ? (
          <WorkSection title="Help from Blueprint">
            <p className="m-0 text-sm font-bold text-[#8E2F2C]">
              You asked for help with {helpLabel(gig).toLowerCase()}. Blueprint is on it.
            </p>
          </WorkSection>
        ) : (
          <HelpCard
            cfg={cfg}
            token={token}
            gig={gig}
            artistName={artistName}
            onDone={() => void onPatch({ helpDone: true })}
          />
        ))}
      {gig.checklist.length > 0 && (
        <WorkSection
          title={`Checklist · ${done(gig)}`}
          action={
            <span className="src">
              {gig.plannedBy === 'artist' ? (isArtist ? 'Yours' : `${first}'s`) : 'Blueprint'}
            </span>
          }
        >
          <Checklist gig={gig} onPatch={(b) => void onPatch(b)} />
        </WorkSection>
      )}
      <WorkSection title="Tickets, takings and profit">
        <MoneyEditor
          key={gig.gigId}
          value={gig.money}
          onSave={async (money) => {
            await api(cfg, token, 'PATCH', `/artists/${gig.artistId}/gigs/${gig.gigId}`, {
              money,
            });
            await onChanged();
          }}
        />
      </WorkSection>
      <div className="border-t border-input pt-4">
        <GigMedia cfg={cfg} token={token} artistId={gig.artistId} gigId={gig.gigId} />
      </div>
    </WorkPage>
  );
}

/** Adding a gig: the form on its own page, with Back to the list. */
function NewGig({
  title,
  back,
  ...form
}: {
  title: string;
  back: { to: string; onClick: () => void };
} & Parameters<typeof GigForm>[0]) {
  return (
    <Card
      title={<h2 className="poster text-[20px] leading-none">{title}</h2>}
      action={<BackLink to={back.to} onClick={back.onClick} />}
    >
      <GigForm {...form} />
    </Card>
  );
}

/** Workspace Gigs tab (BMG): the stats, the gig list and "Add a gig". A row opens the gig page. */
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
  const [openId, setOpenId] = useState<string | null>(null);
  const first = artist.displayName.split(' ')[0];
  const all = gigs ?? [];
  const played = all.filter((g) => g.status === 'played').length;
  const upcoming = all.filter((g) => !isPast(g));
  const helping = all.filter((g) => g.help?.status === 'open');
  const byArtist = all.filter((g) => g.plannedBy === 'artist').length;
  // Read the gig from the latest list so checklist, money and help changes show at once.
  const open = all.find((g) => g.gigId === openId) ?? null;
  const toList = { to: 'Gigs', onClick: () => setOpenId(null) };

  if (open) {
    return (
      <GigPage
        cfg={cfg}
        token={token}
        gig={open}
        isArtist={false}
        artistName={artist.displayName}
        back={toList}
        onChanged={load}
        onPatch={(b) => patch(open, b)}
      />
    );
  }
  if (adding) {
    return (
      <NewGig
        title={`Add a gig for ${first}`}
        back={{ to: 'Gigs', onClick: () => setAdding(false) }}
        cfg={cfg}
        token={token}
        artistId={artist.artistId}
        isArtist={false}
        onCancel={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          void load();
        }}
      />
    );
  }

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
        {gigs === null ? (
          <WaveLoader />
        ) : (
          <GigTable
            gigs={all.filter((g) => matches(g, filter))}
            artistName={first}
            onOpen={(gigId) => setOpenId(gigId)}
            empty={`No ${filter === 'help' ? 'help requests' : `${filter} gigs`} for ${first} yet.`}
          />
        )}
      </Card>
    </div>
  );
}

function GigTable({
  gigs,
  artistName,
  names,
  selected,
  onOpen,
  empty,
}: {
  gigs: Gig[];
  artistName?: string;
  names?: Record<string, string>;
  selected?: string;
  /** P1 (rev 13): the whole row opens the gig. No buttons on rows. */
  onOpen: (gigId: string, artistId: string) => void;
  empty: string;
}) {
  if (gigs.length === 0) return <p className="src">{empty}</p>;
  return (
    <DataTable
      label="Gigs"
      cards={gigs.map((g) => {
        const [tone, label] = STATUS[g.status];
        const helpOpen = g.help?.status === 'open';
        const who = names?.[g.artistId] ?? artistName ?? 'Artist';
        return (
          <RowCard
            key={g.gigId}
            accent={helpOpen}
            muted={isPast(g)}
            lead={<DateBlock date={g.date} />}
            title={g.title}
            status={<Tag tone={tone}>{label}</Tag>}
            sub={[names ? who : '', g.startTime ? timeRange(g.startTime, g.endTime) : '', g.venue]
              .filter(Boolean)
              .join(' · ')}
            tags={
              <>
                {helpOpen && <Tag tone="k">{helpLabel(g)}</Tag>}
                {g.checklist.length > 0 && <Tag tone="s">Checklist {done(g)}</Tag>}
              </>
            }
            onOpen={() => onOpen(g.gigId, g.artistId)}
          />
        );
      })}
    >
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
  const { gigs, error, load, patch } = useGigs(cfg, token, `/gigs?filter=${filter}`);
  // Keep the last copy: a change (help done) can move the gig out of this filter.
  const [openGig, setOpenGig] = useState<Gig | null>(null);
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));
  const open = openGig ? (gigs?.find((g) => g.gigId === openGig.gigId) ?? openGig) : null;
  if (open) {
    const name = names[open.artistId] ?? 'Artist';
    return (
      <GigPage
        cfg={cfg}
        token={token}
        gig={open}
        isArtist={false}
        artistName={name}
        back={{ to: 'Artist gigs', onClick: () => setOpenGig(null) }}
        more={
          <Button variant="ghost" onClick={() => onOpenArtist(open.artistId)}>
            {name.split(' ')[0]}’s workspace
          </Button>
        }
        onChanged={load}
        onPatch={async (b) => {
          await patch(open, b);
          setOpenGig({ ...open, ...(b as Partial<Gig>) });
        }}
      />
    );
  }
  return (
    <Card
      title="Artist gigs"
      action={<Chips label="Filter gigs" value={filter} onChange={setFilter} options={FILTERS} />}
    >
      {error && <Notice tone="error">{error}</Notice>}
      {gigs === null ? (
        <WaveLoader />
      ) : (
        <GigTable
          gigs={gigs}
          names={names}
          onOpen={(gigId) => setOpenGig(gigs.find((g) => g.gigId === gigId) ?? null)}
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

/** Artist app: My gigs (cards by date), Plan a gig, and each gig's page. */
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
  const [opened, setOpened] = useState<string | 'new' | null>(null);
  const all = gigs ?? [];
  const ideas = all.filter((g) => g.status === 'idea' && !isPast(g));
  const upcoming = all.filter((g) => g.status !== 'idea' && !isPast(g));
  const past = all.filter(isPast).reverse();
  const shown = view === 'ideas' ? ideas : view === 'past' ? past : upcoming;
  const toList = { to: 'My gigs', onClick: () => setOpened(null) };

  if (opened === 'new') {
    return (
      <NewGig
        title="Plan a gig"
        back={toList}
        cfg={cfg}
        token={token}
        artistId={artistId}
        isArtist
        onCancel={() => setOpened(null)}
        onSaved={() => {
          setOpened(null);
          void load();
        }}
      />
    );
  }
  const open = opened ? all.find((g) => g.gigId === opened) : undefined;
  if (open) {
    return (
      <GigPage
        cfg={cfg}
        token={token}
        gig={open}
        isArtist
        artistName="You"
        back={toList}
        onChanged={load}
        onPatch={(b) => patch(open, b)}
      />
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
      <Button variant="cta" onClick={() => setOpened('new')}>
        Plan a gig
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
      {gigs === null && <WaveLoader />}
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
        <GigCard key={g.gigId} gig={g} onOpen={() => setOpened(g.gigId)} />
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
