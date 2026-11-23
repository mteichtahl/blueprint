/**
 * Consultation requests (rev 21). Anyone can ask Blueprint for a
 * consultation on the public form (/consult); every Blueprint person is told,
 * and one of them picks it up. Pure: the form's rules, the status rules and
 * what a request looks like to the app, all unit-tested.
 *
 *   Open ──Pick up──▶ In progress ──Mark converted──▶ Converted (an artist)
 *     ▲                 │  ▲    │                         │
 *     └────Hand back────┘  │    └──Close──▶ Closed        │
 *                          └──────────Reopen──────────────┘ (and from Closed)
 *
 * Personal details (name, email, phone, both answers) are sealed under the
 * platform key (./seal.ts); only the status fields are stored in the clear.
 */
import { isCountryCode } from '@bmg/config/countries';
import { z } from 'zod';

export const ENQUIRIES_PK = 'ORG#enquiries';
export const enquirySk = (id: string) => `ENQ#${id}`;
export const noteSk = (id: string, noteId: string) => `ENQ#${id}#NOTE#${noteId}`;
export const activitySk = (id: string, actId: string) => `ENQ#${id}#ACT#${actId}`;
/** One per address and day: the same person sending again is added to their first request. */
export const dedupeSk = (hash: string) => `DEDUPE#${hash}`;

export const ENQUIRY_STATUSES = ['open', 'in-progress', 'converted', 'closed'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const CLOSE_REASONS = ['not-a-fit', 'no-reply', 'duplicate', 'spam', 'other'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];
export const CLOSE_REASON_LABEL: Record<CloseReason, string> = {
  'not-a-fit': 'Not a fit right now',
  'no-reply': 'No reply',
  duplicate: 'Duplicate',
  spam: 'Spam',
  other: 'Other',
};

/** Closed requests are deleted a year after closing; converted ones after two. */
export const CLOSED_KEEP_SECONDS = 365 * 24 * 3600;
export const CONVERTED_KEEP_SECONDS = 2 * 365 * 24 * 3600;
/** The same address within a day becomes one request (up to this many sends). */
export const DEDUPE_WINDOW_SECONDS = 24 * 3600;
export const MAX_SENDS_PER_DAY = 3;
/** Sends allowed from one network an hour (the WAF and the CAPTCHA come first). */
export const SENDS_PER_IP_PER_HOUR = 5;
/** A form filled in faster than this is a bot. */
export const MIN_FILL_MS = 3000;
export const ANSWER_MAX = 2000;

// ── The public form ───────────────────────────────────────────────────────
const answer = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `Tell us ${what}.`)
    .max(ANSWER_MAX, `Keep it under ${ANSWER_MAX.toLocaleString('en-AU')} characters.`);

export const EnquiryBody = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Add your name.')
    .max(100, 'Keep your name under 100 characters.')
    // It goes into notification titles and email subjects: one line, no control characters.
    .regex(/^[^\p{Cc}]+$/u, 'Add your name on one line.'),
  email: z
    .string()
    .trim()
    .max(254, 'That email is too long.')
    .pipe(z.email('Add an email we can reply to.')),
  /** ISO 3166-1 alpha-2, e.g. AU. */
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Choose your country.'),
  /** E.164, e.g. +61412345678. Optional. */
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'Check your mobile number.')
    .optional(),
  aboutMe: answer('a little about yourself'),
  howCanWeHelp: answer('how Blueprint can help'),
  /** Hidden from people; bots fill it in. */
  website: z.string().max(500).optional(),
  /** Milliseconds the form was open before sending. */
  elapsedMs: z.number().int().nonnegative().max(86_400_000).optional(),
});
export type EnquiryBody = z.infer<typeof EnquiryBody>;

/** True when the send looks like a bot: the hidden field filled in, or sent too fast. */
export const looksLikeABot = (b: Pick<EnquiryBody, 'website' | 'elapsedMs'>): boolean =>
  !!b.website?.trim() || (b.elapsedMs !== undefined && b.elapsedMs < MIN_FILL_MS);

const regionNames = new Intl.DisplayNames(['en-AU'], { type: 'region', fallback: 'code' });
/** "Australia" for AU; the code itself when it isn't a country. */
export const countryName = (code: string): string => {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
};
/** A real country or territory code (ISO 3166-1, plus Kosovo). */
export const isCountry = (code: string): boolean => isCountryCode(code);

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

// ── What's stored ─────────────────────────────────────────────────────────
/** The sealed part: everything that identifies the person. */
export interface EnquiryPrivate {
  name: string;
  email: string;
  phone?: string;
  aboutMe: string;
  howCanWeHelp: string;
}

