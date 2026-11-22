import { describe, expect, it } from 'vitest';
import {
  analyticsCsv,
  analyticsPath,
  dollars,
  salesCurve,
  soldBy,
  syncPath,
  type TicketAnalytics,
} from '../src/lib/ticketAnalytics.ts';

/** Rev 20: the sums the Ticket analytics page draws with. */

const byDaysOut = Array.from({ length: 121 }, (_, d) =>
  d === 30 ? 10 : d === 21 ? 5 : d === 0 ? 2 : 0,
);

describe('salesCurve', () => {
  it('runs from the first sale to the show, stopping the sold line at today', () => {
    const c = salesCurve({ byDaysOut, daysOut: 20, status: 'on-sale', pace: null });
    expect(c.from).toBe(30);
    expect(c.days).toHaveLength(31);
    expect(c.sold).toHaveLength(11); // 30 → 20 days out
    expect(c.sold[0]).toBe(soldBy(byDaysOut, 30));
    expect(c.sold.at(-1)).toBe(15);
    expect(c.usual).toBeNull();
  });

  it('covers at least two weeks, and the whole run once the night is over', () => {
    const early = Array.from({ length: 121 }, (_, d) => (d === 3 ? 4 : 0));
    const c = salesCurve({ byDaysOut: early, daysOut: 2, status: 'on-sale', pace: null });
    expect(c.from).toBe(14);
    const done = salesCurve({
      byDaysOut,
      daysOut: 0,
      status: 'finished',
      pace: { usual: new Array(121).fill(3), events: 1, now: 17, usualNow: 3, diffPct: 467 },
    });
    expect(done.sold.at(-1)).toBe(17);
    expect(done.usual).toHaveLength(31);
  });
});

describe('paths', () => {
  it('reads and syncs through the existing Humanitix routes', () => {
    expect(analyticsPath({ artistId: 'a1', gigId: 'g1' })).toBe(
      '/connectors/humanitix/events?analytics=1&artistId=a1&gigId=g1',
    );
    expect(analyticsPath({ eventId: 'e1' })).toBe(
      '/connectors/humanitix/events?analytics=1&eventId=e1',
    );
    expect(syncPath({ artistId: 'a1', gigId: 'g1' }, true)).toBe(
      '/artists/a1/connectors/humanitix/sync?analytics=1&gigId=g1',
    );
    expect(syncPath({ artistId: 'a1', gigId: 'g1' }, false)).toBe(
      '/connectors/humanitix/sync?analytics=1&artistId=a1&gigId=g1',
    );
  });
});

describe('analyticsCsv', () => {
  it('exports the figures, with formula-looking text made safe', () => {
    const a = {
      name: '=Launch, night',
      status: 'on-sale',
      sold: 168,
      capacity: 220,
      money: {
        ticketSalesCents: 435000,
        discountsCents: 5000,
        absorbedFeesCents: 9600,
        refundsCents: 11200,
        otherCents: 0,
        netCents: 409200,
        grossCents: 471200,
        passedOnFeesCents: 41200,
        taxesCents: 0,
        donationsCents: 0,
      },
      avgTicketCents: 2560,
      refunds: { tickets: 4, orders: 3, cents: 11200 },
      checkedIn: null,
      ticketTypes: [
        {
          id: 'g',
          name: 'General',
          priceCents: 2800,
          sold: 90,
          quantity: 120,
          revenueCents: 247000,
          soldOut: false,
          soldOutInDays: null,
        },
      ],
      daily: [{ day: '2026-11-12', n: 31 }],
      payment: [{ label: 'Card', tickets: 119 }],
      channels: { online: 164, manual: 4 },
      codes: [],
      orders: {
        count: 97,
        avgCents: 4433,
        sizes: { one: 0, two: 0, threeFour: 0, fivePlus: 0 },
        biggest: null,
      },
      arrivals: [],
    } as unknown as TicketAnalytics;
    const csv = analyticsCsv(a).split('\n');
    expect(csv[0]).toBe('Section,Item,Value');
    expect(csv[1]).toBe(`Summary,Event,"'=Launch, night"`);
    expect(csv).toContain('Summary,Net to you ($),4092.00');
    expect(csv).toContain('Money,Discounts ($),-50.00');
    expect(csv).toContain('Ticket types,General sold,90 / 120');
    expect(dollars(409200)).toBe('$4,092');
    expect(dollars(2560)).toBe('$25.60');
  });
});
