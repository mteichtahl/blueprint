import { describe, expect, it } from 'vitest';
import {
  filterRows,
  isTicketedGig,
  ticketRows,
  ticketTotals,
  whenLabel,
  type TicketEvent,
  type TicketGig,
} from '../src/lib/tickets.ts';

const today = '2026-11-13';
const ev = (o: Partial<TicketEvent>): TicketEvent => ({
  eventId: 'e1',
  name: 'Industry Mixer Night',
  date: '2026-11-20',
  venue: 'The Toff',
  capacity: 80,
  ticketTarget: 70,
  ticketsSold: 20,
  ticketPriceCents: 2500,
  takingsCents: 0,
  ...o,
});
const gig = (o: Partial<TicketGig>): TicketGig => ({
  gigId: 'g1',
  artistId: 'art_chloe',
  title: 'Single launch',
  date: '2026-12-05',
  status: 'booked',
  deal: 'ticketed',
  ...o,
});
const rows = (events: TicketEvent[], gigs: TicketGig[], cap: Record<string, number> = {}) =>
  ticketRows({
    events,
    gigs,
    artistNames: { art_chloe: 'Chloe Poli' },
    venueCapacity: cap,
    today,
  });

describe('Studio HQ tickets', () => {
  it('lists upcoming events, workshops and ticketed gigs, soonest first', () => {
    const r = rows(
      [
        ev({}),
        ev({ eventId: 'w1', name: 'Songwriting workshop', kind: 'workshop', date: '2026-11-15' }),
        ev({ eventId: 'old', date: '2026-10-01' }),
      ],
      [gig({})],
    );
    expect(r.map((x) => x.kind)).toEqual(['workshop', 'event', 'gig']);
    expect(r[2]!.who).toBe('Chloe Poli');
  });

  it('leaves out gigs with no tickets to sell', () => {
    expect(isTicketedGig(gig({ deal: 'fee' }))).toBe(false);
    expect(isTicketedGig(gig({ deal: 'tbc', ticketUrl: 'https://humanitix.com/x' }))).toBe(true);
    expect(isTicketedGig(gig({ deal: 'free', money: { ticketsSold: 3, takingsCents: 0 } }))).toBe(
      true,
    );
    expect(isTicketedGig(gig({ status: 'cancelled' }))).toBe(false);
    expect(isTicketedGig(gig({ status: 'idea' }))).toBe(false);
  });

  it('measures events against the target, else capacity; gigs against the venue', () => {
    const [e] = rows([ev({ ticketTarget: 0 })], []);
    expect([e!.of, e!.ofLabel]).toEqual([80, 'capacity']);
    const [g] = rows([], [gig({ venueId: 'v1' })], { v1: 150 });
    expect([g!.of, g!.ofLabel]).toEqual([150, 'capacity']);
    const [g2] = rows([], [gig({})]);
    expect([g2!.of, g2!.ofLabel]).toEqual([0, '']);
  });

  it('flags as behind within 14 days when under half the target is sold', () => {
    expect(rows([ev({ ticketsSold: 20 })], [])[0]!.behind).toBe(true);
    expect(rows([ev({ ticketsSold: 35 })], [])[0]!.behind).toBe(false);
    expect(rows([ev({ date: '2026-12-31' })], [])[0]!.behind).toBe(false);
    expect(rows([ev({ ticketTarget: 0, capacity: 0 })], [])[0]!.behind).toBe(false);
  });

  it('uses takings typed in, else tickets × price; marks Humanitix', () => {
    expect(rows([ev({})], [])[0]!.takingsCents).toBe(50000);
    expect(rows([ev({ takingsCents: 61000 })], [])[0]!.takingsCents).toBe(61000);
    expect(rows([ev({ humanitixEventId: 'abc' })], [])[0]!.source).toBe('humanitix');
    expect(rows([], [gig({ ticketUrl: 'https://events.humanitix.com/launch' })])[0]!.source).toBe(
      'humanitix',
    );
    expect(rows([], [gig({ ticketUrl: 'https://moshtix.com.au/x' })])[0]!.source).toBe('typed');
  });

  it('filters and totals', () => {
    const r = rows([ev({})], [gig({ money: { ticketsSold: 40, takingsCents: 80000 } })]);
    expect(filterRows(r, 'events')).toHaveLength(1);
    expect(filterRows(r, 'gigs')).toHaveLength(1);
    expect(ticketTotals(r)).toEqual({ sold: 60, takingsCents: 130000, behind: 1, count: 2 });
  });

  it('says when', () => {
    expect(whenLabel({ date: today, daysAway: 0 })).toBe('Today');
    expect(whenLabel({ date: '2026-11-14', daysAway: 1 })).toBe('Tomorrow');
    expect(whenLabel({ date: '2026-11-20', daysAway: 7 })).toBe('In 7 days');
  });
});