/** The enquiry item (ORG#enquiries / ENQ#<id>). */
export interface EnquiryItem {
  enquiryId: string;
  status: EnquiryStatus;
  country: string;
  receivedAt: string;
  updatedAt: string;
  /** Who has it (In progress, and kept on Converted and Closed). */
  ownerSub?: string;
  pickedUpAt?: string;
  artistId?: string;
  convertedAt?: string;
  closedReason?: CloseReason;
  closedAt?: string;
  /** Times the same person sent the form again within a day. */
  resends?: number;
  /** Bumped on every change; status changes are conditional on it. */
  version: number;
  sealed: Uint8Array;
  ttl?: number;
}

export interface NoteItem {
  noteId: string;
  enquiryId: string;
  bySub: string;
  at: string;
  sealed: Uint8Array;
}

export const ACTIVITY_KINDS = [
  'received',
  'sentAgain',
  'pickedUp',
  'handedBack',
  'takenOver',
  'converted',
  'closed',
  'reopened',
  'edited',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityItem {
  actId: string;
  enquiryId: string;
  kind: ActivityKind;
  /** Absent for the person who sent the form. */
  bySub?: string;
  at: string;
  /** Who it was taken from, the artist, or the close reason. */
  fromSub?: string;
  artistId?: string;
  reason?: CloseReason;
}

// ── Status rules ──────────────────────────────────────────────────────────
export type EnquiryAction =
  | { kind: 'pick-up' }
  | { kind: 'hand-back' }
  | { kind: 'take-over' }
  | { kind: 'convert'; artistId: string }
  | { kind: 'close'; reason: CloseReason }
  | { kind: 'reopen' };

export interface Actor {
  sub: string;
  admin: boolean;
}

export class RuleError extends Error {
  constructor(
    readonly status: 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** The fields an action changes (plus the activity line it adds), or a RuleError. */
export interface Change {
  set: Partial<EnquiryItem>;
  remove: (keyof EnquiryItem)[];
  activity: Omit<ActivityItem, 'actId' | 'enquiryId' | 'at'>;
}

/**
 * Who may do what, and what it changes. `ownerName` words the refusal when
 * someone else already has it ("Sam picked this up a moment ago").
 */
export function applyAction(
  e: Pick<EnquiryItem, 'status' | 'ownerSub'>,
  action: EnquiryAction,
  actor: Actor,
  now: Date,
  ownerName = 'Someone',
): Change {
  const at = now.toISOString();
  const mine = e.ownerSub === actor.sub;
  const nowS = Math.floor(now.getTime() / 1000);
  switch (action.kind) {
    case 'pick-up':
      if (e.status === 'in-progress')
        throw new RuleError(
          409,
          mine ? 'You already have this.' : `${ownerName} picked this up a moment ago.`,
        );
      if (e.status !== 'open')
        throw new RuleError(409, 'Only an open request can be picked up. Reopen it instead.');
      return {
        set: { status: 'in-progress', ownerSub: actor.sub, pickedUpAt: at },
        remove: [],
        activity: { kind: 'pickedUp', bySub: actor.sub },
      };
    case 'hand-back':
      if (e.status !== 'in-progress') throw new RuleError(409, 'Only a request in progress.');
      if (!mine) throw new RuleError(403, 'Only the person who has it can hand it back.');
      return {
        set: { status: 'open' },
        remove: ['ownerSub', 'pickedUpAt'],
        activity: { kind: 'handedBack', bySub: actor.sub },
      };
    case 'take-over':
      if (!actor.admin) throw new RuleError(403, 'Only an admin can take over a request.');
      if (e.status !== 'in-progress') throw new RuleError(409, 'Only a request in progress.');
      if (mine) throw new RuleError(409, 'You already have this.');
      return {
        set: { ownerSub: actor.sub, pickedUpAt: at },
        remove: [],
        activity: {
          kind: 'takenOver',
          bySub: actor.sub,
          ...(e.ownerSub ? { fromSub: e.ownerSub } : {}),
        },
      };
    case 'convert':
      if (e.status !== 'in-progress')
        throw new RuleError(409, 'Pick it up first, then mark it converted.');
      if (!mine) throw new RuleError(403, `${ownerName} has this request.`);
      return {
        set: {
          status: 'converted',
          artistId: action.artistId,
          convertedAt: at,
          ttl: nowS + CONVERTED_KEEP_SECONDS,
        },
        remove: ['closedReason', 'closedAt'],
        activity: { kind: 'converted', bySub: actor.sub, artistId: action.artistId },
      };
    case 'close':
      if (e.status === 'closed') throw new RuleError(409, 'It’s already closed.');
      if (e.status === 'converted') throw new RuleError(409, 'Reopen it first.');
      // Open requests can be closed by anyone (spam); a picked-up one by whoever has it, or an admin.
      if (e.status === 'in-progress' && !mine && !actor.admin)
        throw new RuleError(403, `${ownerName} has this request.`);
      return {
        set: {
          status: 'closed',
          closedReason: action.reason,
          closedAt: at,
          ttl: nowS + CLOSED_KEEP_SECONDS,
          ...(e.ownerSub ? {} : { ownerSub: actor.sub }),
        },
        remove: [],
        activity: { kind: 'closed', bySub: actor.sub, reason: action.reason },
      };
    case 'reopen':
      if (e.status !== 'closed' && e.status !== 'converted')
        throw new RuleError(409, 'Only a closed or converted request can be reopened.');
      if (e.status === 'converted' && !mine && !actor.admin)
        throw new RuleError(403, `${ownerName} has this request.`);
      return {
        set: { status: 'in-progress', ownerSub: actor.sub, pickedUpAt: at },
        remove: ['closedReason', 'closedAt', 'artistId', 'convertedAt', 'ttl'],
        activity: { kind: 'reopened', bySub: actor.sub },
      };
  }
}

export const ActionBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pick-up') }),
  z.object({ kind: z.literal('hand-back') }),
  z.object({ kind: z.literal('take-over') }),
  z.object({
    kind: z.literal('convert'),
    artistId: z.string().regex(/^art_[a-z0-9]{10,32}$/, 'Choose an artist.'),
  }),
  z.object({ kind: z.literal('close'), reason: z.enum(CLOSE_REASONS) }),
  z.object({ kind: z.literal('reopen') }),
]);

export const NoteBody = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Write a note first.')
    .max(2000, 'Keep notes under 2,000 characters.'),
});

