import { afterEach, describe, expect, it } from 'vitest';
import {
  analyticsView,
  fanHash,
  limitedView,
  paymentLabel,
  soldBy,
  summarise,
  type HxStats,
} from '../src/connectors/humanitix-analytics.ts';
import { gigAnalyticsAccess } from '../src/connectors/humanitix-access.ts';
import { humanitixMoney, type Gig } from '../src/events/model.ts';
import {
  humanitixEventData,
  HUMANITIX_SCOPE_MESSAGE,
  setFetch,
  setHumanitixRetryWait,
  VendorError,
} from '../src/connectors/vendors.ts';

/** Rev 20: ticket analytics for a linked Humanitix event. */

const SHOW = '2026-12-12T09:00:00.000Z'; // Sat 12 Dec, 8 pm in Melbourne
const event = {
  _id: 'ev1',
  name: 'Single launch night',
  startDate: SHOW,
  endDate: '2026-12-12T12:30:00.000Z',
  url: 'https://events.humanitix.com/single-launch',
  totalCapacity: 220,
  ticketTypes: [
    { _id: 'tt-early', name: 'Early bird', price: 20, quantity: 2 },
    { _id: 'tt-gen', name: 'General', price: 28, quantity: 120 },
  ],
};

let n = 0;
function ticket(over: Record<string, unknown>) {
  n++;
  return {
    _id: `t${n}`,
    orderId: 'o1',
    ticketTypeId: 'tt-gen',
    ticketTypeName: 'General',
    price: 28,
    discount: 0,
    absorbedFee: 1,
    passedOnFee: 2.5,
    status: 'complete',
    createdAt: '2026-11-12T08:00:00.000Z', // Thu 12 Nov, 7 pm in Melbourne
    // Personal fields Humanitix sends: none may be kept.
    firstName: 'Sam',
    lastName: 'Fan',
    ...over,
  };
}
const orders = [
  {
    _id: 'o1',
    email: 'Sam@Example.com',
    firstName: 'Sam',
    mobile: '0400 000 000',
    status: 'complete',
    financialStatus: 'paid',
    paymentGateway: 'stripe',
    salesChannel: 'online',
    organiserMailListOptIn: true,
    discounts: { discountCode: { code: 'family15', discountAmount: 8.4 } },
    totals: { discounts: 8.4, refunds: 0, netSales: 70.6, grossSales: 84.1, totalTaxes: 7 },
  },
  {
    _id: 'o2',
    email: 'alex@example.com',
    status: 'complete',
    financialStatus: 'partiallyRefunded',
    paymentGateway: 'afterpay',
    salesChannel: 'online',
    totals: { discounts: 0, refunds: 28, netSales: 39, grossSales: 75, totalTaxes: 4 },
  },
  {
    _id: 'o3',
    email: 'door@example.com',
    status: 'complete',
    financialStatus: 'paid',
    paymentType: 'cash',
    paymentGateway: 'manual',
    salesChannel: 'manual',
    manualOrder: true,
    totals: { discounts: 0, refunds: 0, netSales: 28, grossSales: 28, totalTaxes: 2.5 },
  },
];
const tickets = [
  // o1: two General with the code, one Early bird.
  ticket({ discount: 4.2 }),
  ticket({ discount: 4.2 }),
  ticket({ ticketTypeId: 'tt-early', ticketTypeName: 'Early bird', price: 20 }),
  // o2: Early bird (sells it out, two days after the first) and a refunded General.
  ticket({
    orderId: 'o2',
    ticketTypeId: 'tt-early',
    ticketTypeName: 'Early bird',
    price: 20,
    createdAt: '2026-11-14T01:00:00.000Z',
  }),
  ticket({ orderId: 'o2', status: 'cancelled', createdAt: '2026-11-14T01:00:00.000Z' }),
  // o3: bought at the door on the night, and checked in.
  ticket({
    orderId: 'o3',
    absorbedFee: 0,
    passedOnFee: 0,
    createdAt: '2026-12-12T09:05:00.000Z',
    checkIn: { checkedIn: true, date: '2026-12-12T09:07:00.000Z' },
  }),
  // A donation is not a ticket.
  ticket({ orderId: 'o3', isDonation: true, price: 5 }),
];

