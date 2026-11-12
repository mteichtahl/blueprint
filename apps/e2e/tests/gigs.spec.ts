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
