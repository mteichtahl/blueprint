import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ContactBody, type Contact } from '../src/address-book/model.ts';
import { splitName, upsertPerson } from '../src/address-book/store.ts';
import { db } from '../src/lib.ts';

beforeAll(() => {
  process.env.MAIN_TABLE = 'test-main';
});
afterEach(() => vi.restoreAllMocks());

const contact = (over: Partial<Contact>): Contact => ({
  ...ContactBody.parse({ firstName: 'Ali', email: 'ali@x.com', phone: '0412 345 678' }),
  contactId: 'c0000000001',
  createdBy: 'u',
  createdByRole: 'bmg',
  createdAt: '2026-11-10T00:00:00Z',
  ...over,
});

describe('crew into contacts', () => {
  it('splits a full name', () => {
    expect(splitName('  Sam de Vries ')).toEqual({ firstName: 'Sam', lastName: 'de Vries' });
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });

  it('adds a new person, tagged', async () => {
    const send = vi.spyOn(db, 'send').mockResolvedValue({} as never);
    const known: Contact[] = [];
    const { contact: c, created } = await upsertPerson(
      { name: 'Jo Bloggs', email: 'jo@x.com', phone: '0400 000 001', tag: 'Volunteer' },
      { sub: 'u-staff', role: 'bmg' },
      known,
    );
    expect(created).toBe(true);
    expect(c).toMatchObject({ firstName: 'Jo', lastName: 'Bloggs', tags: ['Volunteer'] });
    expect(known).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('links an existing person by email and adds the tag once', async () => {
    const send = vi.spyOn(db, 'send').mockResolvedValue({} as never);
    const known = [contact({ tags: ['Venue booker'] })];
    const first = await upsertPerson(
      { name: 'Ali A', email: 'ALI@x.com', phone: '0499 999 999', tag: 'Crew' },
      { sub: 'u-staff', role: 'bmg' },
      known,
    );
    expect(first.created).toBe(false);
    expect(first.contact.tags).toEqual(['Venue booker', 'Crew']);
    const again = await upsertPerson(
      { name: 'Ali', email: 'ali@x.com', phone: '', tag: 'crew' },
      { sub: 'u-staff', role: 'bmg' },
      known,
    );
    expect(again.contact.contactId).toBe('c0000000001');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
