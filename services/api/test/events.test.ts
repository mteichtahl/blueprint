import { describe, expect, it } from 'vitest';
import {
  byTime,
  checkTimes,
  crossesMidnight,
  durationMinutes,
  EventBody,
  EventPatch,
  GigCreate,
  gigGsi3Sk,
  gigMatches,
  GigPatch,
  gigPatchAllowed,
  PART_SCHEMAS,
  partSk,
  patchOf,
  summarise,
  type Gig,
} from '../src/events/model.ts';

const gig: Gig = {
  gigId: 'mabcdefgh0123456789',
  artistId: 'art_aaaaaaaaaaaa',
  title: 'Northcote Social Club',
  date: '2026-12-11',
  status: 'confirmed',
  deal: 'door-split',
  checklist: [],
  plannedBy: 'artist',
  shared: false,
  createdBy: 'u-a',
  createdAt: '2026-11-09T00:00:00Z',
};

describe('gigs', () => {
  it('needs a title and a date; shared with Blueprint unless the artist says not', () => {
    const g = GigCreate.parse({ title: 'Launch show', date: '2026-12-11' });
    expect(g.shared).toBe(true);
    expect(GigCreate.safeParse({ title: 'Launch show' }).success).toBe(false);
    expect(GigCreate.safeParse({ title: 'x', date: '11/12/2026' }).success).toBe(false);
  });

  it('lists shared gigs across artists by date', () => {
    expect(gigGsi3Sk(gig)).toBe('2026-12-11#art_aaaaaaaaaaaa#mabcdefgh0123456789');
  });

  it('filters upcoming, past and help wanted', () => {
    const today = '2026-11-09';
    expect(gigMatches(gig, 'upcoming', today)).toBe(true);
    expect(gigMatches({ ...gig, date: '2026-10-01' }, 'past', today)).toBe(true);
    expect(gigMatches({ ...gig, status: 'played' }, 'upcoming', today)).toBe(false);
    expect(gigMatches(gig, 'help', today)).toBe(false);
    expect(
      gigMatches(
        { ...gig, help: { text: 'x', topics: [], askedAt: '', status: 'open' } },
        'help',
        today,
      ),
    ).toBe(true);
  });

  it('only the artist asks for help or decides what to share', () => {
    expect(gigPatchAllowed('artist', gig, GigPatch.parse({ askHelp: { topics: ['pitch'] } }))).toBe(
      undefined,
    );
    expect(gigPatchAllowed('bmg-staff', gig, GigPatch.parse({ askHelp: { text: 'x' } }))).toMatch(
      /artist/,
    );
    expect(gigPatchAllowed('bmg-admin', gig, GigPatch.parse({ shared: true }))).toMatch(/artist/);
    expect(
      gigPatchAllowed('artist', { ...gig, plannedBy: 'bmg' }, GigPatch.parse({ shared: false })),
    ).toMatch(/stay shared/);
    expect(gigPatchAllowed('bmg-staff', gig, GigPatch.parse({ helpDone: true }))).toMatch(
      /no open help/,
    );
  });

  it('refuses an empty change or an empty help request', () => {
    expect(GigPatch.safeParse({}).success).toBe(false);
    expect(GigPatch.safeParse({ askHelp: {} }).success).toBe(false);
    expect(
      GigCreate.safeParse({ title: 'x', date: '2026-12-11', ticketUrl: 'http://x.io' }).success,
    ).toBe(false);
  });
});

describe('events', () => {
  it('a patch carries only what was sent, never defaults', () => {
    expect(EventPatch.parse({ name: 'Mixer Night' })).toEqual({ name: 'Mixer Night' });
    expect(patchOf(PART_SCHEMAS.crew).parse({ filled: 2 })).toEqual({ filled: 2 });
    expect(EventPatch.safeParse({}).success).toBe(false);
    expect(EventPatch.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('keys each part under the event', () => {
    expect(partSk('run', 'abc')).toBe('RUN#abc');
  });

  it('adds up the four headline cards', () => {
    const e = EventBody.parse({
      name: 'Mixer Night',
      date: '2026-12-11',
      capacity: 150,
      ticketTarget: 100,
      ticketPriceCents: 2500,
      ticketsSold: 64,
      compsTarget: 30,
    });
    const s = summarise(e, {
      guests: [{ status: 'accepted' }, { status: 'invited' }, { status: 'accepted' }],
      speakers: [{ status: 'confirmed' }, { status: 'waiting' }],
      crew: [
        { needed: 2, filled: 3 },
        { needed: 4, filled: 1 },
      ],
      budget: [
        { budgetCents: 50000, spentCents: 20000 },
        { budgetCents: 30000, spentCents: 0 },
      ],
    });
    expect(s).toMatchObject({
      ticketsSold: 64,
      compsAccepted: 2,
      inRoom: 66,
      budgetCents: 80000,
      spentCents: 20000,
      ticketIncomeCents: 160000,
      crewFilled: 3,
      crewNeeded: 6,
      speakersConfirmed: 1,
    });
  });

  it('sorts the run sheet by time', () => {
    const rows = [{ time: '20:00' }, { time: '18:30' }, { time: '19:15' }];
    expect(rows.sort(byTime).map((r) => r.time)).toEqual(['18:30', '19:15', '20:00']);
  });
});

describe('gig start and end times', () => {
  it('needs a start for an end, and different times', () => {
    expect(checkTimes(undefined, '22:00')).toBe('Add a start time too');
    expect(checkTimes('20:00', '20:00')).toMatch(/after the start/);
    expect(checkTimes('20:00', '23:00')).toBeUndefined();
    expect(checkTimes('22:00', '01:00')).toBeUndefined();
    expect(checkTimes(null, null)).toBeUndefined();
  });

  it('rolls late gigs past midnight', () => {
    expect(crossesMidnight('22:00', '01:00')).toBe(true);
    expect(crossesMidnight('19:00', '23:00')).toBe(false);
    expect(durationMinutes('22:00', '01:30')).toBe(210);
    expect(durationMinutes('19:30', '21:00')).toBe(90);
    expect(durationMinutes('19:30')).toBeUndefined();
  });

  it('accepts start and end on create and clears them on patch', () => {
    expect(
      GigCreate.parse({
        title: 'Launch',
        date: '2026-12-11',
        startTime: '19:30',
        endTime: '23:00',
      }),
    ).toMatchObject({ startTime: '19:30', endTime: '23:00' });
    expect(GigCreate.safeParse({ title: 'X', date: '2026-12-11', startTime: '7pm' }).success).toBe(
      false,
    );
    expect(GigPatch.parse({ endTime: null })).toEqual({ endTime: null });
  });
});
