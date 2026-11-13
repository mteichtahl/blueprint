import { describe, expect, it } from 'vitest';
import {
  byTime,
  checkTimes,
  CrewPerson,
  crewTag,
  crossesMidnight,
  dealNoteFor,
  defaultMoney,
  Money,
  moneySummary,
  durationMinutes,
  EventBody,
  EventCreate,
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
    expect(gigMatches(gig, 'all', today)).toBe(true);
    expect(gigMatches({ ...gig, status: 'cancelled' }, 'all', today)).toBe(true);
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

describe('set duration (removed in rev 7)', () => {
  it('is no longer accepted on gigs', () => {
    expect(
      GigCreate.parse({ title: 'X', date: '2026-12-11', setLength: '45 min' }),
    ).not.toHaveProperty('setLength');
    expect(GigPatch.safeParse({ setLength: '45 min' }).success).toBe(false);
  });
});

describe('deal: Other with free text', () => {
  it('defaults to not set yet', () => {
    expect(GigCreate.parse({ title: 'X', date: '2026-12-11' }).deal).toBe('tbc');
  });

  it('keeps the note only for Other', () => {
    expect(dealNoteFor('other', '  70/30 after costs ')).toBe('70/30 after costs');
    expect(dealNoteFor('other', '   ')).toBeUndefined();
    expect(dealNoteFor('fee', 'stale note')).toBeUndefined();
  });

  it('accepts a longer description', () => {
    const note = 'x'.repeat(300);
    expect(GigPatch.parse({ deal: 'other', dealNote: note }).dealNote).toBe(note);
    expect(GigPatch.safeParse({ dealNote: 'x'.repeat(301) }).success).toBe(false);
  });
});

describe('money: tickets, takings, costs and profit', () => {
  it('starts gigs with the preset cost rows', () => {
    expect(defaultMoney().costs.map((c) => c.label)).toEqual([
      'Venue',
      'Photography',
      'Videography',
      'Content',
      'Support band',
      'Backing band',
      'Merchandise',
    ]);
  });

  it('adds merchandise sales to takings and its cost to costs', () => {
    const m = Money.parse({
      ticketsSold: 100,
      takingsCents: 200000,
      merchTakingsCents: 60000,
      costs: [
        { id: 'p1', label: 'Venue', amountCents: 50000 },
        { id: 'p7', label: 'Merchandise', amountCents: 25000 },
      ],
    });
    expect(moneySummary(m)).toEqual({
      costsCents: 75000,
      totalTakingsCents: 260000,
      profitCents: 185000,
      merchProfitCents: 35000,
      perTicketCents: 2000,
    });
    // Figures saved before merchandise existed still read (no merch sales).
    expect(Money.parse({ takingsCents: 1000 }).merchTakingsCents).toBe(0);
  });

  it('works out profit (and losses)', () => {
    const m = Money.parse({
      ticketsSold: 120,
      takingsCents: 240000,
      costs: [
        { id: 'p1', label: 'Venue', amountCents: 80000 },
        { id: 'c1', label: 'Sound engineer', amountCents: 30000 },
      ],
    });
    expect(moneySummary(m)).toEqual({
      costsCents: 110000,
      totalTakingsCents: 240000,
      profitCents: 130000,
      merchProfitCents: 0,
      perTicketCents: 2000,
    });
    expect(moneySummary({ ticketsSold: 0, takingsCents: 0, costs: m.costs }).profitCents).toBe(
      -110000,
    );
    expect(moneySummary({ ticketsSold: 0, takingsCents: 0, costs: [] }).perTicketCents).toBeNull();
  });

  it('allows custom rows and deleting presets, but checks the figures', () => {
    expect(Money.safeParse({ costs: [] }).success).toBe(true);
    expect(Money.safeParse({ takingsCents: -1 }).success).toBe(false);
    expect(Money.safeParse({ costs: [{ id: 'a', label: '', amountCents: 1 }] }).success).toBe(
      false,
    );
    expect(
      Money.safeParse({
        costs: [
          { id: 'a', label: 'X', amountCents: 1 },
          { id: 'a', label: 'Y', amountCents: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(GigPatch.parse({ money: { ticketsSold: 3 } }).money).toEqual({
      ticketsSold: 3,
      takingsCents: 0,
      merchTakingsCents: 0,
      costs: [],
    });
  });

  it('gives events takings and profit from what the budget rows spent', () => {
    const e = EventBody.parse({ name: 'Mixer', date: '2026-12-11', takingsCents: 500000 });
    const s = summarise(e, {
      guests: [],
      speakers: [],
      crew: [],
      budget: [
        { budgetCents: 300000, spentCents: 280000 },
        { budgetCents: 50000, spentCents: 0 },
      ],
    });
    expect(s.takingsCents).toBe(500000);
    expect(s.profitCents).toBe(220000);
  });
});

describe('venues picked from the list', () => {
  it('keeps the venue id with the name on gigs and events', () => {
    expect(
      GigCreate.parse({ title: 'X', date: '2026-12-11', venue: 'Corner', venueId: 'v0000000001' })
        .venueId,
    ).toBe('v0000000001');
    expect(GigCreate.safeParse({ title: 'X', date: '2026-12-11', venueId: 'nope!' }).success).toBe(
      false,
    );
    expect(GigPatch.parse({ venueId: null })).toEqual({ venueId: null });
    expect(EventBody.parse({ name: 'M', date: '2026-12-11', venueId: 'v0000000001' }).venueId).toBe(
      'v0000000001',
    );
  });
});

describe('event start and end times (required)', () => {
  const base = { name: 'Mixer Night', date: '2026-12-11' };
  it('needs both times on a new event', () => {
    const missing = EventCreate.safeParse(base);
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((i) => i.message)).toContain('Add the start time');
    expect(EventCreate.safeParse({ ...base, startTime: '18:00' }).success).toBe(false);
    expect(EventCreate.safeParse({ ...base, startTime: '18:00', endTime: '18:00' }).success).toBe(
      false,
    );
    expect(EventCreate.parse({ ...base, startTime: '18:00', endTime: '23:30' })).toMatchObject({
      startTime: '18:00',
      endTime: '23:30',
    });
    expect(EventCreate.safeParse({ ...base, startTime: '21:00', endTime: '01:00' }).success).toBe(
      true,
    );
  });

  it('still reads older events without times', () => {
    expect(EventBody.safeParse(base).success).toBe(true);
  });
});

describe('run sheet notes', () => {
  it('adds notes to run sheet items', () => {
    const row = PART_SCHEMAS.run.parse({
      time: '19:00',
      item: 'Doors',
      notes: 'Wristbands at desk',
    });
    expect(row.notes).toBe('Wristbands at desk');
    expect(PART_SCHEMAS.run.parse({ time: '19:00', item: 'Doors' }).notes).toBe('');
    expect(
      PART_SCHEMAS.run.safeParse({ time: '19:00', item: 'X', notes: 'x'.repeat(1001) }).success,
    ).toBe(false);
    expect(patchOf(PART_SCHEMAS.run).parse({ notes: 'Mic check' })).toEqual({ notes: 'Mic check' });
  });
});

describe('crew and volunteers', () => {
  it('needs a name, email and phone for each person', () => {
    expect(
      CrewPerson.safeParse({ name: 'Ali', email: 'ali@x.com', phone: '0412 345 678' }).success,
    ).toBe(true);
    expect(CrewPerson.safeParse({ name: 'Ali', email: 'ali@x.com', phone: '' }).success).toBe(
      false,
    );
    expect(CrewPerson.safeParse({ name: 'Ali', email: 'nope', phone: '0412345678' }).success).toBe(
      false,
    );
    expect(CrewPerson.safeParse({ name: '', email: 'a@x.com', phone: '0412345678' }).success).toBe(
      false,
    );
    expect(crewTag({ type: 'volunteer' })).toBe('Volunteer');
    expect(crewTag({ type: 'crew' })).toBe('Crew');
  });

  it('counts filled roles from the people on them', () => {
    const e = EventBody.parse({ name: 'M', date: '2026-12-11' });
    const s = summarise(e, {
      guests: [],
      speakers: [],
      crew: [
        { needed: 2, filled: 0, people: [{}, {}, {}] },
        { needed: 3, filled: 1 },
      ],
      budget: [],
    });
    expect(s.crewFilled).toBe(3);
    expect(s.crewNeeded).toBe(5);
  });
});
