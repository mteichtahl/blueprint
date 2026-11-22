/**
 * Rev 20: a linked gig's or Blueprint event's ticket analytics from Humanitix
 * (see services/api connectors/humanitix-analytics.ts). The figures come from
 * the API; this file holds the types and the small sums the page draws with.
 */

export interface HxTicketType {
  id: string;
  name: string;
  priceCents: number;
  sold: number;
  quantity: number | null;
  revenueCents: number;
  soldOut: boolean;
  soldOutInDays: number | null;
}

export interface TicketAnalytics {
  eventId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  url: string | null;
  status: 'on-sale' | 'sold-out' | 'paused' | 'finished';
  capacity: number | null;
  sold: number;
  money: {
    ticketSalesCents: number;
    discountsCents: number;
    absorbedFeesCents: number;
    refundsCents: number;
    otherCents: number;
    netCents: number;
    grossCents: number;
    passedOnFeesCents: number;
    taxesCents: number;
    donationsCents: number;
  };
  avgTicketCents: number | null;
  refunds: { tickets: number; orders: number; cents: number };
  checkedIn: number | null;
  arrivals: { at: string; n: number }[];
  daily: { day: string; n: number }[];
  byDaysOut: number[];
  ticketTypes: HxTicketType[];
  heat: number[][];
  leadTime: { sameDay: number; d1to3: number; d4to7: number; w1to2: number; w2plus: number };
  channels: { online: number; manual: number };
  payment: { label: string; tickets: number }[];
  orders: {
    count: number;
    avgCents: number | null;
    sizes: { one: number; two: number; threeFour: number; fivePlus: number };
    biggest: { tickets: number; cents: number } | null;
  };
  codes: {
    code: string;
    orders: number;
    tickets: number;
    discountCents: number;
    revenueCents: number;
  }[];
  autoDiscountCents: number;
  mailingList: { optedIn: number; of: number };
  syncedAt: string;
  daysOut: number | null;
  pace: {
    usual: number[];
    events: number;
    now: number;
    usualNow: number;
    diffPct: number | null;
  } | null;
  repeatFans: { fans: number; of: number } | null;
  highlights: { label: string; text: string }[];
  limited?: boolean;
}

export interface AnalyticsResponse {
  connected: boolean;
  pending?: boolean;
  analytics?: TicketAnalytics;
  canSync?: boolean;
  canShare?: boolean;
  shared?: boolean;
  lastError?: string | null;
}

/** What the page is for: a gig (by artist and gig) or a Blueprint event. */
export type AnalyticsTarget = { artistId: string; gigId: string } | { eventId: string };

export function analyticsPath(t: AnalyticsTarget): string {
  const q =
    'eventId' in t
      ? `eventId=${encodeURIComponent(t.eventId)}`
      : `artistId=${encodeURIComponent(t.artistId)}&gigId=${encodeURIComponent(t.gigId)}`;
  return `/connectors/humanitix/events?analytics=1&${q}`;
}

/** Sync now: the artist's own connector, or Blueprint's. */
export function syncPath(t: AnalyticsTarget, isArtist: boolean): string {
  if ('eventId' in t)
    return `/connectors/humanitix/sync?analytics=1&eventId=${encodeURIComponent(t.eventId)}`;
  const gig = `gigId=${encodeURIComponent(t.gigId)}`;
  return isArtist
    ? `/artists/${encodeURIComponent(t.artistId)}/connectors/humanitix/sync?analytics=1&${gig}`
    : `/connectors/humanitix/sync?analytics=1&artistId=${encodeURIComponent(t.artistId)}&${gig}`;
}

/** Tickets sold with `d` or more days to go. */
export const soldBy = (byDaysOut: readonly number[], d: number) =>
  byDaysOut.slice(Math.max(0, d)).reduce((a, b) => a + b, 0);

/**
 * The sales chart, by days to the show: from the first sale (at least two
 * weeks out) down to the show. `sold` stops at today; `usual` runs to the show.
 */
