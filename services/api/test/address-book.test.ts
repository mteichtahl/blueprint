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
  type Contact,
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
