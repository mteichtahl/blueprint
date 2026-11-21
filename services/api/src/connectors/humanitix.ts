import type { Gig } from '../events/model.ts';
import type { ConnectionView, Snapshot } from './catalog.ts';
import type { HumanitixEvent } from './vendors.ts';

/**
 * Rev 18, an artist's Humanitix data in My stats (and the workspace Stats tab).
 * Pure, so the rules are unit-tested. The sync (sync.ts) keeps the artist's
 * Humanitix event list and a ticket count on each linked gig; this turns them
 * into what the screen shows:
 *
 * - tickets sold across upcoming linked gigs, with a line over the range;
 * - each linked gig with its count;
 * - for the artist only: their Humanitix events, which gig each is linked to,
 *   a suggested gig on the same day, and the gigs that could be linked.
 *
 * Blueprint sees only gigs the artist shares with them, and never the
 * artist's event list.
 */

export interface HumanitixGigLink {
  gigId: string;
  title: string;
  date: string;
  venue: string | null;
  humanitixEventId: string;
  eventName: string | null;
  ticketsSold: number | null;
  syncedAt: string | null;
}

export interface HumanitixEventRow {
  id: string;
  name: string;
  startDate: string | null;
  gigId: string | null;
  gigTitle: string | null;
  /** An unlinked gig on the same day, offered first. */
  suggestedGigId: string | null;
}

export interface HumanitixView {
  connected: boolean;
  status: ConnectionView['status'] | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Tickets sold across upcoming linked gigs, from the latest sync. */
  ticketsSold: number;
  series: number[];
  gigs: HumanitixGigLink[];
  /** Artist only. */
  events?: HumanitixEventRow[];
  /** Artist only: gigs that could be linked (not cancelled, not linked, from a month ago). */
  linkable?: { gigId: string; title: string; date: string }[];
}

/** The gig's Humanitix event: picked in the app, or found in its ticket link. */
export type HumanitixIdOf = (g: Pick<Gig, 'humanitixEventId' | 'ticketUrl'>) => string | undefined;

/** YYYY-MM-DD in Melbourne, for matching a Humanitix start time to a gig date. */
export function melbourneDay(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
}

function shift(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Tickets sold each day over the range, carrying the last count over days without a sync. */
export function ticketSeries(snaps: readonly Snapshot[], today: string, range: number): number[] {
  const byDay = new Map<string, number>();
  for (const s of snaps)
    if (s.source === 'humanitix' && typeof s.ticketsSold === 'number')
      byDay.set(s.date, s.ticketsSold);
  const out: number[] = [];
  let last = 0;
  const before = [...byDay.keys()].filter((d) => d < shift(today, -range)).sort();
  if (before.length) last = byDay.get(before.at(-1)!)!;
  for (let i = range; i >= 0; i--) {
    const day = shift(today, -i);
    if (byDay.has(day)) last = byDay.get(day)!;
    out.push(last);
  }
  return out;
}

export function humanitixView(input: {
  connection: Pick<ConnectionView, 'status' | 'lastSyncAt' | 'lastError'> | undefined;
  events: readonly HumanitixEvent[];
  gigs: readonly Gig[];
  snaps: readonly Snapshot[];
  today: string;
  range: number;
  /** The artist themselves (sees their event list and every gig). */
  isArtist: boolean;
  idOf: HumanitixIdOf;
  afterDays: number;
}): HumanitixView {
  const { connection, today, isArtist } = input;
  const connected = !!connection;
  const gigs = input.gigs.filter((g) => isArtist || g.shared);
  const eventName = new Map(input.events.map((e) => [e.id, e.name]));
  const linked = gigs
    .map((g) => ({ g, id: input.idOf(g) }))
    .filter((x): x is { g: Gig; id: string } => !!x.id)
    .sort((a, b) => b.g.date.localeCompare(a.g.date));
  const series = ticketSeries(input.snaps, today, input.range);
  const view: HumanitixView = {
    connected,
    status: connection?.status ?? null,
    lastSyncAt: connection?.lastSyncAt ?? null,
    lastError: connection?.lastError ?? null,
    ticketsSold: series.at(-1) ?? 0,
    series,
    gigs: linked.map(({ g, id }) => ({
      gigId: g.gigId,
      title: g.title,
      date: g.date,
      venue: g.venue ?? null,
      humanitixEventId: id,
      eventName: eventName.get(id) ?? null,
      ticketsSold: g.humanitix?.ticketsSold ?? null,
      syncedAt: g.humanitix?.syncedAt ?? null,
    })),
  };
  if (!isArtist) return view;

  const gigFor = new Map(linked.map(({ g, id }) => [id, g]));
  const from = shift(today, -input.afterDays);
  const linkable = gigs
    .filter((g) => !input.idOf(g) && g.status !== 'cancelled' && g.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date));
  view.linkable = linkable.map((g) => ({ gigId: g.gigId, title: g.title, date: g.date }));
  view.events = input.events
    .map((e) => {
      const gig = gigFor.get(e.id);
      const day = melbourneDay(e.startDate);
      const suggested = !gig && day ? linkable.find((g) => g.date === day) : undefined;
      return {
        id: e.id,
        name: e.name,
        startDate: e.startDate ?? null,
        gigId: gig?.gigId ?? null,
        gigTitle: gig?.title ?? null,
        suggestedGigId: suggested?.gigId ?? null,
      };
    })
    // Not linked first, then by date (newest first).
    .sort(
      (a, b) =>
        Number(!!a.gigId) - Number(!!b.gigId) ||
        (b.startDate ?? '').localeCompare(a.startDate ?? ''),
    );
  return view;
}
