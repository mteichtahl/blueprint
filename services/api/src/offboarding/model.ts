import { z } from 'zod';

/**
 * Deleting an artist (rev 22). Pure parts: the request body, the steps, what
 * is counted and archived, and what happens to each of the artist's chats.
 *
 * The record lives at `ORG#deletions / DEL#<artistId>` (listed through GSI1
 * `DELETIONS`), because everything under `ARTIST#<id>` is archived and then
 * removed. It keeps the artist's name for Blueprint admins (the Deleted list);
 * everywhere else in the app they become "Former artist".
 */

export const DELETE_REASONS = ['left', 'asked', 'duplicate', 'other'] as const;
export type DeleteReason = (typeof DELETE_REASONS)[number];
export const REASON_LABELS: Record<DeleteReason, string> = {
  left: 'Left Blueprint',
  asked: 'Asked to be deleted',
  duplicate: 'Duplicate or test account',
  other: 'Other',
};

/** Decision 3: archives are kept for 7 years, then removed by the bucket's lifecycle rule. */
export const RETENTION_YEARS = 7;
export const RETENTION_DAYS = 2557;
/** Object tag that puts an archived copy under that lifecycle rule. */
export const ARCHIVE_TAG = { key: 'bmg-archive', value: 'artist-deletion' } as const;

/** Upcoming gigs inside this many days need a second tick to delete anyway. */
export const UPCOMING_DAYS = 7;

/** The step-up window for deleting: a sign-in in the last 5 minutes. */
export const DELETE_STEP_UP_SECONDS = 300;

export const DeleteBody = z
  .object({
    /** The artist's name, typed again. Case and extra spaces are ignored. */
    confirmName: z.string().max(200),
    reason: z.enum(DELETE_REASONS),
    /** Optional words for "Other" (or any reason). Blueprint only; never emailed. */
    note: z.string().trim().max(500).optional(),
    /** Email them that their account was closed (off by default, decision 7). */
    emailArtist: z.boolean().default(false),
    /** Needed when they have a gig in the next 7 days. */
    acknowledgeUpcoming: z.boolean().default(false),
  })
  .strict();
export type DeleteRequest = z.infer<typeof DeleteBody>;

const fold = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
export const nameMatches = (typed: string, name: string) =>
  fold(name) !== '' && fold(typed) === fold(name);

/** The workflow, in order. Each step can run again safely (a retry starts at the paused one). */
export const STEPS = ['ai', 'archive', 'unlink', 'remove', 'login', 'done'] as const;
export type Step = (typeof STEPS)[number];
export const STEP_LABELS: Record<Step, string> = {
  ai: 'Remove them from the knowledge base',
  archive: 'Archive their data and files',
  unlink: 'Take them out of chats, sharing and assignments',
  remove: 'Delete their live data and files',
  login: 'Delete their login',
  done: 'Finished',
};
export const nextStep = (s: Step): Step => STEPS[Math.min(STEPS.indexOf(s) + 1, STEPS.length - 1)]!;

export type DeletionStatus = 'running' | 'paused' | 'done';

/** A library document that still mentions or is shared with the artist (for review). */
export interface Mention {
  fileId: string;
  name: string;
  why: 'name' | 'shared';
}

export interface DeletionRecord {
  artistId: string;
  /** Unique per deletion: names the archive folder. */
  deletionId: string;
  displayName: string;
  /** Every name they've had that we know of (used to look for mentions). */
  names: string[];
  reason: DeleteReason;
  note?: string;
  emailArtist: boolean;
  email?: string;
  /** The artist's Cognito sub, once found (their USER# items and consent). */
  sub?: string;
  by: string;
  byName: string;
  startedAt: string;
  status: DeletionStatus;
  step: Step;
  stepsDone: Step[];
  finishedAt?: string;
  error?: string;
  counts: Counts;
  archive?: { bucket: string; prefix: string; objects: number; bytes: number; items: number };
  retainUntil?: string;
  mentions: Mention[];
}

export const deletionKey = (artistId: string) => ({ PK: 'ORG#deletions', SK: `DEL#${artistId}` });
export const DELETIONS_GSI1PK = 'DELETIONS';

/** Where the archive goes: inside the artist's own prefix, so it keeps their key (see decisions). */
export const archivePrefix = (artistId: string, deletionId: string) =>
  `artists/${artistId}/archive/${deletionId}/`;
export const livePrefix = (artistId: string) => `artists/${artistId}/`;
/** Live objects are everything under the artist's prefix except earlier archives. */
export const isLiveObject = (artistId: string, key: string) =>
  key.startsWith(livePrefix(artistId)) && !key.startsWith(`${livePrefix(artistId)}archive/`);
/** The file an object belongs to (`artists/<id>/files/<fileId>[.v2][thumb]`), if any. */
export function fileIdOf(artistId: string, key: string): string | undefined {
  const rest = key.startsWith(`${livePrefix(artistId)}files/`)
    ? key.slice(`${livePrefix(artistId)}files/`.length)
    : undefined;
  return rest ? /^([a-z0-9]{10,40})/.exec(rest)?.[1] : undefined;
}
export const archivedObjectKey = (artistId: string, deletionId: string, key: string) =>
  `${archivePrefix(artistId, deletionId)}files/${key.slice(livePrefix(artistId).length)}`;

