/**
 * Messages and groups (design 7.1 "Messaging", 9.3 "Messages"; screens:
 * Messages & groups, workspace Chat tab, artist Chats). Pure: ids, access
 * rules, schemas and message sealing, all unit-tested.
 *
 * Conversation types:
 * - `bmg-artist`: Blueprint and one artist (one per artist, id `dm-<artistId>`).
 * - `group`: Blueprint and the artists it picked.
 * - `broadcast`: Blueprint to all artists (one, id `broadcast`); artists read.
 * - `artist-to-artist`: two artists. Blueprint can't read it: its key is
 *   wrapped only under the two artists' keys with `visibility=private`, which
 *   KMS refuses to every BMG role (design 9.1, 9.3).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export type ConversationType = 'bmg-artist' | 'group' | 'broadcast' | 'artist-to-artist';
export type Role = 'artist' | 'bmg-admin' | 'bmg-staff';

export interface Conversation {
  conversationId: string;
  type: ConversationType;
  /** Groups only. */
  title?: string;
  /** Artists in the conversation (empty for the broadcast, which reaches all artists). */
  artistIds: string[];
  /** Wrapped conversation key: `platform` for chats with Blueprint, else per artist. */
  keyWraps: Record<string, Uint8Array>;
  createdBy: string;
  createdAt: string;
  lastMessageAt?: string;
}

export interface Viewer {
  role: Role;
  artistId?: string;
  /** Staff only. */
  assignedArtistIds?: readonly string[];
}

export const BROADCAST_ID = 'broadcast';
const ARTIST = 'art_[a-z0-9]{10,32}';
export const CONVERSATION_ID_PATTERN = new RegExp(
  `^(broadcast|dm-${ARTIST}|aa-${ARTIST}-${ARTIST}|grp-[a-z0-9]{10,40})$`,
);

export const directId = (artistId: string) => `dm-${artistId}`;
/** The same two artists always share one chat, whoever starts it. */
export const artistPairId = (a: string, b: string) => `aa-${[a, b].sort().join('-')}`;

// ── Keys in the main table ────────────────────────────────────────────────
export const convPk = (id: string) => `CONV#${id}`;
export const CONV_META = 'META';
export const messageSk = (at: string, messageId: string) => `MSG#${at}#${messageId}`;
/** Inbox members: Blueprint shares one inbox; each artist has their own. */
export const BMG_MEMBER = 'BMG';
export const artistMember = (artistId: string) => `ARTIST#${artistId}`;
export const inboxPk = (member: string) => `INBOX#${member}`;
export const inboxSk = (conversationId: string) => `CONV#${conversationId}`;

/** Inbox members of a conversation (the broadcast reaches artists without inbox rows). */
export function members(c: Pick<Conversation, 'type' | 'artistIds'>): string[] {
  const artists = c.artistIds.map(artistMember);
  return c.type === 'artist-to-artist' ? artists : [BMG_MEMBER, ...artists];
}

/** Realtime channels to nudge when a conversation changes (payload: ids only). */
export function channelsFor(c: Pick<Conversation, 'type' | 'artistIds'>): string[] {
  if (c.type === 'broadcast') return ['/inbox/bmg', '/inbox/all-artists'];
  const artists = c.artistIds.map((id) => `/inbox/artist-${id}`);
  return c.type === 'artist-to-artist' ? artists : ['/inbox/bmg', ...artists];
}

// ── Access (design 6.3) ───────────────────────────────────────────────────
export type Access = 'read-write' | 'read' | 'none';

export function access(viewer: Viewer, c: Pick<Conversation, 'type' | 'artistIds'>): Access {
  if (viewer.role === 'artist') {
    if (c.type === 'broadcast') return 'read';
    return viewer.artistId && c.artistIds.includes(viewer.artistId) ? 'read-write' : 'none';
  }
  // Artist-to-artist chats stay private to their two members.
  if (c.type === 'artist-to-artist') return 'none';
  if (viewer.role === 'bmg-admin') return 'read-write';
  // Staff: the broadcast, and chats whose artists are all assigned to them.
  if (c.type === 'broadcast') return 'read-write';
  const assigned = viewer.assignedArtistIds ?? [];
  return c.artistIds.length > 0 && c.artistIds.every((id) => assigned.includes(id))
    ? 'read-write'
    : 'none';
}

// ── Requests ──────────────────────────────────────────────────────────────
const ArtistId = z.string().regex(new RegExp(`^${ARTIST}$`));

export const NewConversation = z.discriminatedUnion('kind', [
  /** A direct chat: BMG ↔ artist, or artist ↔ artist. */
  z.object({ kind: z.literal('direct'), artistId: ArtistId.optional() }),
  z.object({
    kind: z.literal('group'),
    title: z.string().trim().min(1, 'Name the group').max(80),
    artistIds: z.array(ArtistId).min(1, 'Pick at least one artist').max(100),
  }),
]);

export const NewMessage = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Write a message')
    .max(4000, 'Messages are limited to 4,000 characters'),
});

/**
 * Who starts what:
 * - BMG `direct` with an artist → that artist's `dm-` chat.
 * - Artist `direct` with no artist → their chat with Blueprint.
 * - Artist `direct` with another artist → their shared private chat.
 * - Groups are created by BMG only (artist groups are off, screens doc).
 */
export function planConversation(
  viewer: Viewer,
  req: z.infer<typeof NewConversation>,
):
  | {
      ok: true;
      conversationId: string;
      type: ConversationType;
      artistIds: string[];
      title?: string;
    }
  | { ok: false; reason: string } {
  if (req.kind === 'group') {
    if (viewer.role === 'artist') return { ok: false, reason: 'Groups are created by Blueprint' };
    const artistIds = [...new Set(req.artistIds)].sort();
    return { ok: true, conversationId: '', type: 'group', artistIds, title: req.title };
  }
  if (viewer.role === 'artist') {
    const me = viewer.artistId;
    if (!me) return { ok: false, reason: 'No artist on this account' };
    if (!req.artistId)
      return { ok: true, conversationId: directId(me), type: 'bmg-artist', artistIds: [me] };
    if (req.artistId === me) return { ok: false, reason: 'Pick another artist' };
    const pair = [me, req.artistId].sort();
    return {
      ok: true,
      conversationId: artistPairId(me, req.artistId),
      type: 'artist-to-artist',
      artistIds: pair,
    };
  }
  if (!req.artistId) return { ok: false, reason: 'Pick an artist' };
  return {
    ok: true,
    conversationId: directId(req.artistId),
    type: 'bmg-artist',
    artistIds: [req.artistId],
  };
}

// ── Sealing messages with the conversation key (AES-256-GCM) ─────────────
export function newConversationKey(): Buffer {
  return randomBytes(32);
}

/** iv (12) ‖ tag (16) ‖ ciphertext; the conversation and message ids are bound as AAD. */
export function seal(
  key: Uint8Array,
  text: string,
  conversationId: string,
  messageId: string,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${conversationId}|${messageId}`));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function open(
  key: Uint8Array,
  blob: Uint8Array,
  conversationId: string,
  messageId: string,
): string {
  const b = Buffer.from(blob);
  const decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${conversationId}|${messageId}`));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
}

/** KMS encryption context for a wrapped conversation key. */
export function wrapContext(conversationId: string, artistId?: string): Record<string, string> {
  return artistId
    ? { artistId, visibility: 'private', conversationId }
    : { purpose: 'conversation-key', conversationId };
}
