import { z } from 'zod';
import { patchOf } from '../events/model.ts';

/**
 * Contacts and venues (rev 7 change plan, WP1): one shared list for Blueprint
 * and its artists. Everyone signed in can search it, pick from it and add to it.
 * Artists can change only what they added; Blueprint manages everything.
 * `bmgNotes` is Blueprint's own and never leaves the API for an artist.
 */

export const CONTACTS_PK = 'ORG#contacts';
export const contactSk = (id: string) => `CONTACT#${id}`;

export const normaliseEmail = (email: string) => email.trim().toLowerCase();
/** Digits only (a leading + kept), for matching phone numbers typed differently. */
export const normalisePhone = (phone: string) => {
  const t = phone.trim();
  return (t.startsWith('+') ? '+' : '') + t.replace(/\D/g, '');
};

/** Tags offered in the app; any other short tag can be typed in. */
export const CONTACT_TAGS = [
  'Venue manager',
  'Venue booker',
  'Crew',
  'Volunteer',
  'Speaker',
  'Media',
  'Photographer',
  'Videographer',
  'Promoter',
  'Supplier',
  'Industry',
] as const;

const Text = (max: number) => z.string().trim().max(max);
const Url = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'Use a full link, starting https://');

export const ContactBody = z
  .object({
    firstName: z.string().trim().min(1, 'Add a first name').max(80),
    lastName: Text(80).default(''),
    jobTitle: Text(120).default(''),
    organisation: Text(160).default(''),
    email: z
      .union([z.literal(''), z.email('Use an email like name@example.com').max(200)])
      .default(''),
    phone: Text(40)
      .refine(
        (v) => v === '' || normalisePhone(v).replace('+', '').length >= 6,
        'Check the phone number',
      )
      .default(''),
    linkedin: Url.default(''),
    website: Url.default(''),
    instagram: Text(80).default(''),
    address: Text(300).default(''),
    tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
    /** Blueprint only. Ignored when an artist sends it. */
    bmgNotes: Text(2000).default(''),
  })
  .strict();
export type ContactInput = z.infer<typeof ContactBody>;

/**
 * A patch: any field, none filled in by default (defaults are dropped so a
 * patch only carries what was sent); Blueprint can also archive.
 */
export const ContactPatch = patchOf({ shape: { ...ContactBody.shape, archived: z.boolean() } });
export type ContactPatchInput = Partial<ContactInput> & { archived?: boolean };

export interface Contact extends ContactInput {
  contactId: string;
  createdBy: string;
  createdByRole: 'artist' | 'bmg';
  createdAt: string;
  updatedAt?: string;
  updatedBy?: string;
  /** Archived contacts are hidden from pickers but kept for history. */
  archived?: boolean;
}

export const fullName = (c: Pick<Contact, 'firstName' | 'lastName'>) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ');

/** Tidies tags: trimmed, unique (case-insensitive), in the order given. */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const v = t.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** What a contact looks like to the caller: artists never see Blueprint's notes. */
export function contactFor(c: Contact, isBmg: boolean, mine: boolean) {
  const out: Record<string, unknown> = {
    contactId: c.contactId,
    firstName: c.firstName,
    lastName: c.lastName,
    name: fullName(c),
    jobTitle: c.jobTitle,
    organisation: c.organisation,
    email: c.email,
    phone: c.phone,
    linkedin: c.linkedin,
    website: c.website,
    instagram: c.instagram,
    address: c.address,
    tags: c.tags,
    archived: !!c.archived,
    addedByArtist: c.createdByRole === 'artist',
    canEdit: isBmg || mine,
    createdAt: c.createdAt,
  };
  if (isBmg) out.bmgNotes = c.bmgNotes;
  return out;
}

/** Search across name, organisation, job title, email, phone and tags. */
export function contactMatches(c: Contact, q: string, tag?: string): boolean {
  if (tag && !c.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const phoneNeedle = normalisePhone(needle);
  const hay = [fullName(c), c.organisation, c.jobTitle, c.email, c.instagram, ...c.tags]
    .join(' ')
    .toLowerCase();
  if (hay.includes(needle)) return true;
  return phoneNeedle.replace('+', '').length >= 3 && normalisePhone(c.phone).includes(phoneNeedle);
}

export const byName = (a: Pick<Contact, 'firstName' | 'lastName'>, b: typeof a) =>
  fullName(a).localeCompare(fullName(b), 'en-AU', { sensitivity: 'base' });

/** Finds an existing contact that is the same person (email first, then phone). */
export function findDuplicate(
  all: readonly Contact[],
  input: Pick<ContactInput, 'email' | 'phone'>,
  exceptId?: string,
): Contact | undefined {
  const others = all.filter((c) => c.contactId !== exceptId && !c.archived);
  if (input.email) {
    const e = normaliseEmail(input.email);
    const byEmail = others.find((c) => c.email && normaliseEmail(c.email) === e);
    if (byEmail) return byEmail;
  }
  if (input.phone) {
    const p = normalisePhone(input.phone);
    if (p.replace('+', '').length >= 6)
      return others.find((c) => c.phone && normalisePhone(c.phone) === p);
  }
  return undefined;
}

/** Applies a patch; artists can't touch Blueprint's notes. */
export function applyContactPatch(c: Contact, patch: ContactPatchInput, isBmg: boolean): Contact {
  const next: Contact = { ...c };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'bmgNotes' && !isBmg) continue;
    (next as unknown as Record<string, unknown>)[k] = k === 'tags' ? cleanTags(v as string[]) : v;
  }
  return next;
}
