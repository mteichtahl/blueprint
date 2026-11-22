import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok } from '../src/api.ts';

/**
 * UAT script F: an artist's gig is private until shared, then Blueprint sees
 * it; other artists never do. Gigs have no delete, so each run's is cancelled.
 */

interface Gig {
  gigId: string;
  shared: boolean;
  status: string;
  startTime?: string;
  endTime?: string;
}

test.describe.configure({ mode: 'serial' });

let artistId: string;
let gig: Gig;
const inAMonth = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const ids = (gigs: Gig[]) => gigs.map((g) => g.gigId);

test.beforeAll(async () => {
  artistId = await artistIdOf('artistOn');
});

test('F-03: a gig can’t start and end at the same time', async () => {
  const res = await call('artistOn', 'POST', `/artists/${artistId}/gigs`, {
    title: tag('bad times'),
    date: inAMonth(),
    startTime: '20:00',
    endTime: '20:00',
    shared: false,
  });
  expect(res.status).toBe(400);
});

test('F-01, F-02: an artist plans a gig without sharing it', async () => {
  gig = await ok<Gig>('artistOn', 'POST', `/artists/${artistId}/gigs`, {
    title: tag('gig'),
    date: inAMonth(),
    startTime: '19:30',
    endTime: '23:00',
    venue: 'E2E Test Venue',
    deal: 'other',
    dealNote: 'Door split, E2E test',
    shared: false,
  });
  expect(gig.shared).toBe(false);
  expect(gig.startTime).toBe('19:30');
  expect(gig.endTime).toBe('23:00');
  const theirs = await ok<{ gigs: Gig[] }>('artistOn', 'GET', `/artists/${artistId}/gigs`);
  expect(ids(theirs.gigs)).toContain(gig.gigId);
});

test('an unshared gig is hidden from Blueprint', async () => {
  const ws = await ok<{ gigs: Gig[] }>('admin', 'GET', `/artists/${artistId}/gigs`);
  expect(ids(ws.gigs)).not.toContain(gig.gigId);
  const all = await ok<{ gigs: Gig[] }>('admin', 'GET', '/gigs');
  expect(ids(all.gigs)).not.toContain(gig.gigId);
});

test('F-05: once shared, Blueprint sees it in Artist gigs', async () => {
  await ok('artistOn', 'PATCH', `/artists/${artistId}/gigs/${gig.gigId}`, { shared: true });
  const all = await ok<{ gigs: Gig[] }>('admin', 'GET', '/gigs');
  expect(ids(all.gigs)).toContain(gig.gigId);
});

test('F-11: another artist can’t see it', async () => {
  const res = await call('artistOther', 'GET', `/artists/${artistId}/gigs`);
  expect([403, 404]).toContain(res.status);
});

test('F-10: a gig is cancelled, not deleted', async () => {
  const done = await ok<Gig>('admin', 'PATCH', `/artists/${artistId}/gigs/${gig.gigId}`, {
    status: 'cancelled',
  });
  expect(done.status).toBe('cancelled');
});

// ── More of script F, on gigs of their own; all are cancelled at the end ──

interface FullGig extends Gig {
  deal: string;
  dealNote?: string;
  plannedBy: 'artist' | 'bmg';
  checklist: { id: string; title: string; done: boolean }[];
  money?: {
    ticketsSold: number;
    takingsCents: number;
    merchTakingsCents: number;
    costs: { id: string; label: string; amountCents: number }[];
  };
  help?: { status: 'open' | 'done'; topics: string[]; text: string };
}

const extra: FullGig[] = [];
const gigPath = (g: Gig) => `/artists/${artistId}/gigs/${g.gigId}`;
const newGig = async (as: 'artistOn' | 'admin', body: Record<string, unknown>) => {
  const g = await ok<FullGig>(as, 'POST', `/artists/${artistId}/gigs`, {
    date: inAMonth(),
    ...body,
  });
  extra.push(g);
  return g;
};

test('F-02: the deal description is kept for "Other" only', async () => {
  const fee = await newGig('artistOn', {
    title: tag('fee gig'),
    deal: 'fee',
    dealNote: 'should be dropped',
    shared: false,
  });
  expect(fee.deal).toBe('fee');
  expect(fee.dealNote).toBeUndefined();
  const other = await ok<FullGig>('artistOn', 'PATCH', gigPath(fee), {
    deal: 'other',
    dealNote: 'Bar tab and a door split',
  });
  expect(other.dealNote).toBe('Bar tab and a door split');
});

test('F-03: a late gig can end after midnight', async () => {
  const late = await newGig('artistOn', {
    title: tag('late gig'),
    startTime: '22:00',
    endTime: '02:00',
    shared: false,
  });
  expect(late.startTime).toBe('22:00');
  expect(late.endTime).toBe('02:00');
  // An end time needs a start time.
  const res = await call('artistOn', 'PATCH', gigPath(late), { startTime: null });
  expect(res.status).toBe(400);
});

