import { describe, expect, it } from 'vitest';
import {
  countVenueBookings,
  applyContactPatch,
  cleanTags,
  ContactBody,
  contactFor,
  contactMatches,
  ContactPatch,
  contactVisible,
  findDuplicate,
  sharingOf,
  venueContactId,
  withVenueContact,
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
      tags: ['Venue contact'],
      phone: '0412 345 678',
    });
    expect(contactMatches(c, 'corner')).toBe(true);
    expect(contactMatches(c, 'sam lee')).toBe(true);
    expect(contactMatches(c, '345')).toBe(true);
    expect(contactMatches(c, 'zzz')).toBe(false);
    expect(contactMatches(c, '', 'venue contact')).toBe(true);
    expect(contactMatches(c, '', 'Crew')).toBe(false);
  });

  it('keeps an artist’s contact to themselves until they share it (rev 18)', () => {
    expect(ContactBody.parse({ firstName: 'A' }).sharing).toBe('private');
    const mine = base({ createdBy: 'u-art', createdByRole: 'artist', sharing: 'private' });
    const me = { sub: 'u-art', isBmg: false };
    const other = { sub: 'u-other', isBmg: false };
    const staff = { sub: 'u-staff2', isBmg: true };
    expect(contactVisible(mine, me)).toBe(true);
    expect(contactVisible(mine, other)).toBe(false);
    expect(contactVisible(mine, staff)).toBe(false);
    const withBmg = { ...mine, sharing: 'bmg' as const };
    expect(contactVisible(withBmg, staff)).toBe(true);
    expect(contactVisible(withBmg, other)).toBe(false);
    expect(contactVisible({ ...mine, sharing: 'all' }, other)).toBe(true);
    // Blueprint's contacts, and artists' contacts from before rev 18, are shared.
    expect(contactVisible(base({ sharing: 'private' }), other)).toBe(true);
    const older = base({ createdBy: 'u-art', createdByRole: 'artist' });
    delete (older as Partial<Contact>).sharing;
    expect(sharingOf(older)).toBe('all');
    expect(contactFor(mine, false, true)).toMatchObject({ sharing: 'private', mine: true });
  });

  it('lets only the artist who added a contact change who sees it', () => {
    const mine = base({ createdBy: 'u-art', createdByRole: 'artist', sharing: 'private' });
    expect(applyContactPatch(mine, { sharing: 'bmg' }, false, true).sharing).toBe('bmg');
    expect(applyContactPatch(mine, { sharing: 'all' }, true, false).sharing).toBe('private');
    expect(applyContactPatch(base(), { sharing: 'private' }, true, true).sharing).toBe('private');
    expect(sharingOf(applyContactPatch(base(), { sharing: 'private' }, true, true))).toBe('all');
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
    expect(v).toMatchObject({ capacity: 0, backline: false, contactId: null });
    expect(VenueBody.safeParse({ name: '' }).success).toBe(false);
    expect(VenueBody.safeParse({ name: 'X', capacity: -1 }).success).toBe(false);
    expect(VenueBody.safeParse({ name: 'X', contactId: 'Bob' }).success).toBe(false);
    // Rev 18: no more manager and booker.
    expect(VenueBody.safeParse({ name: 'X', managerContactId: null }).success).toBe(false);
    expect(VenuePatch.parse({ backline: true })).toEqual({ backline: true });
  });

  it('shows the venue contact as a card, without Blueprint notes for artists', () => {
    const sam = { ...ContactBody.parse({ firstName: 'Sam', email: 's@x.com' }) } as Contact;
    Object.assign(sam, { contactId: 'c1', createdBy: 'u', createdByRole: 'bmg', createdAt: '' });
    const v = venue({ contactId: 'c1', bmgNotes: 'secret' });
    const out = venueFor(v, false, true, new Map([['c1', sam]]));
    expect(out.contact).toMatchObject({ name: 'Sam', email: 's@x.com' });
    expect('manager' in out || 'booker' in out).toBe(false);
    expect('bmgNotes' in out).toBe(false);
    expect(venueFor(venue({ contactId: 'gone' }), true, false, new Map()).contact).toBeNull();
    expect(venueFor(v, true, false, new Map()).bmgNotes).toBe('secret');
  });

  it('reads an older venue’s manager (or else booker) as its contact, and drops both on save', () => {
    const old = venue({ managerContactId: 'c1', bookerContactId: 'c2' });
    delete (old as Partial<Venue>).contactId;
    expect(venueContactId(old)).toBe('c1');
    expect(venueContactId({ bookerContactId: 'c2' } as Venue)).toBe('c2');
    const moved = withVenueContact(old);
    expect(moved.contactId).toBe('c1');
    expect('managerContactId' in moved || 'bookerContactId' in moved).toBe(false);
    // Clearing the contact clears the old roles too.
    expect(applyVenuePatch(old, { contactId: null }, true).contactId).toBeNull();
  });

  it('hides a venue contact the viewer can’t see', () => {
    const priv = { ...ContactBody.parse({ firstName: 'Pat' }) } as Contact;
    Object.assign(priv, {
      contactId: 'c9',
      createdBy: 'u-art',
      createdByRole: 'artist',
      createdAt: '',
      sharing: 'private',
    });
    const v = venue({ contactId: 'c9' });
    const people = new Map([['c9', priv]]);
    expect(venueFor(v, false, true, people, 'u-art').contact).toMatchObject({ name: 'Pat' });
    expect(venueFor(v, true, false, people, 'u-staff').contact).toBeNull();
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
    const all = [
      venue({ contactId: 'c1' }),
      venue({ venueId: 'v2' }),
      venue({ venueId: 'v3', contactId: null, bookerContactId: 'c1' }),
    ];
    expect(venuesUsing(all, 'c1')).toHaveLength(2);
  });

  it('keeps Blueprint notes away from artist edits', () => {
    expect(applyVenuePatch(venue({ bmgNotes: 'k' }), { bmgNotes: 'x' }, false).bmgNotes).toBe('k');
  });
});

describe('venue booking counts', () => {
  it('counts booked, confirmed and played gigs plus events, by venue', () => {
    const counts = countVenueBookings(
      [
        { venueId: 'v1', status: 'played' },
        { venueId: 'v1', status: 'booked' },
        { venueId: 'v1', status: 'idea' },
        { venueId: 'v1', status: 'cancelled' },
        { venueId: 'v2', status: 'confirmed' },
        { status: 'played' },
      ],
      [{ venueId: 'v1' }, { venueId: 'v3' }, {}],
    );
    expect(counts.get('v1')).toBe(3);
    expect(counts.get('v2')).toBe(1);
    expect(counts.get('v3')).toBe(1);
    expect(counts.has('v4')).toBe(false);
  });
});
