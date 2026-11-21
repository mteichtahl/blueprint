import { describe, expect, it } from 'vitest';
import { humanitixView, melbourneDay, ticketSeries } from '../src/connectors/humanitix.ts';
import { gigHumanitixId } from '../src/connectors/sync.ts';
import type { Gig } from '../src/events/model.ts';

const gig = (over: Partial<Gig>): Gig =>
  ({
    gigId: 'g1',
    artistId: 'art_aaaaaaaaaaaa',
    title: 'Corner Hotel',
    date: '2026-12-05',
    status: 'confirmed',
    deal: 'ticketed',
    checklist: [],
    plannedBy: 'artist',
    shared: true,
    createdBy: 'u',
    createdAt: '',
    ...over,
  }) as Gig;

const base = {
  connection: { status: 'connected' as const, lastSyncAt: '2026-11-21T03:00:00Z' },
  today: '2026-11-21',
  range: 3,
  idOf: gigHumanitixId,
  afterDays: 30,
};

describe('Humanitix in My stats (rev 18)', () => {
  const events = [
    { id: 'hxCorner', name: 'Chloe at the Corner', startDate: '2026-12-05T09:30:00.000Z' },
    { id: 'hxTote', name: 'Chloe at the Tote', startDate: '2026-12-12T09:00:00.000Z' },
    { id: 'hxOld', name: 'Last year', startDate: '2025-06-01T09:00:00.000Z' },
  ];
  const gigs = [
    gig({
      gigId: 'g1',
      humanitixEventId: 'hxCorner',
      humanitix: { ticketsSold: 120, syncedAt: '2026-11-21T03:00:00Z' },
    }),
    gig({ gigId: 'g2', title: 'The Tote', date: '2026-12-12', shared: false }),
    gig({ gigId: 'g3', title: 'Cancelled', date: '2026-12-12', status: 'cancelled' }),
  ];
  const snaps = [
    { date: '2026-11-19', source: 'humanitix' as const, ticketsSold: 100 },
    { date: '2026-11-21', source: 'humanitix' as const, ticketsSold: 120 },
  ];

  it('shows the artist their events, which gig each is on, and suggests a gig on the same day', () => {
    const v = humanitixView({ ...base, events, gigs, snaps, isArtist: true });
    expect(v.connected).toBe(true);
    expect(v.ticketsSold).toBe(120);
    expect(v.series).toEqual([0, 100, 100, 120]);
    expect(v.gigs).toEqual([
      expect.objectContaining({ gigId: 'g1', eventName: 'Chloe at the Corner', ticketsSold: 120 }),
    ]);
    // Unlinked events first; the Tote is offered its same-day gig (not the cancelled one).
    expect(v.events!.map((e) => [e.id, e.gigId, e.suggestedGigId])).toEqual([
      ['hxTote', null, 'g2'],
      ['hxOld', null, null],
      ['hxCorner', 'g1', null],
    ]);
    expect(v.linkable!.map((g) => g.gigId)).toEqual(['g2']);
  });

  it('shows Blueprint only the counts on shared gigs, never the event list', () => {
    const v = humanitixView({ ...base, events, gigs, snaps, isArtist: false });
    expect(v.gigs.map((g) => g.gigId)).toEqual(['g1']);
    expect(v.events).toBeUndefined();
    expect(v.linkable).toBeUndefined();
  });

  it('says when Humanitix isn’t connected', () => {
    const v = humanitixView({
      ...base,
      connection: undefined,
      events: [],
      gigs: [],
      snaps: [],
      isArtist: true,
    });
    expect(v).toMatchObject({ connected: false, ticketsSold: 0, events: [] });
  });

  it('reads a gig’s Humanitix event from the link picked, or else its ticket link', () => {
    expect(gigHumanitixId({ humanitixEventId: 'abcd' })).toBe('abcd');
    expect(
      gigHumanitixId({ ticketUrl: 'https://events.humanitix.com/x/tickets?eventId=efgh' }),
    ).toBe('efgh');
    expect(gigHumanitixId({ ticketUrl: 'https://moshtix.com.au/x?eventId=1' })).toBeUndefined();
  });

  it('dates a Humanitix start on Melbourne’s calendar, and carries counts across gaps', () => {
    expect(melbourneDay('2026-12-05T14:30:00.000Z')).toBe('2026-12-06');
    expect(melbourneDay(undefined)).toBeNull();
    expect(
      ticketSeries([{ date: '2026-11-01', source: 'humanitix', ticketsSold: 7 }], '2026-11-21', 2),
    ).toEqual([7, 7, 7]);
  });
});
