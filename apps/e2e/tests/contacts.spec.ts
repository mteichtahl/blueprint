import { expect, test } from '@playwright/test';
import { RUN_ID, tag } from '../src/accounts.ts';
import { call, ok } from '../src/api.ts';

/**
 * UAT script H: the shared contacts list. Blueprint's notes never reach
 * artists, artists change only what they added, duplicates are caught. The
 * list is shared with real people, so every contact made here is deleted.
 */

interface Contact {
  contactId: string;
  firstName: string;
  bmgNotes?: string;
}

test.describe.configure({ mode: 'serial' });

const stamp = RUN_ID.replace(/\W+/g, '-').toLowerCase();
const email = `bmg-e2e-${stamp}@example.com`;
const NOTE = 'E2E secret note for Blueprint only';
const made: string[] = [];
let contact: Contact;

test('H-04: Blueprint adds a contact with a private note', async () => {
  contact = await ok<Contact>('admin', 'POST', '/contacts', {
    firstName: 'E2E',
    lastName: tag('contact'),
    email,
    bmgNotes: NOTE,
  });
  made.push(contact.contactId);
  expect(contact.bmgNotes).toBe(NOTE);
});

test('H-05: the artist sees the contact but not the note', async () => {
  const res = await call('artistOn', 'GET', `/contacts/${contact.contactId}`);
  expect(res.status).toBe(200);
  expect(JSON.stringify(res.data)).not.toContain(NOTE);
  const listed = await call('artistOn', 'GET', `/contacts?q=${encodeURIComponent(email)}`);
  expect(JSON.stringify(listed.data)).not.toContain(NOTE);
});

test('H-03: the artist can’t change a contact Blueprint added', async () => {
  const res = await call('artistOn', 'PATCH', `/contacts/${contact.contactId}`, {
    firstName: 'E2E',
  });
  expect(res.status).toBe(403);
});

test('H-02: the same email can’t be added twice', async () => {
  const res = await call('artistOn', 'POST', '/contacts', { firstName: 'Copy', email });
  expect(res.status).toBe(409);
  const id = (res.data as { contactId?: string }).contactId;
  if (id && id !== contact.contactId) made.push(id);
});

test('an artist’s own contact is private until they share it (rev 18)', async () => {
  const mine = await ok<Contact & { sharing: string }>('artistOn', 'POST', '/contacts', {
    firstName: 'E2E',
    lastName: tag('artist contact'),
  });
  made.push(mine.contactId);
  expect(mine.sharing).toBe('private');
  expect(
    (await call('artistOn', 'PATCH', `/contacts/${mine.contactId}`, { jobTitle: 'Booker' })).status,
  ).toBe(200);
  // Nobody else can see it, not even Blueprint.
  expect((await call('artistOther', 'GET', `/contacts/${mine.contactId}`)).status).toBe(404);
  expect((await call('admin', 'GET', `/contacts/${mine.contactId}`)).status).toBe(404);
  // Shared with Blueprint: Blueprint sees it, other artists still don't.
  expect(
    (await call('artistOn', 'PATCH', `/contacts/${mine.contactId}`, { sharing: 'bmg' })).status,
  ).toBe(200);
  expect((await call('admin', 'GET', `/contacts/${mine.contactId}`)).status).toBe(200);
  expect((await call('artistOther', 'GET', `/contacts/${mine.contactId}`)).status).toBe(404);
  // Shared with everyone: another artist sees it but can't change it.
  expect(
    (await call('artistOn', 'PATCH', `/contacts/${mine.contactId}`, { sharing: 'all' })).status,
  ).toBe(200);
  expect(
    (await call('artistOther', 'PATCH', `/contacts/${mine.contactId}`, { jobTitle: 'X' })).status,
  ).toBe(403);
  // The artist can remove what they added.
  expect((await call('artistOn', 'DELETE', `/contacts/${mine.contactId}`)).status).toBe(200);
  made.splice(made.indexOf(mine.contactId), 1);
});

test.afterAll(async () => {
  for (const id of made) await call('admin', 'DELETE', `/contacts/${id}`);
});