const stats = summarise({
  account: 'artist-1',
  eventId: 'ev1',
  event,
  orders,
  tickets,
  now: new Date('2026-11-22T00:00:00.000Z'),
});

describe('summarise', () => {
  it('counts sold tickets, leaving out refunds and donations', () => {
    expect(stats.sold).toBe(5);
    expect(stats.refunds).toEqual({ tickets: 1, orders: 1, cents: 2800 });
    expect(stats.capacity).toBe(220);
    expect(stats.status).toBe('on-sale');
  });

  it('adds the money up from Humanitix totals, so the waterfall lands on net', () => {
    const m = stats.money;
    expect(m.ticketSalesCents).toBe(28 * 100 * 4 + 20 * 100 * 2); // refunded ticket included
    expect(m.discountsCents).toBe(840);
    expect(m.absorbedFeesCents).toBe(400);
    expect(m.refundsCents).toBe(2800);
    expect(m.netCents).toBe(13760);
    expect(
      m.ticketSalesCents - m.discountsCents - m.absorbedFeesCents - m.refundsCents + m.otherCents,
    ).toBe(m.netCents);
    expect(m.grossCents).toBe(18710);
    expect(m.passedOnFeesCents).toBe(1000);
  });

  it('breaks sales down by type, channel, payment, code and order size', () => {
    const early = stats.ticketTypes.find((t) => t.id === 'tt-early')!;
    expect(early).toMatchObject({ sold: 2, quantity: 2, soldOut: true, soldOutInDays: 2 });
    expect(stats.ticketTypes.find((t) => t.id === 'tt-gen')).toMatchObject({
      sold: 3,
      revenueCents: 2800 + 2380 * 2,
    });
    expect(stats.channels).toEqual({ online: 4, manual: 1 });
    expect(stats.payment).toEqual([
      { label: 'Card', tickets: 3 },
      { label: 'Afterpay', tickets: 1 },
      { label: 'Cash', tickets: 1 },
    ]);
    expect(stats.codes).toEqual([
      { code: 'FAMILY15', orders: 1, tickets: 3, discountCents: 840, revenueCents: 6760 },
    ]);
    expect(stats.orders.sizes).toEqual({ one: 2, two: 0, threeFour: 1, fivePlus: 0 });
    expect(stats.orders.biggest).toEqual({ tickets: 3, cents: 6760 });
    expect(stats.mailingList).toEqual({ optedIn: 1, of: 3 });
  });

  it('works out when people buy, in Melbourne time', () => {
    expect(stats.daily).toEqual([
      { day: '2026-11-12', n: 3 },
      { day: '2026-11-14', n: 1 },
      { day: '2026-12-12', n: 1 },
    ]);
    // Thursday 7 pm → the 5–8 pm slot; Saturday 12 pm → afternoon; the night itself → late.
    expect(stats.heat[3]).toEqual([0, 0, 3, 0]);
    expect(stats.heat[5]).toEqual([0, 1, 0, 1]);
    expect(stats.leadTime).toEqual({ sameDay: 1, d1to3: 0, d4to7: 0, w1to2: 0, w2plus: 4 });
    expect(soldBy(stats.byDaysOut, 0)).toBe(5);
    expect(soldBy(stats.byDaysOut, 28)).toBe(4);
    expect(soldBy(stats.byDaysOut, 29)).toBe(3);
    expect(stats.checkedIn).toBe(1);
    expect(stats.arrivals).toEqual([{ at: '20:00', n: 1 }]);
  });

  it('keeps no personal details, only hashed buyers', () => {
    const text = JSON.stringify(stats);
    for (const s of ['Sam', 'example.com', '0400', 'Fan']) expect(text).not.toContain(s);
    expect(stats.fans).toHaveLength(3);
    expect(stats.fans).toContain(fanHash('artist-1', 'sam@example.com'));
    // The same buyer hashes differently for another account.
    expect(fanHash('artist-2', 'sam@example.com')).not.toBe(fanHash('artist-1', 'sam@example.com'));
  });

  it('marks finished and sold-out events', () => {
    const after = summarise({
      account: 'a',
      eventId: 'ev1',
      event,
      orders,
      tickets,
      now: new Date('2026-12-13T00:00:00Z'),
    });
    expect(after.status).toBe('finished');
    const full = summarise({
      account: 'a',
      eventId: 'ev1',
      event: { ...event, totalCapacity: 5 },
      orders,
      tickets,
      now: new Date('2026-11-22T00:00:00Z'),
    });
    expect(full.status).toBe('sold-out');
  });
});

