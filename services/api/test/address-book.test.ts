import { describe, expect, it } from 'vitest';
import {
  applyContactPatch,
  cleanTags,
  ContactBody,
  contactFor,
  contactMatches,
  ContactPatch,
  findDuplicate,
  normalisePhone,
  applyVenuePatch,
  findDuplicateVenue,
  VenueBody,
  venueFor,
  venueMatches,
  VenuePatch,
  venuesUsing,
  type Contact,
  type Venue,
} from '../src/address-book/model.ts';
import { routeOf } from '../src/handlers/address-book.ts';

const base = (over: Partial<Contact> = {}): Contact => ({
  ...ContactBody.parse({ firstName: 'Sam', lastName: 'Lee' }),
  contactId: 'c0000000001',
  createdBy: 'u-staff',
  createdByRole: 'bmg',
  createdAt: '2026-11-10T00:00:00Z',
  ...over,
});

describe('contacts', () => {
  it('needs a first name and checks email, phone and links', () => {
    expect(ContactBody.safeParse({ firstName: '' }).success).toBe(false);
    expect(ContactBody.safeParse({ firstName: 'A', email: 'nope' }).success).toBe(false);
    expect(ContactBody.safeParse({ firstName: 'A', phone: '12' }).success).toBe(false);
    expect(ContactBody.safeParse({ firstName: 'A', linkedin: 'linkedin.com/x' }).success).toBe(
      false,
    );
    const ok = ContactBody.parse({
      firstName: 'Ava',
      email: 'ava@venue.com.au',
      phone: '0412 345 678',
      linkedin: 'https://www.linkedin.com/in/ava',
    });
    expect(ok.tags).toEqual([]);
    expect(ok.bmgNotes).toBe('');
  });

  it('patches only carry what was sent', () => {
    const p = ContactPatch.parse({ jobTitle: 'Booker' });
    expect(p).toEqual({ jobTitle: 'Booker' });
    expect(ContactPatch.safeParse({}).success).toBe(false);
    expect(ContactPatch.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('finds the same person by email (any case) or phone (any spacing)', () => {
    const all = [
      base({ contactId: 'c1', email: 'Ava@Venue.com.au' }),
      base({ contactId: 'c2', phone: '+61 412 345 678' }),
      base({ contactId: 'c3', email: 'old@x.com', archived: true }),
    ];
    expect(findDuplicate(all, { email: 'ava@venue.com.au', phone: '' })?.contactId).toBe('c1');
    expect(findDuplicate(all, { email: '', phone: '+61412345678' })?.contactId).toBe('c2');
    expect(findDuplicate(all, { email: 'ava@venue.com.au', phone: '' }, 'c1')).toBeUndefined();
    expect(findDuplicate(all, { email: 'old@x.com', phone: '' })).toBeUndefined();
    expect(normalisePhone('(03) 9123-4567')).toBe('0391234567');
  });

  it('never shows Blueprint notes to artists', () => {
    const c = base({ bmgNotes: 'Pays late' });
    expect(contactFor(c, true, false).bmgNotes).toBe('Pays late');
    expect('bmgNotes' in contactFor(c, false, false)).toBe(false);
    expect(contactFor(c, false, false).canEdit).toBe(false);
    expect(contactFor(c, false, true).canEdit).toBe(true);
  });

  it("doesn't let an artist change Blueprint notes", () => {
    const c = base({ bmgNotes: 'keep' });
    expect(applyContactPatch(c, { bmgNotes: 'x', jobTitle: 'Booker' }, false)).toMatchObject({
      bmgNotes: 'keep',
      jobTitle: 'Booker',
    });
    expect(applyContactPatch(c, { bmgNotes: 'x' }, true).bmgNotes).toBe('x');
  });

  it('searches names, organisations, tags and phone digits', () => {
    const c = base({
      organisation: 'The Corner Hotel',
      tags: ['Venue booker'],
      phone: '0412 345 678',
    });
    expect(contactMatches(c, 'corner')).toBe(true);
    expect(contactMatches(c, 'sam lee')).toBe(true);
    expect(contactMatches(c, '345')).toBe(true);
    expect(contactMatches(c, 'zzz')).toBe(false);
    expect(contactMatches(c, '', 'venue booker')).toBe(true);
    expect(contactMatches(c, '', 'Crew')).toBe(false);
  });

  it('tidies tags', () => {
    expect(cleanTags([' Crew', 'crew', '', 'Media'])).toEqual(['Crew', 'Media']);
  });

  it('routes proxy paths', () => {
    expect(routeOf('GET', '/contacts')).toEqual({ route: 'GET /contacts', id: '' });
    expect(routeOf('PATCH', '/contacts/abc123/')).toEqual({
      route: 'PATCH /contacts/:id',
      id: 'abc123',
    });
  });
});

describe('venues', () => {
  const venue = (over: Partial<Venue> = {}): Venue => ({
    ...VenueBody.parse({ name: 'The Corner Hotel', suburb: 'Richmond', capacity: 800 }),
    venueId: 'v0000000001',
    createdBy: 'u-a',
    createdByRole: 'artist',
    createdAt: '2026-11-10T00:00:00Z',
    ...over,
  });

  it('takes the brief fields with sensible defaults', () => {
    const v = VenueBody.parse({ name: 'Northcote Social Club' });
    expect(v).toMatchObject({ capacity: 0, backline: false, managerContactId: null });
    expect(VenueBody.safeParse({ name: '' }).success).toBe(false);
    expect(VenueBody.safeParse({ name: 'X', capacity: -1 }).success).toBe(false);
    expect(VenueBody.safeParse({ name: 'X', managerContactId: 'Bob' }).success).toBe(false);
    expect(VenuePatch.parse({ backline: true })).toEqual({ backline: true });
  });

  it('shows the manager and booker as contact cards, without Blueprint notes for artists', () => {
    const sam = { ...ContactBody.parse({ firstName: 'Sam', email: 's@x.com' }) } as Contact;
    Object.assign(sam, { contactId: 'c1', createdBy: 'u', createdByRole: 'bmg', createdAt: '' });
    const v = venue({ managerContactId: 'c1', bookerContactId: 'gone', bmgNotes: 'secret' });
    const out = venueFor(v, false, true, new Map([['c1', sam]]));
    expect(out.manager).toMatchObject({ name: 'Sam', email: 's@x.com' });
    expect(out.booker).toBeNull();
    expect('bmgNotes' in out).toBe(false);
    expect(venueFor(v, true, false, new Map()).bmgNotes).toBe('secret');
  });

  it('filters by name, capacity and backline', () => {
    const v = venue({ backline: true });
    expect(venueMatches(v, { q: 'corner' })).toBe(true);
    expect(venueMatches(v, { q: 'richmond' })).toBe(true);
    expect(venueMatches(v, { minCapacity: 500, maxCapacity: 1000 })).toBe(true);
    expect(venueMatches(v, { maxCapacity: 300 })).toBe(false);
    expect(venueMatches(v, { backline: false })).toBe(false);
  });

  it('spots the same venue typed differently', () => {
    const all = [venue()];
    expect(findDuplicateVenue(all, { name: 'corner hotel', suburb: '' })).toBeDefined();
    expect(
      findDuplicateVenue(all, { name: 'The Corner Hotel', suburb: 'Fitzroy' }),
    ).toBeUndefined();
    expect(
      findDuplicateVenue(all, { name: 'Corner Hotel', suburb: '' }, 'v0000000001'),
    ).toBeUndefined();
  });

  it('knows which venues use a contact', () => {
    const all = [venue({ bookerContactId: 'c1' }), venue({ venueId: 'v2' })];
    expect(venuesUsing(all, 'c1')).toHaveLength(1);
  });

  it('keeps Blueprint notes away from artist edits', () => {
    expect(applyVenuePatch(venue({ bmgNotes: 'k' }), { bmgNotes: 'x' }, false).bmgNotes).toBe('k');
  });
});