/** Edit details: typos in the contact details. The answers stay as they were sent. */
export const EnquiryPatch = z
  .object({
    name: EnquiryBody.shape.name.optional(),
    email: EnquiryBody.shape.email.optional(),
    country: EnquiryBody.shape.country.optional(),
    phone: z.union([EnquiryBody.shape.phone, z.literal(null)]).optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'Nothing to change.');

// ── What the app sees ─────────────────────────────────────────────────────
export interface EnquirySummary {
  enquiryId: string;
  status: EnquiryStatus;
  name: string;
  email: string;
  country: string;
  countryName: string;
  receivedAt: string;
  updatedAt: string;
  ownerSub?: string;
  ownerName?: string;
  artistId?: string;
  closedReason?: CloseReason;
  resends: number;
}

export interface EnquiryDetail extends EnquirySummary {
  phone?: string;
  aboutMe: string;
  howCanWeHelp: string;
  pickedUpAt?: string;
  convertedAt?: string;
  closedAt?: string;
  notes: { noteId: string; bySub: string; byName: string; at: string; text: string }[];
  activity: (ActivityItem & { byName?: string; fromName?: string })[];
}

export function summaryOf(
  e: EnquiryItem,
  p: Pick<EnquiryPrivate, 'name' | 'email'>,
  ownerName?: string,
): EnquirySummary {
  return {
    enquiryId: e.enquiryId,
    status: e.status,
    name: p.name,
    email: p.email,
    country: e.country,
    countryName: countryName(e.country),
    receivedAt: e.receivedAt,
    updatedAt: e.updatedAt,
    ...(e.ownerSub ? { ownerSub: e.ownerSub } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(e.artistId ? { artistId: e.artistId } : {}),
    ...(e.closedReason ? { closedReason: e.closedReason } : {}),
    resends: e.resends ?? 0,
  };
}

/** Counts for the menu badge and Studio HQ, without opening anything sealed. */
export function counts(
  items: Pick<EnquiryItem, 'status' | 'ownerSub' | 'receivedAt' | 'convertedAt'>[],
  sub: string,
  now: Date,
) {
  const open = items.filter((e) => e.status === 'open');
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString();
  return {
    open: open.length,
    inProgress: items.filter((e) => e.status === 'in-progress').length,
    mine: items.filter((e) => e.status === 'in-progress' && e.ownerSub === sub).length,
    convertedRecently: items.filter(
      (e) => e.status === 'converted' && (e.convertedAt ?? '') >= ninetyDaysAgo,
    ).length,
    oldestOpenAt: open.map((e) => e.receivedAt).sort()[0] ?? null,
  };
}

/** Whole business days (Mon–Fri, Melbourne) a request has waited. */
export function businessDaysWaiting(receivedAt: string, now: Date): number {
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(d);
  const weekday = (d: Date) =>
    new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short' }).format(
      d,
    );
  let n = 0;
  const start = new Date(receivedAt);
  const today = day(now);
  for (
    let t = start.getTime() + 24 * 3600 * 1000;
    day(new Date(t)) <= today;
    t += 24 * 3600 * 1000
  ) {
    if (!['Sat', 'Sun'].includes(weekday(new Date(t)))) n += 1;
    if (n > 60) break;
  }
  return n;
}