describe('paymentLabel', () => {
  it('names payment methods the way people say them', () => {
    expect(paymentLabel({ paymentGateway: 'zipmoney' })).toBe('Zip');
    expect(paymentLabel({ paymentType: 'complimentary', paymentGateway: 'manual' })).toBe(
      'Free or comp',
    );
    expect(paymentLabel({ financialStatus: 'free' })).toBe('Free or comp');
    expect(paymentLabel({ paymentGateway: 'bpoint' })).toBe('Card');
    expect(paymentLabel({ paymentType: 'eftpos' })).toBe('Card at the door');
    expect(paymentLabel({})).toBe('Other');
  });
});

describe('analyticsView', () => {
  const earlier: HxStats = {
    ...stats,
    eventId: 'ev0',
    startDate: '2026-10-31T09:00:00.000Z',
    sold: 2,
    byDaysOut: stats.byDaysOut.map((_, i) => (i === 40 ? 2 : 0)),
    fans: [fanHash('artist-1', 'sam@example.com')],
    codes: [],
  };

  it('compares the pace with earlier events and counts repeat fans', () => {
    const v = analyticsView(stats, [stats, earlier], new Date('2026-11-22T00:00:00.000Z'));
    expect(v.daysOut).toBe(20);
    expect(v.pace).toMatchObject({ events: 1, now: 5, usualNow: 2, diffPct: 150 });
    expect(v.repeatFans).toEqual({ fans: 1, of: 3 });
    expect(v.highlights.map((h) => h.label)).toEqual([
      'Pace',
      'Best day',
      'Early bird',
      'Best code',
    ]);
    expect(v.highlights[0]!.text).toBe('150% ahead of your usual pace, 20 days out');
    expect(v.highlights[1]!.text).toBe('Thu 12 Nov: 3 tickets');
    expect(v.highlights[3]!.text).toBe('FAMILY15 brought in $67.60');
    expect('fans' in v).toBe(false);
  });

  it('has no pace or repeat fans for a first event', () => {
    const v = analyticsView(stats, [stats], new Date('2026-11-22T00:00:00.000Z'));
    expect(v.pace).toBeNull();
    expect(v.repeatFans).toBeNull();
  });

  it('gives Blueprint counts and takings only when the artist keeps it private', () => {
    const v = limitedView(analyticsView(stats, [stats, earlier], new Date('2026-11-22T00:00:00Z')));
    expect(v.limited).toBe(true);
    expect(v.sold).toBe(5);
    expect(v.money.netCents).toBe(13760);
    expect(v.money.grossCents).toBe(0);
    expect(v.codes).toEqual([]);
    expect(v.pace).toBeNull();
    expect(v.highlights).toEqual([]);
  });
});

