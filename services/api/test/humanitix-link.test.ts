import { afterEach, describe, expect, it } from 'vitest';
import { checkHumanitixLink, linkAccountOf } from '../src/connectors/humanitix-link.ts';
import { humanitixEvents, setFetch } from '../src/connectors/vendors.ts';

/** Rev 19: picking a Humanitix event on the gig form. */

const own = [{ id: 'evA1' }, { id: 'evB2' }];
const gigs = [
  { gigId: 'g1', title: 'Corner Hotel', status: 'confirmed' as const, humanitixEventId: 'evB2' },
  { gigId: 'g2', title: 'Old show', status: 'cancelled' as const, humanitixEventId: 'evA1' },
  { gigId: 'g3', title: 'No link', status: 'idea' as const },
];

describe('checkHumanitixLink', () => {
  it('lets an artist link a new gig to one of their own events', () => {
    expect(checkHumanitixLink({ isArtist: true, eventId: 'evA1', ownEvents: own, gigs })).toBe(
      undefined,
    );
  });

  it("refuses an event that isn't in the account's own list", () => {
    expect(checkHumanitixLink({ isArtist: true, eventId: 'evZZ', ownEvents: own, gigs })).toMatch(
      /isn't in your Humanitix account/,
    );
    expect(checkHumanitixLink({ isArtist: false, eventId: 'evZZ', ownEvents: own, gigs })).toMatch(
      /Blueprint's Humanitix account/,
    );
  });

  it('refuses when the account has no list (not connected or not synced)', () => {
    expect(
      checkHumanitixLink({ isArtist: true, eventId: 'evA1', ownEvents: undefined, gigs }),
    ).toMatch(/isn't connected/);
  });

  it('keeps one event on one gig, ignoring cancelled gigs and the gig itself', () => {
    expect(checkHumanitixLink({ isArtist: true, eventId: 'evB2', ownEvents: own, gigs })).toMatch(
      /already linked to Corner Hotel/,
    );
    // g2 is cancelled, so its event is free again.
    expect(
      checkHumanitixLink({ isArtist: true, eventId: 'evA1', ownEvents: own, gigs }),
    ).toBeUndefined();
    // Saving g1 with its own event changes nothing.
    expect(
      checkHumanitixLink({
        isArtist: true,
        gig: { gigId: 'g1', humanitixEventId: 'evB2' },
        eventId: 'evB2',
        ownEvents: own,
        gigs,
      }),
    ).toBeUndefined();
  });

  it("stops Blueprint changing or removing a link to the artist's own account", () => {
    const gig = { gigId: 'g1', humanitixEventId: 'evB2' };
    expect(
      checkHumanitixLink({ isArtist: false, gig, eventId: null, ownEvents: own, gigs }),
    ).toMatch(/only the artist can change it/);
    expect(
      checkHumanitixLink({ isArtist: false, gig, eventId: 'evA1', ownEvents: own, gigs }),
    ).toMatch(/only the artist/);
  });

  it('lets Blueprint change its own link, and the artist unlink any', () => {
    const bmgGig = { gigId: 'g1', humanitixEventId: 'evB2', humanitixAccount: 'bmg' as const };
    expect(
      checkHumanitixLink({ isArtist: false, gig: bmgGig, eventId: null, ownEvents: own, gigs }),
    ).toBeUndefined();
    expect(
      checkHumanitixLink({ isArtist: true, gig: bmgGig, eventId: null, ownEvents: own, gigs }),
    ).toBeUndefined();
    expect(linkAccountOf(bmgGig)).toBe('bmg');
    expect(linkAccountOf({})).toBe('artist');
  });
});

describe('humanitixEvents (rev 19 fields)', () => {
  afterEach(() => setFetch((...a) => fetch(...a)));

  it('reads the end time, venue and public page, and ignores links off Humanitix', async () => {
    setFetch(
      async () =>
        new Response(
          JSON.stringify({
            events: [
              {
                _id: 'ev1',
                name: 'Single launch',
                startDate: '2026-12-05T09:00:00.000Z',
                endDate: '2026-12-05T12:00:00.000Z',
                eventLocation: { venueName: ' Corner Hotel ' },
                url: 'https://events.humanitix.com/single-launch',
              },
              { _id: 'ev2', name: 'Other', slug: 'other-show', url: 'https://evil.example/x' },
              { _id: 'ev3', name: 'Bare' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const events = await humanitixEvents('key');
    expect(events[0]).toEqual({
      id: 'ev1',
      name: 'Single launch',
      startDate: '2026-12-05T09:00:00.000Z',
      endDate: '2026-12-05T12:00:00.000Z',
      venue: 'Corner Hotel',
      url: 'https://events.humanitix.com/single-launch',
    });
    expect(events[1]!.url).toBe('https://events.humanitix.com/other-show');
    expect(events[2]).toEqual({ id: 'ev3', name: 'Bare' });
  });
});
