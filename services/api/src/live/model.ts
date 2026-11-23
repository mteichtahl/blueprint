/**
 * Live updates (rev 17): every change to the main table is turned into a
 * small nudge on the realtime channels of the people who can see it, so open
 * screens refetch without a page reload. Nudges carry a topic and, for artist
 * data, the artist id — never item ids or content. Clients always refetch
 * through the API, which applies the access rules as usual.
 */
import { artistChannel } from '../channels.ts';

/** What changed, as screens listen for it. */
export type LiveTopic =
  | 'todos'
  | 'gigs'
  | 'plan'
  | 'files'
  | 'reviews'
  | 'meetings'
  | 'artists'
  | 'contacts'
  | 'venues'
  | 'events';

export interface LiveNudge {
  topic: LiveTopic;
  artistId?: string;
  channels: string[];
}

const BMG = '/inbox/bmg';
const ALL_ARTISTS = '/inbox/all-artists';

/** Items under ARTIST#<id>, by the first part of their sort key. */
const ARTIST_TOPICS: Record<string, LiveTopic> = {
  TODO: 'todos',
  TODOC: 'todos',
  GIG: 'gigs',
  PLAN: 'plan',
  PLANLOG: 'plan',
  STAGE: 'plan',
  FILE: 'files',
  FOLDER: 'files',
  SUB: 'reviews',
  MEETING: 'meetings',
  PROFILE: 'artists',
  CONTACT: 'artists',
  AVATAR: 'artists',
};

/** Shared Blueprint lists, by partition key, and who hears about them. */
const ORG_TOPICS: Record<string, { topic: LiveTopic; artists: boolean }> = {
  'ORG#contacts': { topic: 'contacts', artists: true },
  'ORG#venues': { topic: 'venues', artists: true },
  'ORG#library': { topic: 'files', artists: true },
  'ORG#events': { topic: 'events', artists: false },
  'ORG#meetings': { topic: 'meetings', artists: false },
};

// The stream filter (infra/lib/notify-stack.ts, LIVE_PK_PREFIXES) passes only
// ARTIST#, ORG#, EVENT#, INVITE# and REVIEW# items; keep the two in step.

/** The nudge for one changed item, or undefined when nobody's screen shows it. */
export function nudgeFor(pk: string, sk: string): LiveNudge | undefined {
  if (pk.startsWith('ARTIST#')) {
    const artistId = pk.slice('ARTIST#'.length);
    const topic = ARTIST_TOPICS[sk.split('#')[0] ?? ''];
    if (!artistId || !topic) return undefined;
    return { topic, artistId, channels: [artistChannel(artistId), BMG] };
  }
  const org = ORG_TOPICS[pk];
  if (org) return { topic: org.topic, channels: org.artists ? [BMG, ALL_ARTISTS] : [BMG] };
  if (pk.startsWith('EVENT#')) return { topic: 'events', channels: [BMG] };
  if (pk.startsWith('INVITE#')) return { topic: 'artists', channels: [BMG] };
  if (pk.startsWith('REVIEW#')) return { topic: 'reviews', channels: [BMG] };
  return undefined;
}

/**
 * One nudge per channel and topic for a whole batch of changes, so saving a
 * plan with twenty to-dos sends one message, not twenty.
 */
export function nudgesFor(keys: ReadonlyArray<{ pk: string; sk: string }>): LiveNudge[] {
  const seen = new Map<string, LiveNudge>();
  for (const { pk, sk } of keys) {
    const n = nudgeFor(pk, sk);
    if (!n) continue;
    const id = `${n.topic}|${n.artistId ?? ''}`;
    const prev = seen.get(id);
    if (prev) prev.channels = [...new Set([...prev.channels, ...n.channels])];
    else seen.set(id, n);
  }
  return [...seen.values()];
}
