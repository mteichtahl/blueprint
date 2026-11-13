import { z } from 'zod';
import type { Todo } from './model.ts';

/**
 * To-dos artists send their plan owner (rev 15). Pure rules, unit-tested; the
 * workspace handler loads the plan, the owner's settings and the to-dos.
 *
 * - Only the plan owner: artists can't pick any other Blueprint person.
 * - The owner can turn it off, and caps the open to-dos each artist can send
 *   them (default 10), with a different cap for one artist if they like
 *   (a release week, say). No minimum and no nudges: it only limits.
 * - The owner (or an admin) can send one back with a reason.
 */

export const DEFAULT_MAX_OPEN = 10;
export const MAX_OPEN_LIMIT = 50;

const ArtistId = z.string().regex(/^art_[a-z0-9]{10,32}$/);
const Max = z
  .number()
  .int()
  .min(1, 'Allow at least 1 open to-do')
  .max(MAX_OPEN_LIMIT, `Allow at most ${MAX_OPEN_LIMIT} open to-dos`);

/** Profile › To-dos from artists (Blueprint only). */
export const ArtistTodosSettings = z
  .object({
    enabled: z.boolean(),
    maxOpenPerArtist: Max,
    /** A different maximum for some artists, e.g. during a release week. */
    perArtist: z.record(ArtistId, Max).default({}),
  })
  .strict()
  .refine((s) => Object.keys(s.perArtist).length <= 200, 'Too many artists');
export type ArtistTodosSettings = z.infer<typeof ArtistTodosSettings>;

export const DEFAULT_SETTINGS: ArtistTodosSettings = {
  enabled: true,
  maxOpenPerArtist: DEFAULT_MAX_OPEN,
  perArtist: {},
};

/** Kept beside the person's profile, not in it, so profile lists never carry it. */
export const settingsKey = (sub: string) => ({ PK: `USER#${sub}`, SK: 'ARTIST_TODOS' });

/** Stored settings, with defaults for anything missing or malformed. */
export function settingsFrom(item: Record<string, unknown> | undefined): ArtistTodosSettings {
  if (!item) return DEFAULT_SETTINGS;
  const parsed = ArtistTodosSettings.safeParse({
    enabled: item.enabled,
    maxOpenPerArtist: item.maxOpenPerArtist,
    perArtist: item.perArtist ?? {},
  });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export interface Limit {
  /** Whether this artist can send their owner to-dos at all. */
  enabled: boolean;
  max: number;
  /** The artist's own maximum (not the owner's general one). */
  custom: boolean;
}

/**
 * What applies to this artist. With no owner the to-do goes to the Blueprint
 * team: always on, at the default maximum, so artists can always reach Blueprint.
 */
export function limitFor(
  settings: ArtistTodosSettings | undefined,
  artistId: string,
  hasOwner: boolean,
): Limit {
  if (!hasOwner || !settings) return { enabled: true, max: DEFAULT_MAX_OPEN, custom: false };
  const own = settings.perArtist[artistId];
  return {
    enabled: settings.enabled,
    max: own ?? settings.maxOpenPerArtist,
    custom: own !== undefined,
  };
}

type T = Pick<Todo, 'done' | 'assignee' | 'sentBack' | 'source' | 'bmgOwnerSub'>;

/** Sent to Blueprint by the artist, and still waiting (not done, not sent back). */
export const isOpenForBmg = (t: T) =>
  t.assignee === 'bmg' && t.source === 'artist' && !t.done && !t.sentBack;

/** This artist's open to-dos for this owner (or for the team, with no owner). */
export function openFor(todos: readonly T[], ownerSub: string | undefined): number {
  return todos.filter((t) => isOpenForBmg(t) && (t.bmgOwnerSub ?? undefined) === ownerSub).length;
}

/**
 * Why the artist can't send another one, in plain words, or null if they can.
 * `ownerName` is "Kyra", or undefined for the Blueprint team.
 */
export function refusal(limit: Limit, open: number, ownerName: string | undefined): string | null {
  const who = ownerName ?? 'Blueprint';
  if (!limit.enabled) {
    return `${who} isn't taking to-dos in the app right now. Message ${ownerName ? 'them' : 'Blueprint'} in Chat.`;
  }
  if (open >= limit.max) {
    return `${who} has ${open} open to-do${open === 1 ? '' : 's'} from you. You can add more when one is done or sent back.`;
  }
  return null;
}

/** Who can send a to-do back: the person looking after it, or a Blueprint admin. */
export function canSendBack(
  role: 'artist' | 'bmg-admin' | 'bmg-staff',
  sub: string,
  todo: Pick<Todo, 'bmgOwnerSub'>,
): boolean {
  if (role === 'bmg-admin') return true;
  return role === 'bmg-staff' && todo.bmgOwnerSub === sub;
}

export const SEND_BACK_REASON_MAX = 500;