export function salesCurve(a: Pick<TicketAnalytics, 'byDaysOut' | 'daysOut' | 'status' | 'pace'>) {
  const first = a.byDaysOut.reduce((far, n, d) => (n > 0 ? d : far), 0);
  const from = Math.max(14, first);
  const today = a.status === 'finished' ? 0 : Math.min(a.daysOut ?? 0, from);
  const days: number[] = [];
  for (let d = from; d >= 0; d--) days.push(d);
  return {
    from,
    today,
    days,
    sold: days.filter((d) => d >= today).map((d) => soldBy(a.byDaysOut, d)),
    daily: days.filter((d) => d >= today).map((d) => a.byDaysOut[d] ?? 0),
    usual: a.pace ? days.map((d) => a.pace!.usual[d] ?? 0) : null,
  };
}

/** "$4,092" or "$25.60". */
export const dollars = (cents: number) => {
  const abs = Math.abs(cents);
  const s = `$${(abs / 100).toLocaleString('en-AU', {
    minimumFractionDigits: abs % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
  return cents < 0 ? `−${s}` : s;
};

export const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);

const STATUS_LABEL: Record<TicketAnalytics['status'], string> = {
  'on-sale': 'On sale',
  'sold-out': 'Sold out',
  paused: 'Sales paused',
  finished: 'Finished',
};
export const statusLabel = (s: TicketAnalytics['status']) => STATUS_LABEL[s];

/** The breakdowns as a CSV (figures only, like the page). */
export function analyticsCsv(a: TicketAnalytics): string {
  const rows: (string | number)[][] = [['Section', 'Item', 'Value']];
  const add = (section: string, item: string, value: string | number) =>
    rows.push([section, item, value]);
  const $ = (c: number) => (c / 100).toFixed(2);
  add('Summary', 'Event', a.name);
  add('Summary', 'Status', statusLabel(a.status));
  add('Summary', 'Tickets sold', a.sold);
  if (a.capacity !== null) add('Summary', 'Capacity', a.capacity);
  add('Summary', 'Net to you ($)', $(a.money.netCents));
  add('Summary', 'Gross sales ($)', $(a.money.grossCents));
  if (a.avgTicketCents !== null) add('Summary', 'Average ticket ($)', $(a.avgTicketCents));
  add('Summary', 'Refunds ($)', $(a.refunds.cents));
  if (a.checkedIn !== null) add('Summary', 'Checked in', a.checkedIn);
  add('Money', 'Ticket sales ($)', $(a.money.ticketSalesCents));
  add('Money', 'Discounts ($)', $(-a.money.discountsCents));
  add('Money', 'Humanitix fees absorbed ($)', $(-a.money.absorbedFeesCents));
  add('Money', 'Refunds ($)', $(-a.money.refundsCents));
  if (a.money.otherCents) add('Money', 'Other adjustments ($)', $(a.money.otherCents));
  add('Money', 'Net to you ($)', $(a.money.netCents));
  add('Money', 'Booking fees paid by buyers ($)', $(a.money.passedOnFeesCents));
  for (const t of a.ticketTypes) {
    add(
      'Ticket types',
      `${t.name} sold`,
      t.quantity === null ? t.sold : `${t.sold} / ${t.quantity}`,
    );
    add('Ticket types', `${t.name} revenue ($)`, $(t.revenueCents));
  }
  for (const d of a.daily) add('Sales by day', d.day, d.n);
  for (const p of a.payment) add('Payment', p.label, p.tickets);
  add('Channel', 'Online', a.channels.online);
  add('Channel', 'At the door', a.channels.manual);
  for (const c of a.codes)
    add('Discount codes', c.code, `${c.tickets} tickets, $${$(c.revenueCents)}`);
  add('Orders', 'Orders', a.orders.count);
  if (a.orders.avgCents !== null) add('Orders', 'Average order ($)', $(a.orders.avgCents));
  for (const x of a.arrivals) add('Arrivals', x.at, x.n);
  const esc = (v: string | number) => {
    const s = String(v);
    // Leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