describe('gigAnalyticsAccess', () => {
  const gig = {
    gigId: 'g1',
    artistId: 'artist-1',
    title: 'Launch',
    date: '2026-12-12',
    shared: true,
    humanitixEventId: 'ev1',
  } as unknown as Gig;
  const artist = {
    sub: 'u1',
    role: 'artist',
    artistId: 'artist-1',
    mfaSatisfied: true,
    secondsSinceAuth: 0,
  } as const;
  const other = { ...artist, artistId: 'artist-2' } as const;
  const admin = { sub: 'u2', role: 'bmg-admin', mfaSatisfied: true, secondsSinceAuth: 0 } as const;

  it('lets the artist and Blueprint open a shared, linked gig', () => {
    const a = gigAnalyticsAccess(artist, gig);
    expect(a.ok && a.target).toMatchObject({ account: 'artist-1', hxId: 'ev1', limited: false });
    const b = gigAnalyticsAccess(admin, gig);
    expect(b.ok && b.target).toMatchObject({ limited: false });
  });

  it('keeps it from other artists, and from Blueprint when not shared', () => {
    expect(gigAnalyticsAccess(other, gig)).toMatchObject({ ok: false, status: 404 });
    expect(gigAnalyticsAccess(admin, { ...gig, shared: false })).toMatchObject({ ok: false });
    expect(gigAnalyticsAccess(artist, { ...gig, humanitixEventId: undefined })).toMatchObject({
      ok: false,
      message: 'This gig is not linked to Humanitix',
    });
  });

  it("limits Blueprint when the artist turns sharing off, but not on Blueprint's own link", () => {
    const off = { ...gig, shareTicketAnalytics: false };
    const b = gigAnalyticsAccess(admin, off);
    expect(b.ok && b.target).toMatchObject({ limited: true });
    const own = gigAnalyticsAccess(admin, { ...off, humanitixAccount: 'bmg' as const });
    expect(own.ok && own.target).toMatchObject({ account: 'bmg', limited: false });
    const self = gigAnalyticsAccess(artist, off);
    expect(self.ok && self.target).toMatchObject({ limited: false });
  });
});

describe('humanitixMoney', () => {
  it("fills ticket takings from Humanitix's net, keeping costs", () => {
    const m = humanitixMoney(
      {
        ticketsSold: 0,
        takingsCents: 0,
        merchTakingsCents: 500,
        costs: [{ id: 'c1', label: 'Sound', amountCents: 10000 }],
      },
      { ticketsSold: 168, netCents: 409200 },
    );
    expect(m).toMatchObject({
      ticketsSold: 168,
      takingsCents: 409200,
      merchTakingsCents: 500,
      takingsFromHumanitix: true,
    });
    expect(m!.costs).toHaveLength(1);
  });

  it('leaves a typed-in figure alone, and adds nothing before any sales', () => {
    const own = {
      ticketsSold: 10,
      takingsCents: 9900,
      merchTakingsCents: 0,
      costs: [],
      takingsFromHumanitix: false,
    };
    expect(humanitixMoney(own, { ticketsSold: 168, netCents: 409200 })).toBe(own);
    expect(humanitixMoney(undefined, { ticketsSold: 0, netCents: 0 })).toBeUndefined();
    expect(humanitixMoney(undefined, { ticketsSold: 3 })).toBeUndefined();
    expect(
      humanitixMoney(undefined, { ticketsSold: 3, netCents: 8400 })?.costs.length,
    ).toBeGreaterThan(0);
  });
});

describe('humanitixEventData', () => {
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  afterEach(() => setHumanitixRetryWait(15_000));

  it('pages orders and tickets 100 at a time', async () => {
    const calls: string[] = [];
    setFetch(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/orders'))
        return reply({ orders: u.includes('page=1&') ? new Array(100).fill({}) : [{}] });
      if (u.includes('/tickets')) return reply({ tickets: [{}, {}] });
      return reply(event);
    });
    const d = await humanitixEventData('key', 'ev1');
    expect(d.orders).toHaveLength(101);
    expect(d.tickets).toHaveLength(2);
    expect(calls.filter((c) => c.includes('pageSize=100'))).toHaveLength(3);
  });

  it('waits once on 429, and reads a 403 as a missing scope (not a dead key)', async () => {
    setHumanitixRetryWait(0);
    let first = true;
    setFetch(async () => {
      if (first) {
        first = false;
        return reply({ code: 'rate_limited' }, 429);
      }
      return reply({ tickets: [], orders: [] });
    });
    await expect(humanitixEventData('key', 'ev1')).resolves.toBeTruthy();

    setFetch(async (url) => (String(url).includes('/orders') ? reply({}, 403) : reply(event)));
    const err = await humanitixEventData('key', 'ev1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).status).toBe(424);
    expect((err as VendorError).reauth).toBe(false);
    expect((err as VendorError).message).toBe(HUMANITIX_SCOPE_MESSAGE);
  });
});
