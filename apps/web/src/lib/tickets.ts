/**
 * Studio HQ "Tickets" card: ticket sales for Blueprint's events and
 * workshops, and for the gigs artists share with Blueprint, in one list.
 * Pure, so the rules are unit-tested (test/tickets.test.ts).
 *
 * - Events and workshops count against their ticket target (else capacity).
 * - Gigs count against the venue's capacity when the venue came from the
 *   venues list. Only ticketed gigs show: deal Ticketed, Door split or Other,
 *   a ticket link, or tickets already entered. Free, fee and not-set gigs
 *   with no tickets are left out, as are idea and cancelled gigs.
 * - "Behind": within 14 days, a target set and under half of it sold.
 */

export type TicketKind = 'event' | 'workshop' | 'gig';
export type TicketFilter = 'all' | 'events' | 'gigs';

export interface TicketEvent {
  eventId: string;
  name: string;
  date: string;
  /** Older events have no kind: they're events. */
  kind?: 'event' | 'workshop';
  venue?: string;
  capacity: number;
  ticketTarget: number;
  ticketsSold: number;
  ticketPriceCents: number;
  takingsCents: number;
  humanitixEventId?: string;
}

export interface TicketGig {
  gigId: string;
  artistId: string;
  title: string;
  date: string;
  venue?: string;
  venueId?: string;
  status: string;
  deal: string;
  ticketUrl?: string;
  money?: { ticketsSold: number; takingsCents: number };
}

export interface TicketRow {
  id: string;
  kind: TicketKind;
  title: string;
  /** The artist for a gig; the venue for an event. */
  who: string;
  date: string;
  sold: number;
  /** What `sold` is measured against (0 when nothing is set). */
  of: number;
  ofLabel: 'target' | 'capacity' | '';
  takingsCents: number;
  /** Where the count comes from: Humanitix (synced hourly) or typed in. */
  source: 'humanitix' | 'typed';
  behind: boolean;
  daysAway: number;
  /** For opening the row: the event, or the gig (with its artist). */
  eventId?: string;
  gigId?: string;
  artistId?: string;
}

export interface TicketTotals {
  sold: number;
  takingsCents: number;
  /** Rows with a target or capacity, and how many of those are behind. */
  behind: number;
  count: number;
}

const TICKETED_DEALS = new Set(['ticketed', 'door-split', 'other']);
const SKIP_STATUSES = new Set(['idea', 'cancelled']);

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const isHumanitix = (url?: string) => {
  if (!url) return false;
  try {
    return /(^|\.)humanitix\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

export function isTicketedGig(g: TicketGig): boolean {
  if (SKIP_STATUSES.has(g.status)) return false;
  return TICKETED_DEALS.has(g.deal) || !!g.ticketUrl || (g.money?.ticketsSold ?? 0) > 0;
}

function behindOn(sold: number, of: number, daysAway: number) {
  return of > 0 && daysAway >= 0 && daysAway <= 14 && sold < of / 2;
}

/** Upcoming rows (today onwards), soonest first. */
export function ticketRows({
  events,
  gigs,
  artistNames,
  venueCapacity,
  today,
}: {
  events: TicketEvent[];
  gigs: TicketGig[];
  artistNames: Record<string, string>;
  /** Capacity by venueId, from the venues list. */
  venueCapacity: Record<string, number>;
  today: string;
}): TicketRow[] {
  const rows: TicketRow[] = [];
  for (const e of events) {
    if (e.date < today) continue;
    const daysAway = daysBetween(today, e.date);
    const of = e.ticketTarget || e.capacity;
    rows.push({
      id: `event:${e.eventId}`,
      kind: e.kind === 'workshop' ? 'workshop' : 'event',
      title: e.name,
      who: e.venue || 'Venue not set',
      date: e.date,
      sold: e.ticketsSold,
      of,
      ofLabel: e.ticketTarget ? 'target' : e.capacity ? 'capacity' : '',
      // Takings typed in win; else what the tickets sold at the set price come to.
      takingsCents: e.takingsCents || e.ticketsSold * e.ticketPriceCents,
      source: e.humanitixEventId ? 'humanitix' : 'typed',
      behind: behindOn(e.ticketsSold, of, daysAway),
      daysAway,
      eventId: e.eventId,
    });
  }
  for (const g of gigs) {
    if (g.date < today || !isTicketedGig(g)) continue;
    const daysAway = daysBetween(today, g.date);
    const sold = g.money?.ticketsSold ?? 0;
    const of = (g.venueId && venueCapacity[g.venueId]) || 0;
    rows.push({
      id: `gig:${g.gigId}`,
      kind: 'gig',
      title: g.title,
      who: artistNames[g.artistId] ?? 'Artist',
      date: g.date,
      sold,
      of,
      ofLabel: of ? 'capacity' : '',
      takingsCents: g.money?.takingsCents ?? 0,
      source: isHumanitix(g.ticketUrl) ? 'humanitix' : 'typed',
      behind: behindOn(sold, of, daysAway),
      daysAway,
      gigId: g.gigId,
      artistId: g.artistId,
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

export function filterRows(rows: TicketRow[], f: TicketFilter): TicketRow[] {
  if (f === 'events') return rows.filter((r) => r.kind !== 'gig');
  if (f === 'gigs') return rows.filter((r) => r.kind === 'gig');
  return rows;
}

export function ticketTotals(rows: TicketRow[]): TicketTotals {
  return {
    sold: rows.reduce((n, r) => n + r.sold, 0),
    takingsCents: rows.reduce((n, r) => n + r.takingsCents, 0),
    behind: rows.filter((r) => r.behind).length,
    count: rows.length,
  };
}

/** "Today", "Tomorrow", "In 5 days", else the date ("Sat 12 Dec"). */
export function whenLabel(r: Pick<TicketRow, 'date' | 'daysAway'>): string {
  if (r.daysAway === 0) return 'Today';
  if (r.daysAway === 1) return 'Tomorrow';
  if (r.daysAway <= 14) return `In ${r.daysAway} days`;
  return new Date(`${r.date}T00:00:00`).toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export const KIND_LABEL: Record<TicketKind, string> = {
  event: 'Event',
  workshop: 'Workshop',
  gig: 'Gig',
};
