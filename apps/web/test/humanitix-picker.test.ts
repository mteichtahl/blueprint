import { describe, expect, it } from 'vitest';
import { melbourneTime, pickerRows } from '../src/lib/connectors.ts';

/** Rev 19: the gig form's Humanitix picker order. */
describe('pickerRows', () => {
  const events = [
    { id: 'later', name: 'Later show', startDate: '2027-02-01T09:00:00.000Z' },
    { id: 'soon', name: 'Soon show', startDate: '2026-12-01T09:00:00.000Z', venue: 'The Tote' },
    { id: 'same', name: 'Launch', startDate: '2026-12-05T08:30:00.000Z' },
    { id: 'old', name: 'Old show', startDate: '2026-09-01T09:00:00.000Z' },
    { id: 'older', name: 'Older show', startDate: '2026-06-01T09:00:00.000Z' },
    { id: 'nodate', name: 'No date' },
  ];
  const gigs = [
    { gigId: 'g1', title: 'Corner Hotel', humanitixEventId: 'soon' },
    { gigId: 'g2', title: 'Cancelled', status: 'cancelled', humanitixEventId: 'later' },
  ];

  it('puts same-day first, then upcoming soonest first, and keeps past apart', () => {
    const { upcoming, past } = pickerRows(events, {
      gigDate: '2026-12-05',
      today: '2026-11-21',
      gigs,
    });
    expect(upcoming.map((r) => r.id)).toEqual(['same', 'soon', 'later', 'nodate']);
    expect(upcoming[0]!.sameDay).toBe(true);
    expect(past.map((r) => r.id)).toEqual(['old', 'older']);
  });

  it('marks events on other gigs, but not on this gig or a cancelled one', () => {
    const { upcoming } = pickerRows(events, { today: '2026-11-21', gigs });
    expect(upcoming.find((r) => r.id === 'soon')!.linkedTo).toBe('Corner Hotel');
    expect(upcoming.find((r) => r.id === 'later')!.linkedTo).toBeNull();
    const own = pickerRows(events, { gigId: 'g1', today: '2026-11-21', gigs });
    expect(own.upcoming.find((r) => r.id === 'soon')!.linkedTo).toBeNull();
  });

  it('a past gig date still puts its same-day event first', () => {
    const { upcoming } = pickerRows(events, { gigDate: '2026-09-01', today: '2026-11-21', gigs });
    expect(upcoming[0]!.id).toBe('old');
  });

  it('searches the name and venue', () => {
    const { upcoming, past } = pickerRows(events, { today: '2026-11-21', gigs, q: 'tote' });
    expect([...upcoming, ...past].map((r) => r.id)).toEqual(['soon']);
  });

  it("reads Melbourne's clock", () => {
    expect(melbourneTime('2026-12-05T08:30:00.000Z')).toBe('19:30');
    expect(melbourneTime(undefined)).toBeNull();
  });
});
