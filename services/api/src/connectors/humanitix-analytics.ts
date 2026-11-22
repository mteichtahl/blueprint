import { createHash } from 'node:crypto';

/**
 * Rev 20: ticket analytics for a Humanitix event linked to a gig or a
 * Blueprint event. Pure, so the rules are unit-tested.
 *
 * The sync pulls the event, its orders and its tickets, and `summarise` turns
 * them into one stats record. Only figures are kept: no names, emails, phones,
 * addresses or answers to questions. Buyers become a one-way hash, scoped to
 * the account, so "repeat fans" can be counted without storing who they are.
 *
 * `analyticsView` adds what needs the account's other events (pace against
 * the usual, repeat fans) and the plain-language highlights.
 */

// ── What Humanitix sends (only the fields used) ────────────────────────────
type Raw = Record<string, unknown>;

const DAY = 86_400_000;
const TZ = 'Australia/Melbourne';
/** Days before the show the pace curve covers; older sales land in the last bucket. */
export const PACE_DAYS = 120;
/** Buyer hashes kept per event, for repeat fans. */
const MAX_FANS = 4000;

export interface TicketTypeStat {
  id: string;
  name: string;
  priceCents: number;
  sold: number;
  /** null: no limit set. */
  quantity: number | null;
  revenueCents: number;
  soldOut: boolean;
  /** Days from its first sale to its last, when it sold out. */
  soldOutInDays: number | null;
}

export interface Money {
  /** Ticket face value of every ticket sold (refunded ones too). */
  ticketSalesCents: number;
  discountsCents: number;
  /** Humanitix fees the host absorbed. */
  absorbedFeesCents: number;
  refundsCents: number;
  /** Whatever else Humanitix took off (or added), so the waterfall adds up. */
  otherCents: number;
  /** Humanitix's own net figure: what the host keeps. */
  netCents: number;
  /** What buyers paid. */
  grossCents: number;
  /** Booking fees buyers paid on top (not the host's money). */
  passedOnFeesCents: number;
  taxesCents: number;
  donationsCents: number;
}

export interface HxStats {
  type: 'humanitix-stats';
  eventId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  url: string | null;
  status: 'on-sale' | 'sold-out' | 'paused' | 'finished';
  capacity: number | null;
  sold: number;
  money: Money;
  avgTicketCents: number | null;
  refunds: { tickets: number; orders: number; cents: number };
  /** null until someone is checked in. */
  checkedIn: number | null;
  /** Arrivals per 15 minutes (Melbourne "HH:MM"), from check-in times. */
  arrivals: { at: string; n: number }[];
  /** Tickets sold each Melbourne day. */
  daily: { day: string; n: number }[];
  /** Tickets by days before the show: index = days out (last = PACE_DAYS or more). */
  byDaysOut: number[];
  ticketTypes: TicketTypeStat[];
  /** Mon..Sun × [morning, afternoon, 5–8 pm, late], Melbourne time. */
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
  /** Hashed buyers. Kept on the server: never sent to the browser. */
  fans: string[];
  syncedAt: string;
}

// ── Small helpers ──────────────────────────────────────────────────────────
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const cents = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function parts(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')),
    ms: d.getTime(),
  };
}