export function retainUntil(from: Date): string {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + RETENTION_DAYS);
  return d.toISOString().slice(0, 10);
}

// ── What's counted (the confirm screen and the manifest) ──

export interface Counts {
  files: number;
  chats: number;
  plan: number;
  todos: number;
  gigs: number;
  submissions: number;
  meetings: number;
  other: number;
}
export const emptyCounts = (): Counts => ({
  files: 0,
  chats: 0,
  plan: 0,
  todos: 0,
  gigs: 0,
  submissions: 0,
  meetings: 0,
  other: 0,
});

/** Counts an artist's items by what they are, from their sort keys. */
export function countItems(sks: string[], chats: number): Counts {
  const c = emptyCounts();
  c.chats = chats;
  for (const sk of sks) {
    if (sk.startsWith('FILE#')) c.files++;
    else if (sk === 'PLAN') c.plan++;
    else if (sk.startsWith('TODO#') && !sk.includes('#C#') && !/^TODO#[^#]+#/.test(sk)) c.todos++;
    else if (sk.startsWith('GIG#') && !/^GIG#[^#]+#/.test(sk)) c.gigs++;
    else if (sk.startsWith('SUB#') && !/^SUB#[^#]+#/.test(sk)) c.submissions++;
    else if (sk.startsWith('MEETING#') && !/^MEETING#[^#]+#/.test(sk)) c.meetings++;
    else if (
      !sk.startsWith('TODO#') &&
      !sk.startsWith('GIG#') &&
      !sk.startsWith('SUB#') &&
      !sk.startsWith('MEETING#')
    )
      c.other++;
  }
  return c;
}

/** Gigs that are on in the next `UPCOMING_DAYS` days and not cancelled. */
export function upcomingGigs(
  gigs: { gigId?: unknown; title?: unknown; date?: unknown; status?: unknown }[],
  now: Date,
): { gigId: string; title: string; date: string }[] {
  const today = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + UPCOMING_DAYS * 86_400_000).toISOString().slice(0, 10);
  return gigs
    .filter(
      (g) =>
        typeof g.date === 'string' &&
        g.date >= today &&
        g.date <= end &&
        g.status !== 'cancelled' &&
        g.status !== 'idea',
    )
    .map((g) => ({ gigId: String(g.gigId), title: String(g.title ?? 'Gig'), date: String(g.date) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Chats ──

/**
 * What happens to each conversation the artist is in:
 * - `archive-remove`: their chat with Blueprint. Archived, then removed for everyone.
 * - `archive-close`: a private chat with another artist. Archived still sealed;
 *   the other artist keeps a read-only copy (decision 4).
 * - `leave`: groups and announcements. They're taken out; past messages stay,
 *   shown as "Former artist".
 * - `skip`: the all-artists broadcast and anything that isn't theirs.
 */
export type ChatAction = 'archive-remove' | 'archive-close' | 'leave' | 'skip';
export function chatAction(artistId: string, conversationId: string, type: string): ChatAction {
  if (type === 'bmg-artist' && conversationId === `dm-${artistId}`) return 'archive-remove';
  if (
    type === 'artist-to-artist' &&
    conversationId.startsWith('aa-') &&
    conversationId.includes(artistId)
  )
    return 'archive-close';
  if (type === 'group' || type === 'announcement') return 'leave';
  return 'skip';
}

/** Removes one id from a list, saying whether it was there. */
export function without<T>(list: readonly T[] | undefined, id: T): { list: T[]; changed: boolean } {
  const before = list ?? [];
  const after = before.filter((x) => x !== id);
  return { list: after, changed: after.length !== before.length };
}

/** Mentions of the artist in a library document's name or title, or a share with them. */
export function mentionFor(
  f: { fileId: string; name?: string; title?: string; sharedWithArtistIds?: string[] },
  artistId: string,
  names: string[],
): Mention | undefined {
  const label = String(f.title ?? f.name ?? 'Document');
  const text = `${f.title ?? ''} ${f.name ?? ''}`.toLocaleLowerCase('en');
  const byName = names
    .map((n) => n.trim().toLocaleLowerCase('en'))
    .filter((n) => n.length >= 3)
    .some((n) => text.includes(n));
  if (byName) return { fileId: f.fileId, name: label, why: 'name' };
  if ((f.sharedWithArtistIds ?? []).includes(artistId))
    return { fileId: f.fileId, name: label, why: 'shared' };
  return undefined;
}

/** What the Deleted list and the deletion page show (never the archive's contents). */
export function publicDeletion(r: DeletionRecord) {
  return {
    artistId: r.artistId,
    deletionId: r.deletionId,
    displayName: r.displayName,
    reason: r.reason,
    reasonLabel: REASON_LABELS[r.reason],
    note: r.note ?? null,
    byName: r.byName,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
    status: r.status,
    step: r.step,
    stepLabel: STEP_LABELS[r.step],
    stepNumber: STEPS.indexOf(r.step) + 1,
    stepCount: STEPS.length,
    stepsDone: r.stepsDone,
    error: r.error ?? null,
    counts: r.counts,
    archive: r.archive
      ? {
          prefix: r.archive.prefix,
          objects: r.archive.objects,
          items: r.archive.items,
          bytes: r.archive.bytes,
        }
      : null,
    retainUntil: r.retainUntil ?? null,
    mentions: r.mentions,
  };
}
