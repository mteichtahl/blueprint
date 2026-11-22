import { expect, test } from '@playwright/test';
import { RUN_ID, tag } from '../src/accounts.ts';
import { call, ok } from '../src/api.ts';

/**
 * UAT script H (venues) and rev 18: one shared venues list. Duplicates are
 * caught, Blueprint's notes stay with Blueprint, artists change only what they
 * added, only Blueprint archives, and a venue's single contact is shown only
 * to people who can see that contact. The list is shared with real people,
 * so every venue and contact made here is deleted at the end. Logo lookups
 * are off (no website), so nothing is fetched from the internet.
 */

interface Venue {
  venueId: string;
  name: string;
  suburb: string;
  canEdit: boolean;
  archived: boolean;
  bmgNotes?: string;
  contact: { contactId: string } | null;
}

test.describe.configure({ mode: 'serial' });

const stamp = RUN_ID.replace(/\W+/g, ' ').trim();
const NOTE = 'E2E venue note for Blueprint only';
const SUBURB = 'E2E Town';
const venues: string[] = [];
const contacts: string[] = [];
let bmgVenue: Venue;
let artistVenue: Venue;
let bmgContact: string;
let privateContact: string;

const listIds = async (as: 'admin' | 'artistOn', archived = false) =>
  (
    await ok<{ venues: Venue[] }>(
      as,
      'GET',
      `/venues?q=${encodeURIComponent(stamp)}${archived ? '&archived=true' : ''}`,
    )
  ).venues.map((v) => v.venueId);

test.beforeAll(async () => {
  bmgContact = (
    await ok<{ contactId: string }>('admin', 'POST', '/contacts', {
      firstName: 'E2E',
      lastName: tag('venue contact'),
      email: `bmg-e2e-venue-${stamp.replace(/\W+/g, '-').toLowerCase()}@example.com`,
    })
  ).contactId;
  contacts.push(bmgContact);
  privateContact = (
    await ok<{ contactId: string }>('artistOn', 'POST', '/contacts', {
      firstName: 'E2E',
      lastName: tag('artist’s own booker'),
    })
  ).contactId;
  contacts.push(privateContact);
});

test('H-11, rev 18: Blueprint adds a venue with one venue contact and a private note', async () => {
  bmgVenue = await ok<Venue>('admin', 'POST', '/venues', {
    name: `E2E Venue ${stamp}`,
    suburb: SUBURB,
    capacity: 250,
    autoLogo: false,
    contactId: bmgContact,
    bmgNotes: NOTE,
  });
  venues.push(bmgVenue.venueId);
  expect(bmgVenue.contact?.contactId).toBe(bmgContact);
  expect(bmgVenue.bmgNotes).toBe(NOTE);
  // The artist sees the venue and its contact, never the note.
  const theirs = await call<Venue>('artistOn', 'GET', `/venues/${bmgVenue.venueId}`);
  expect(theirs.status).toBe(200);
  expect(theirs.data.contact?.contactId).toBe(bmgContact);
  expect(theirs.data.canEdit).toBe(false);
  expect(JSON.stringify(theirs.data)).not.toContain(NOTE);
  const listed = await ok<{ venues: Venue[] }>(
    'artistOn',
    'GET',
    `/venues?q=${encodeURIComponent(stamp)}`,
  );
  expect(JSON.stringify(listed)).not.toContain(NOTE);
});

test('H-10: the same venue in the same suburb can’t be added twice', async () => {
  // "The", spacing and case don't make it a different venue.
  const res = await call<{ existing: Venue }>('artistOn', 'POST', '/venues', {
    name: `The e2e  venue ${stamp.toLowerCase()}`,
    suburb: SUBURB,
    autoLogo: false,
  });
  expect(res.status).toBe(409);
  expect(res.data.existing.venueId).toBe(bmgVenue.venueId);
  const id = (res.data as unknown as { venueId?: string }).venueId;
  if (id) venues.push(id);
});

test('H-13: an artist can’t change, archive or delete a venue they didn’t add', async () => {
  const path = `/venues/${bmgVenue.venueId}`;
  expect((await call('artistOn', 'PATCH', path, { capacity: 1 })).status).toBe(403);
  expect((await call('artistOn', 'PATCH', path, { archived: true })).status).toBe(403);
  expect((await call('artistOn', 'DELETE', path)).status).toBe(403);
});

test('rev 18: a venue never shows a contact the viewer can’t see', async () => {
  artistVenue = await ok<Venue>('artistOn', 'POST', '/venues', {
    name: `E2E Artist Venue ${stamp}`,
    suburb: SUBURB,
    autoLogo: false,
    contactId: privateContact,
  });
  venues.push(artistVenue.venueId);
  expect(artistVenue.canEdit).toBe(true);
  expect(artistVenue.contact?.contactId).toBe(privateContact);
  // The contact is the artist's own (not shared), so others see the venue without it.
  for (const as of ['artistOther', 'admin'] as const) {
    const seen = await ok<Venue>(as, 'GET', `/venues/${artistVenue.venueId}`);
    expect(seen.contact, as).toBeNull();
  }
  // The artist edits their own venue; another artist can't.
  expect(
    (await call('artistOn', 'PATCH', `/venues/${artistVenue.venueId}`, { capacity: 80 })).status,
  ).toBe(200);
  expect(
    (await call('artistOther', 'PATCH', `/venues/${artistVenue.venueId}`, { capacity: 1 })).status,
  ).toBe(403);
  // A contact someone can't see can't be put on their venue either.
  const other = await call<{ venueId?: string }>('artistOther', 'POST', '/venues', {
    name: `E2E Other Venue ${stamp}`,
    suburb: SUBURB,
    autoLogo: false,
    contactId: privateContact,
  });
  if (other.data.venueId) venues.push(other.data.venueId);
  expect(other.status).toBe(400);
});

test('H-12: Blueprint archives a venue, hiding it from artists, then restores it', async () => {
  const path = `/venues/${bmgVenue.venueId}`;
  expect((await ok<Venue>('admin', 'PATCH', path, { archived: true })).archived).toBe(true);
  expect(await listIds('artistOn')).not.toContain(bmgVenue.venueId);
  expect((await call('artistOn', 'GET', path)).status).toBe(404);
  expect(await listIds('admin')).not.toContain(bmgVenue.venueId);
  expect(await listIds('admin', true)).toContain(bmgVenue.venueId);
  await ok('admin', 'PATCH', path, { archived: false });
  expect(await listIds('artistOn')).toContain(bmgVenue.venueId);
});

test.afterAll(async () => {
  for (const id of venues) await call('admin', 'DELETE', `/venues/${id}`);
  for (const id of contacts) {
    // The artist removes their own; Blueprint removes the rest.
    const own = await call('artistOn', 'DELETE', `/contacts/${id}`);
    if (own.status !== 200) await call('admin', 'DELETE', `/contacts/${id}`);
  }
});
