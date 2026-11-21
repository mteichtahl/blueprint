import type { Gig } from '../events/model.ts';
import type { HumanitixEvent } from './vendors.ts';

/**
 * Rev 19: picking a Humanitix event on the gig form. Pure, so the rules are
 * unit-tested; the gigs handler loads the lists and calls this.
 *
 * - An artist links a gig to one of their own Humanitix events.
 * - Blueprint links a gig to one of Blueprint's own Humanitix events (stored
 *   on the gig as `humanitixAccount: 'bmg'`), never the artist's: Blueprint
 *   doesn't see the artist's event list (rev 18).
 * - Blueprint can't change or remove a link to the artist's account. The
 *   artist can unlink any of their gigs.
 * - The event must be in that account's own list (this closes rev 18's gap,
 *   where only the id's format was checked).
 * - One event links to one gig at a time (cancelled gigs don't count).
 */

export type LinkAccount = 'artist' | 'bmg';

/** Where each account's Humanitix event list is kept, written by the sync. */
export const HUMANITIX_EVENTS_SK = 'HUMANITIX#events';

/** Which account a gig's Humanitix link belongs to. */
export const linkAccountOf = (g: Pick<Gig, 'humanitixAccount'>): LinkAccount =>
  g.humanitixAccount === 'bmg' ? 'bmg' : 'artist';

export function checkHumanitixLink(input: {
  isArtist: boolean;
  /** The gig being edited; absent when creating one. */
  gig?: Pick<Gig, 'gigId' | 'humanitixEventId' | 'humanitixAccount'>;
  /** The new event id, or null to unlink. */
  eventId: string | null;
  /** The picker's account's own events (the artist's, or Blueprint's). */
  ownEvents: readonly Pick<HumanitixEvent, 'id'>[] | undefined;
  /** The artist's other gigs, to keep one event on one gig. */
  gigs: readonly Pick<Gig, 'gigId' | 'title' | 'status' | 'humanitixEventId'>[];
}): string | undefined {
  const { isArtist, gig, eventId } = input;
  const current = gig?.humanitixEventId;
  if (eventId === (current ?? null)) return undefined; // nothing changes
  if (!isArtist && current && linkAccountOf(gig!) === 'artist')
    return "This gig is linked to the artist's own Humanitix account, so only the artist can change it";
  if (eventId === null) return undefined;
  const whose = isArtist ? 'your' : "Blueprint's";
  if (!input.ownEvents)
    return `Humanitix isn't connected for ${isArtist ? 'you' : 'Blueprint'}, or hasn't synced yet`;
  if (!input.ownEvents.some((e) => e.id === eventId))
    return `That event isn't in ${whose} Humanitix account. Refresh the list and pick it again`;
  const taken = input.gigs.find(
    (g) => g.gigId !== gig?.gigId && g.status !== 'cancelled' && g.humanitixEventId === eventId,
  );
  if (taken) return `That Humanitix event is already linked to ${taken.title}`;
  return undefined;
}