test('F-06: asking for help shares the gig; Blueprint closes the request', async () => {
  const g = await newGig('artistOn', { title: tag('gig needing help'), shared: false });
  // Only the artist asks (and Blueprint can't see the gig until it's shared).
  expect([403, 404]).toContain(
    (await call('admin', 'PATCH', gigPath(g), { askHelp: { topics: ['promo'], text: 'x' } }))
      .status,
  );
  const asked = await ok<FullGig>('artistOn', 'PATCH', gigPath(g), {
    askHelp: { topics: ['promo', 'budget'], text: 'Help with promo please' },
  });
  expect(asked.shared).toBe(true);
  expect(asked.help?.status).toBe('open');
  const help = await ok<{ gigs: Gig[] }>('admin', 'GET', '/gigs?filter=help');
  expect(ids(help.gigs)).toContain(g.gigId);
  const closed = await ok<FullGig>('admin', 'PATCH', gigPath(g), { helpDone: true });
  expect(closed.help?.status).toBe('done');
  expect(ids((await ok<{ gigs: Gig[] }>('admin', 'GET', '/gigs?filter=help')).gigs)).not.toContain(
    g.gigId,
  );
  expect((await call('admin', 'PATCH', gigPath(g), { helpDone: true })).status).toBe(403);
});

test('F-07, F-08: money and the checklist save, and the artist sees the same figures', async () => {
  const g = await newGig('artistOn', { title: tag('gig with money'), shared: true });
  expect(g.checklist.length).toBeGreaterThan(0);
  const money = {
    ticketsSold: 40,
    takingsCents: 80_000,
    merchTakingsCents: 15_000,
    costs: [
      { id: 'p1', label: 'Venue', amountCents: 30_000 },
      { id: 'p7', label: 'Merchandise', amountCents: 5_000 },
    ],
  };
  const saved = await ok<FullGig>('admin', 'PATCH', gigPath(g), { money });
  expect(saved.money).toEqual(money);
  const checklist = g.checklist.map((c, i) => ({ ...c, done: i === 0 }));
  await ok('admin', 'PATCH', gigPath(g), { checklist });
  const theirs = (
    await ok<{ gigs: FullGig[] }>('artistOn', 'GET', `/artists/${artistId}/gigs`)
  ).gigs.find((x) => x.gigId === g.gigId)!;
  expect(theirs.money).toEqual(money);
  expect(theirs.checklist[0]?.done).toBe(true);
  // Two cost rows with one id is refused.
  const dup = await call('admin', 'PATCH', gigPath(g), {
    money: { ...money, costs: [money.costs[0], money.costs[0]] },
  });
  expect(dup.status).toBe(400);
});

test('F-12: Artist gigs filters upcoming and past', async () => {
  const g = extra.find((x) => x.shared) ?? (await newGig('artistOn', { title: tag('filter gig') }));
  const upcoming = await ok<{ gigs: Gig[] }>('admin', 'GET', '/gigs?filter=upcoming');
  expect(ids(upcoming.gigs)).toContain(g.gigId);
  const past = await ok<{ gigs: Gig[] }>('admin', 'GET', '/gigs?filter=past');
  expect(ids(past.gigs)).not.toContain(g.gigId);
  // A cancelled gig counts as past.
  await ok('artistOn', 'PATCH', gigPath(g), { status: 'cancelled' });
  expect(ids((await ok<{ gigs: Gig[] }>('admin', 'GET', '/gigs?filter=past')).gigs)).toContain(
    g.gigId,
  );
});

test('gigs Blueprint adds are always shared, and only the artist decides sharing', async () => {
  const g = await newGig('admin', { title: tag('Blueprint-added gig'), shared: false });
  expect(g.shared).toBe(true);
  expect(g.plannedBy).toBe('bmg');
  expect((await call('artistOn', 'PATCH', gigPath(g), { shared: false })).status).toBe(403);
  const mine = extra.find((x) => x.plannedBy === 'artist' && x.shared)!;
  expect((await call('admin', 'PATCH', gigPath(mine), { shared: false })).status).toBe(403);
});

test('rev 19: a Humanitix event that isn’t in the picker’s account is refused', async () => {
  for (const as of ['artistOn', 'admin'] as const) {
    const res = await call(as, 'POST', `/artists/${artistId}/gigs`, {
      title: tag('Humanitix link'),
      date: inAMonth(),
      humanitixEventId: 'e2e-not-a-real-event',
    });
    expect(res.status, as).toBe(409);
    const id = (res.data as { gigId?: string }).gigId;
    if (id) extra.push({ gigId: id } as FullGig);
  }
});

test.afterAll(async () => {
  for (const g of extra)
    await call('admin', 'PATCH', `/artists/${artistId}/gigs/${g.gigId}`, { status: 'cancelled' });
});