/** A buyer, as a hash that only matches within this account. */
export function fanHash(account: string, email: string): string {
  return createHash('sha256')
    .update(`bmg-hx-fan:${account}:${email.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 20);
}

/** Card gateways, buy-now-pay-later, and the rest, in words people use. */
export function paymentLabel(order: Raw): string {
  const gw = (str(order.paymentGateway) ?? '').toLowerCase();
  const type = (str(order.paymentType) ?? '').toLowerCase();
  if (
    str(order.financialStatus) === 'free' ||
    type === 'complimentary' ||
    type === 'nopaymentnecessary'
  )
    return 'Free or comp';
  if (gw === 'afterpay') return 'Afterpay';
  if (gw === 'zipmoney') return 'Zip';
  if (gw === 'paypal' || type === 'paypal') return 'PayPal';
  if (gw === 'cash' || type === 'cash') return 'Cash';
  if (type === 'eftpos' || gw === 'till' || gw === 'tillterminal') return 'Card at the door';
  if (['stripe', 'stripe-payments', 'bpoint', 'pin', 'braintree', 'worldpay'].includes(gw))
    return 'Card';
  if (['gift-card', 'credit', 'discover-nsw'].includes(gw) || type === 'voucher')
    return 'Gift card or credit';
  if (gw === 'invoice' || type === 'bankdeposit') return 'Invoice or bank';
  return 'Other';
}

const heatSlot = (hour: number) => (hour >= 5 && hour < 12 ? 0 : hour < 17 ? 1 : hour < 20 ? 2 : 3);

// ── The summary the sync stores ────────────────────────────────────────────
export function summarise(input: {
  account: string;
  eventId: string;
  event: Raw;
  orders: readonly Raw[];
  tickets: readonly Raw[];
  now: Date;
}): HxStats {
  const { event, account, now } = input;
  const startDate = str(event.startDate) ?? null;
  const endDate = str(event.endDate) ?? null;
  const start = startDate ? new Date(startDate).getTime() : NaN;
  const orders = input.orders.filter((o) => str(o.status) !== 'incomplete' && !o.incompleteAt);
  const orderById = new Map(orders.map((o) => [String(o._id ?? ''), o]));
  const all = input.tickets.filter((t) => !t.isDonation);
  const sold = all.filter((t) => str(t.status) !== 'cancelled');
  const cancelled = all.filter((t) => str(t.status) === 'cancelled');

  // Money: Humanitix's own order totals, with ticket-level fees.
  const totals = orders.map((o) => obj(o.totals));
  const ticketSalesCents = sum(all.map((t) => cents(t.price)));
  const discountsCents = sum(totals.map((t) => cents(t.discounts)));
  const absorbedFeesCents = sum(sold.map((t) => cents(t.absorbedFee)));
  const refundsCents = sum(totals.map((t) => cents(t.refunds)));
  const haveNet = totals.some((t) => t.netSales !== undefined);
  const computedNet = ticketSalesCents - discountsCents - absorbedFeesCents - refundsCents;
  const netCents = haveNet ? sum(totals.map((t) => cents(t.netSales))) : computedNet;
  const money: Money = {
    ticketSalesCents,
    discountsCents,
    absorbedFeesCents,
    refundsCents,
    otherCents: netCents - computedNet,
    netCents,
    grossCents: sum(totals.map((t) => cents(t.grossSales))),
    passedOnFeesCents: sum(sold.map((t) => cents(t.passedOnFee))),
    taxesCents: sum(totals.map((t) => cents(t.totalTaxes ?? t.taxes))),
    donationsCents: sum(totals.map((t) => cents(t.donation) + cents(t.clientDonation))),
  };
  const paidSold = sold.filter((t) => cents(t.price) > 0);

  // Ticket types: what Humanitix lists, plus any only seen on tickets.
  const types = new Map<string, TicketTypeStat & { first?: number; last?: number }>();
  for (const tt of Array.isArray(event.ticketTypes) ? (event.ticketTypes as Raw[]) : []) {
    if (tt.deleted || tt.isDonation) continue;
    const id = String(tt._id ?? tt.name ?? '');
    if (!id) continue;
    const q = typeof tt.quantity === 'number' && tt.quantity > 0 ? tt.quantity : null;
    types.set(id, {
      id,
      name: String(tt.name ?? 'Tickets').slice(0, 80),
      priceCents: cents(tt.price),
      sold: 0,
      quantity: q,
      revenueCents: 0,
      soldOut: false,
      soldOutInDays: null,
    });
  }
  for (const t of sold) {
    const id = String(t.ticketTypeId ?? t.ticketTypeName ?? 'other');
    const row = types.get(id) ?? {
      id,
      name: String(t.ticketTypeName ?? 'Tickets').slice(0, 80),
      priceCents: cents(t.price),
      sold: 0,
      quantity: null,
      revenueCents: 0,
      soldOut: false,
      soldOutInDays: null,
    };
    row.sold++;
    row.revenueCents += cents(t.price) - cents(t.discount);
    const at = new Date(str(t.createdAt) ?? '').getTime();
    if (Number.isFinite(at)) {
      row.first = Math.min(row.first ?? at, at);
      row.last = Math.max(row.last ?? at, at);
    }
    types.set(id, row);
  }
  const ticketTypes = [...types.values()].map(({ first, last, ...r }) => {
    const soldOut = r.quantity !== null && r.sold >= r.quantity;
    return {
      ...r,
      soldOut,
      soldOutInDays:
        soldOut && first !== undefined && last !== undefined
          ? Math.max(1, Math.ceil((last - first) / DAY))
          : null,
    };
  });
  const listedCapacity = typeof event.totalCapacity === 'number' ? event.totalCapacity : 0;
  const typeCapacity = ticketTypes.every((t) => t.quantity !== null)
    ? sum(ticketTypes.map((t) => t.quantity ?? 0))
    : 0;
  const capacity = listedCapacity > 0 ? listedCapacity : typeCapacity > 0 ? typeCapacity : null;

  // When tickets were bought: per day, by days out, by weekday and hour.
  const daily = new Map<string, number>();
  const byDaysOut = new Array<number>(PACE_DAYS + 1).fill(0);
  const heat = Array.from({ length: 7 }, () => [0, 0, 0, 0]);
  const leadTime = { sameDay: 0, d1to3: 0, d4to7: 0, w1to2: 0, w2plus: 0 };
  const startDay = startDate ? parts(startDate)?.day : undefined;
  for (const t of sold) {
    const p = parts(str(t.createdAt) ?? '');
    if (!p) continue;
    daily.set(p.day, (daily.get(p.day) ?? 0) + 1);
    if (p.weekday >= 0) heat[p.weekday]![heatSlot(p.hour)]!++;
    if (!Number.isFinite(start)) continue;
    const out = Math.max(0, Math.floor((start - p.ms) / DAY));
    byDaysOut[Math.min(out, PACE_DAYS)]!++;
    if (p.day === startDay) leadTime.sameDay++;
    else if (out <= 3) leadTime.d1to3++;
    else if (out <= 7) leadTime.d4to7++;
    else if (out <= 14) leadTime.w1to2++;
    else leadTime.w2plus++;
  }

  // Check-ins: how many came, and when.
  const checked = sold.filter((t) => obj(t.checkIn).checkedIn === true);
  const arrivals = new Map<string, number>();
  for (const t of checked) {
    const p = parts(str(obj(t.checkIn).date) ?? '');
    if (!p) continue;
    const at = `${String(p.hour).padStart(2, '0')}:${String(Math.floor(p.minute / 15) * 15).padStart(2, '0')}`;
    arrivals.set(at, (arrivals.get(at) ?? 0) + 1);
  }

  // Orders: size, value, channel, payment, codes, mailing list, fans.
  const perOrder = new Map<string, Raw[]>();
  for (const t of sold) {
    const id = String(t.orderId ?? '');
    perOrder.set(id, [...(perOrder.get(id) ?? []), t]);
  }
  const sizes = { one: 0, two: 0, threeFour: 0, fivePlus: 0 };
  let biggest: { tickets: number; cents: number } | null = null;
  const payment = new Map<string, number>();
  const channels = { online: 0, manual: 0 };
  const codes = new Map<string, HxStats['codes'][number]>();
  let autoDiscountCents = 0;
  const mailingList = { optedIn: 0, of: 0 };
  const fans = new Set<string>();
  const counted: Raw[] = [];
  for (const [orderId, ts] of perOrder) {
    const o = orderById.get(orderId) ?? {};
    counted.push(o);
    const n = ts.length;
    if (n === 1) sizes.one++;
    else if (n === 2) sizes.two++;
    else if (n <= 4) sizes.threeFour++;
    else sizes.fivePlus++;
    const value = sum(ts.map((t) => cents(t.price) - cents(t.discount)));
    if (!biggest || n > biggest.tickets || (n === biggest.tickets && value > biggest.cents))
      biggest = { tickets: n, cents: value };
    const label = paymentLabel(o);
    payment.set(label, (payment.get(label) ?? 0) + n);
    const manual = str(o.salesChannel) === 'manual' || o.manualOrder === true;
    channels[manual ? 'manual' : 'online'] += n;
    const d = obj(o.discounts);
    const code = str(obj(d.discountCode).code)?.toUpperCase().slice(0, 40);
    if (code) {
      const row = codes.get(code) ?? {
        code,
        orders: 0,
        tickets: 0,
        discountCents: 0,
        revenueCents: 0,
      };
      row.orders++;
      row.tickets += n;
      row.discountCents += cents(obj(d.discountCode).discountAmount);
      row.revenueCents += value;
      codes.set(code, row);
    }
    autoDiscountCents += cents(obj(d.autoDiscount).discountAmount);
    if (orderById.has(orderId)) {
      mailingList.of++;
      if (o.organiserMailListOptIn === true) mailingList.optedIn++;
    }
    const email = str(o.email);
    if (email && fans.size < MAX_FANS) fans.add(fanHash(account, email));
  }
  const orderCount = perOrder.size;
  const refundedOrders = orders.filter((o) =>
    ['refunded', 'partiallyRefunded'].includes(str(o.financialStatus) ?? ''),
  ).length;

  const end = endDate ? new Date(endDate).getTime() : start;
  const status: HxStats['status'] =
    Number.isFinite(end) && end < now.getTime()
      ? 'finished'
      : event.markedAsSoldOut === true || (capacity !== null && sold.length >= capacity)
        ? 'sold-out'
        : event.suspendSales === true
          ? 'paused'
          : 'on-sale';

  return {
    type: 'humanitix-stats',
    eventId: input.eventId,
    name: String(event.name ?? 'Event').slice(0, 200),
    startDate,
    endDate,
    url:
      str(event.url) && /^https:\/\/([a-z0-9-]+\.)*humanitix\.com\//i.test(str(event.url)!)
        ? str(event.url)!
        : null,
    status,
    capacity,
    sold: sold.length,
    money,
    avgTicketCents: paidSold.length
      ? Math.round(sum(paidSold.map((t) => cents(t.price) - cents(t.discount))) / paidSold.length)
      : null,
    refunds: { tickets: cancelled.length, orders: refundedOrders, cents: refundsCents },
    checkedIn: checked.length ? checked.length : null,
    arrivals: [...arrivals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([at, n]) => ({ at, n })),
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, n]) => ({ day, n })),
    byDaysOut,
    ticketTypes,
    heat,
    leadTime,
    channels,
    payment: [...payment.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, tickets]) => ({ label, tickets })),
    orders: {
      count: orderCount,
      avgCents: orderCount
        ? Math.round(sum(sold.map((t) => cents(t.price) - cents(t.discount))) / orderCount)
        : null,
      sizes,
      biggest,
    },
    codes: [...codes.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    autoDiscountCents,
    mailingList,
    fans: [...fans],
    syncedAt: now.toISOString(),
  };
}

// ── What the page gets ─────────────────────────────────────────────────────
/** Tickets sold with `d` or more days to go. */
export function soldBy(byDaysOut: readonly number[], d: number): number {
  return sum(byDaysOut.slice(Math.max(0, d)));
}

export interface AnalyticsView extends Omit<HxStats, 'fans' | 'type'> {
  daysOut: number | null;
  pace: {
    /** The average of the account's earlier events, tickets sold by days out (index = days out). */
    usual: number[];
    events: number;
    /** Sold at this many days out, now and usually. */
    now: number;
    usualNow: number;
    /** Percent ahead (+) or behind (−) the usual, at this point. */
    diffPct: number | null;
  } | null;
  repeatFans: { fans: number; of: number } | null;
  highlights: { label: string; text: string }[];
  /** Limited: Blueprint sees counts only (the artist turned sharing off). */
  limited?: boolean;
}

const money0 = (c: number) =>
  `$${(c / 100).toLocaleString('en-AU', { maximumFractionDigits: c % 100 ? 2 : 0, minimumFractionDigits: c % 100 ? 2 : 0 })}`;

export function analyticsView(
  stats: HxStats,
  others: readonly HxStats[],
  now: Date,
): AnalyticsView {
  const { fans, type: _type, ...rest } = stats;
  void _type;
  const start = stats.startDate ? new Date(stats.startDate).getTime() : NaN;
  const daysOut = Number.isFinite(start)
    ? Math.max(0, Math.floor((start - now.getTime()) / DAY))
    : null;

  // Pace: earlier events of the account, lined up by days to the show.
  const earlier = others.filter(
    (o) =>
      o.eventId !== stats.eventId &&
      o.startDate &&
      stats.startDate &&
      o.startDate < stats.startDate &&
      o.sold > 0,
  );
  let pace: AnalyticsView['pace'] = null;
  if (earlier.length && daysOut !== null) {
    const usual = Array.from({ length: PACE_DAYS + 1 }, (_, d) =>
      Math.round(sum(earlier.map((o) => soldBy(o.byDaysOut, d))) / earlier.length),
    );
    const at = Math.min(daysOut, PACE_DAYS);
    const nowSold = stats.sold;
    const usualNow = stats.status === 'finished' ? usual[0]! : usual[at]!;
    pace = {
      usual,
      events: earlier.length,
      now: nowSold,
      usualNow,
      diffPct: usualNow > 0 ? Math.round(((nowSold - usualNow) / usualNow) * 100) : null,
    };
  }

  // Repeat fans: this event's buyers seen at an earlier event of the account.
  let repeatFans: AnalyticsView['repeatFans'] = null;
  if (earlier.length && fans.length) {
    const seen = new Set(earlier.flatMap((o) => o.fans));
    repeatFans = { fans: fans.filter((f) => seen.has(f)).length, of: fans.length };
  }

  const highlights: AnalyticsView['highlights'] = [];
  if (pace?.diffPct != null && pace.diffPct !== 0) {
    const when = stats.status === 'finished' ? 'overall' : `${daysOut} days out`;
    highlights.push({
      label: 'Pace',
      text: `${Math.abs(pace.diffPct)}% ${pace.diffPct > 0 ? 'ahead of' : 'behind'} your usual pace, ${when}`,
    });
  }
  const best = [...stats.daily].sort((a, b) => b.n - a.n || a.day.localeCompare(b.day))[0];
  if (best && best.n > 1) {
    const d = new Date(`${best.day}T12:00:00Z`).toLocaleDateString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });
    highlights.push({ label: 'Best day', text: `${d.replace(',', '')}: ${best.n} tickets` });
  }
  const fastest = stats.ticketTypes
    .filter((t) => t.soldOutInDays !== null)
    .sort((a, b) => a.soldOutInDays! - b.soldOutInDays!)[0];
  if (fastest)
    highlights.push({
      label: fastest.name,
      text: `Sold out in ${fastest.soldOutInDays} day${fastest.soldOutInDays === 1 ? '' : 's'}`,
    });
  const code = stats.codes[0];
  if (code)
    highlights.push({
      label: 'Best code',
      text: `${code.code} brought in ${money0(code.revenueCents)}`,
    });
  const door = [...stats.arrivals].sort((a, b) => b.n - a.n)[0];
  if (door && stats.status === 'finished')
    highlights.push({ label: 'Busiest door', text: `${door.at}: ${door.n} in` });
  if (stats.status === 'finished' && stats.leadTime.sameDay)
    highlights.push({
      label: 'On the day',
      text: `${stats.leadTime.sameDay} tickets sold on the day`,
    });
  if (repeatFans && repeatFans.of && repeatFans.fans)
    highlights.push({
      label: 'Repeat fans',
      text: `${Math.round((repeatFans.fans / repeatFans.of) * 100)}% of buyers came before`,
    });
  if (!highlights.length && stats.sold === 0)
    highlights.push({ label: 'Getting started', text: 'No tickets sold yet' });

  return { ...rest, daysOut, pace, repeatFans, highlights: highlights.slice(0, 4) };
}

/** Blueprint, when the artist keeps their analytics to themselves: counts and takings only. */
export function limitedView(v: AnalyticsView): AnalyticsView {
  return {
    ...v,
    money: {
      ...v.money,
      ticketSalesCents: 0,
      discountsCents: 0,
      absorbedFeesCents: 0,
      refundsCents: 0,
      otherCents: 0,
      grossCents: 0,
      passedOnFeesCents: 0,
      taxesCents: 0,
      donationsCents: 0,
    },
    avgTicketCents: null,
    refunds: { tickets: 0, orders: 0, cents: 0 },
    arrivals: [],
    daily: [],
    byDaysOut: [],
    ticketTypes: [],
    heat: [],
    leadTime: { sameDay: 0, d1to3: 0, d4to7: 0, w1to2: 0, w2plus: 0 },
    channels: { online: 0, manual: 0 },
    payment: [],
    orders: {
      count: 0,
      avgCents: null,
      sizes: { one: 0, two: 0, threeFour: 0, fivePlus: 0 },
      biggest: null,
    },
    codes: [],
    autoDiscountCents: 0,
    mailingList: { optedIn: 0, of: 0 },
    pace: null,
    repeatFans: null,
    highlights: [],
    limited: true,
  };
}
