/**
 * Messages and groups (design 7.1 "Messaging", 9.3 "Messages"; screens:
 * Messages & groups, workspace Chat tab, artist Chats). Pure: ids, access
 * rules, schemas and message sealing, all unit-tested.
 *
 * Conversation types:
 * - `bmg-artist`: Blueprint and one artist (one per artist, id `dm-<artistId>`).
 * - `group`: Blueprint and the artists it picked.
 * - `broadcast`: Blueprint to all artists (one, id `broadcast`); artists read.
 *   Shown as the "All artists" announcement.
 * - `announcement`: Blueprint to chosen artists (id `ann-…`); artists read and
 *   reply privately in their Blueprint chat.
 * - `artist-to-artist`: two artists. Blueprint can't read it: its key is
 *   wrapped only under the two artists' keys with `visibility=private`, which
 *   KMS refuses to every BMG role (design 9.1, 9.3).
 * - `staff-direct`: two Blueprint staff (id `sd-<subA>-<subB>`, sorted; the
 *   same sub twice is "message yourself"). Rev 14.
 * - `staff-group`: Blueprint staff only (id `sg-…`), never artists. Rev 14.
 *   Team chats are private to their members: admins who aren't in one can't
 *   read it, and artists never can. Each member has their own inbox
 *   (`STAFF#<sub>`) and channel (`/inbox/staff-<sub>`) for them.
 */
import { DEFAULT_RULES, type AccessRules } from '../access/model.ts';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export type ConversationType =
  | 'bmg-artist'
  | 'group'
  | 'broadcast'
  | 'announcement'
  | 'artist-to-artist'
  | 'staff-direct'
  | 'staff-group';

/** Team chats (rev 14): Blueprint staff only. */
export const isStaffType = (t: ConversationType): t is 'staff-direct' | 'staff-group' =>
  t === 'staff-direct' || t === 'staff-group';

/** Team group settings (rev 14). */
export interface StaffGroupSettings {
  onlyAdminsSend: boolean;
  onlyAdminsEditInfo: boolean;
}
export const DEFAULT_STAFF_SETTINGS: StaffGroupSettings = {
  onlyAdminsSend: false,
  onlyAdminsEditInfo: false,
};
/** Most people in one team group. */
export const MAX_STAFF_GROUP = 50;

/** Group settings (Group info → Group settings). */
export interface GroupSettings {
  onlyAdminsSend: boolean;
  artistsShareFiles: boolean;
  artistsAddMembers: boolean;
}
export const DEFAULT_SETTINGS: GroupSettings = {
  onlyAdminsSend: false,
  artistsShareFiles: true,
  artistsAddMembers: false,
};
export type Role = 'artist' | 'bmg-admin' | 'bmg-staff';

export interface Conversation {
  conversationId: string;
  type: ConversationType;
  /** Groups and announcements. */
  title?: string;
  /** Groups and announcements; sealed with the conversation key (it's content). */
  descriptionCipher?: Uint8Array;
  /** Groups only. */
  settings?: GroupSettings;
  /** Team groups only (rev 14). */
  staffSettings?: StaffGroupSettings;
  /** Team chats (rev 14): the staff in it (Cognito subs). Empty otherwise. */
  staffSubs?: string[];
  /** Team groups (rev 14): group admins, always members. */
  admins?: string[];
  /** Set when Blueprint deletes a group or announcement. */
  deletedAt?: string;
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
  /** The person's Cognito sub (needed for team chats, rev 14). */
  sub?: string;
}

export const BROADCAST_ID = 'broadcast';
const ARTIST = 'art_[a-z0-9]{10,32}';
/** Cognito subs are UUIDs. */
const SUB = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const SUB_PATTERN = new RegExp(`^${SUB}$`);
export const CONVERSATION_ID_PATTERN = new RegExp(
  `^(broadcast|dm-${ARTIST}|aa-${ARTIST}-${ARTIST}|grp-[a-z0-9]{10,40}|ann-[a-z0-9]{10,40}|sd-${SUB}-${SUB}|sg-[a-z0-9]{10,40})$`,
);
/** Team chat ids, refused for artist sessions before any lookup. */
export const isStaffConversationId = (id: string) => id.startsWith('sd-') || id.startsWith('sg-');

export const directId = (artistId: string) => `dm-${artistId}`;
/** The same two artists always share one chat, whoever starts it. */
export const artistPairId = (a: string, b: string) => `aa-${[a, b].sort().join('-')}`;
/** The same two staff always share one chat; the same sub twice is "message yourself". */
export const staffPairId = (a: string, b: string) => `sd-${[a, b].sort().join('-')}`;

// ── Keys in the main table ────────────────────────────────────────────────
export const convPk = (id: string) => `CONV#${id}`;
export const CONV_META = 'META';
export const messageSk = (at: string, messageId: string) => `MSG#${at}#${messageId}`;
/** Inbox members: Blueprint shares one inbox; each artist has their own. */
export const BMG_MEMBER = 'BMG';
export const artistMember = (artistId: string) => `ARTIST#${artistId}`;
/** Each staff member's own inbox, for team chats only (rev 14). */
export const staffMember = (sub: string) => `STAFF#${sub}`;
export const staffChannel = (sub: string) => `/inbox/staff-${sub}`;
export const inboxPk = (member: string) => `INBOX#${member}`;
export const inboxSk = (conversationId: string) => `CONV#${conversationId}`;
/** When a member last opened the app (for "delivered" ticks and "last seen"). */
export const presenceKey = (member: string) => ({ PK: `PRESENCE#${member}`, SK: 'STATE' });

/** What the API calls each type: the all-artists broadcast is an announcement. */
export const publicType = (t: ConversationType) => (t === 'broadcast' ? 'announcement' : t);
const isAnnouncement = (t: ConversationType) => t === 'broadcast' || t === 'announcement';

/** Inbox members of a conversation (the broadcast reaches artists without inbox rows). */
export const isAnnouncementType = isAnnouncement;
export function members(c: Pick<Conversation, 'type' | 'artistIds' | 'staffSubs'>): string[] {
  if (isStaffType(c.type)) return [...new Set(c.staffSubs ?? [])].map(staffMember);
  const artists = c.artistIds.map(artistMember);
  return c.type === 'artist-to-artist' ? artists : [BMG_MEMBER, ...artists];
}

/** Realtime channels to nudge when a conversation changes (payload: ids only). */
export function channelsFor(c: Pick<Conversation, 'type' | 'artistIds' | 'staffSubs'>): string[] {
  if (isStaffType(c.type)) return [...new Set(c.staffSubs ?? [])].map(staffChannel);
  if (c.type === 'broadcast') return ['/inbox/bmg', '/inbox/all-artists'];
  if (c.type === 'announcement')
    return ['/inbox/bmg', ...c.artistIds.map((id) => `/inbox/artist-${id}`)];
  const artists = c.artistIds.map((id) => `/inbox/artist-${id}`);
  return c.type === 'artist-to-artist' ? artists : ['/inbox/bmg', ...artists];
}

// ── Access (design 6.3) ───────────────────────────────────────────────────
export type Access = 'read-write' | 'read' | 'none';

export function access(
  viewer: Viewer,
  c: Pick<Conversation, 'type' | 'artistIds' | 'staffSubs'>,
): Access {
  // Team chats: members only, whatever their role. Artists never; admins only if in it.
  if (isStaffType(c.type)) {
    if (viewer.role === 'artist' || !viewer.sub) return 'none';
    return (c.staffSubs ?? []).includes(viewer.sub) ? 'read-write' : 'none';
  }
  if (viewer.role === 'artist') {
    if (c.type === 'broadcast') return 'read';
    const member = !!viewer.artistId && c.artistIds.includes(viewer.artistId);
    if (c.type === 'announcement') return member ? 'read' : 'none';
    return member ? 'read-write' : 'none';
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

/** Whether this viewer may post: access, plus "only admins can send" in groups. */
export function canSend(
  viewer: Viewer,
  c: Pick<
    Conversation,
    'type' | 'artistIds' | 'settings' | 'staffSubs' | 'admins' | 'staffSettings'
  >,
): boolean {
  if (access(viewer, c) !== 'read-write') return false;
  if (c.type === 'staff-group' && c.staffSettings?.onlyAdminsSend) return isGroupAdmin(viewer, c);
  if (viewer.role === 'artist' && c.type === 'group' && c.settings?.onlyAdminsSend) return false;
  return true;
}

/** A team group admin (rev 14). */
export function isGroupAdmin(viewer: Viewer, c: Pick<Conversation, 'admins'>): boolean {
  return !!viewer.sub && (c.admins ?? []).includes(viewer.sub);
}

/**
 * Team groups (rev 14): any member can add staff unless "only admins can edit
 * group info" is on. Never artists: that would expose the history.
 */
export function canAddStaff(
  viewer: Viewer,
  c: Pick<Conversation, 'type' | 'artistIds' | 'staffSubs' | 'admins' | 'staffSettings'>,
): boolean {
  if (c.type !== 'staff-group' || access(viewer, c) !== 'read-write') return false;
  return !c.staffSettings?.onlyAdminsEditInfo || isGroupAdmin(viewer, c);
}

/** Team groups: admins remove others; anyone can remove themselves (leave). */
export function canRemoveStaff(
  viewer: Viewer,
  c: Pick<Conversation, 'type' | 'artistIds' | 'staffSubs' | 'admins'>,
  sub: string,
): boolean {
  if (c.type !== 'staff-group' || access(viewer, c) !== 'read-write') return false;
  return sub === viewer.sub || isGroupAdmin(viewer, c);
}

/** When someone leaves: if no admin is left, the longest-standing member becomes admin. */
export function adminsAfterLeaving(
  c: Pick<Conversation, 'staffSubs' | 'admins'>,
  leaving: string,
): { staffSubs: string[]; admins: string[] } {
  const staffSubs = (c.staffSubs ?? []).filter((s) => s !== leaving);
  let admins = (c.admins ?? []).filter((s) => s !== leaving && staffSubs.includes(s));
  if (admins.length === 0 && staffSubs.length > 0) admins = [staffSubs[0]!];
  return { staffSubs, admins };
}

/** Can this viewer add artists? Blueprint can; artists only in groups that allow it. */
export function canAddMembers(
  viewer: Viewer,
  c: Pick<Conversation, 'type' | 'artistIds' | 'settings'>,
): boolean {
  if (c.type !== 'group' && c.type !== 'announcement') return false;
  if (access(viewer, c) !== 'read-write') return false;
  return viewer.role !== 'artist' || (c.type === 'group' && !!c.settings?.artistsAddMembers);
}

/** Can this viewer share a file here? */
export function canShareFiles(viewer: Viewer, c: Pick<Conversation, 'type' | 'settings'>) {
  if (viewer.role !== 'artist' || c.type !== 'group') return true;
  return c.settings?.artistsShareFiles ?? true;
}

// ── Ticks (sent / delivered / read) ───────────────────────────────────────
export interface MemberState {
  /** When they last opened the conversation. */
  lastReadAt?: string;
  /** When they last opened the app. */
  lastOnlineAt?: string;
}

/**
 * One tick when sent, two when everyone else has opened the app since, two
 * coral ones when everyone else has read it. With nobody else (yet), it's sent.
 */
export function ticks(sentAt: string, others: MemberState[]): 'sent' | 'delivered' | 'read' {
  if (others.length === 0) return 'sent';
  if (others.every((o) => (o.lastReadAt ?? '') >= sentAt)) return 'read';
  if (others.every((o) => (o.lastOnlineAt ?? '') >= sentAt || (o.lastReadAt ?? '') >= sentAt))
    return 'delivered';
  return 'sent';
}

// ── Message content (sealed) ──────────────────────────────────────────────
export const ATTACHMENT_KINDS = ['file', 'event', 'todo', 'submission', 'gig', 'feedback'] as const;
const ItemId = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
export const Attachment = z
  .object({
    kind: z.enum(ATTACHMENT_KINDS),
    id: ItemId,
    artistId: z
      .string()
      .regex(new RegExp(`^${ARTIST}$`))
      .optional(),
    scope: z.enum(['library', 'artist']).optional(),
    title: z.string().trim().min(1).max(200),
    subtitle: z.string().trim().max(200).optional(),
  })
  .strict();
export type Attachment = z.infer<typeof Attachment>;

export interface Quote {
  messageId: string;
  senderName: string;
  text: string;
}

/** What is sealed for each message. Version 1 was the plain text. */
export interface Payload {
  text: string;
  replyTo?: Quote;
  attachment?: Attachment;
  /** A system note ("Kyra created this group"). */
  system?: boolean;
}

export function encodePayload(p: Payload): string {
  return JSON.stringify({
    v: 2,
    t: p.text,
    ...(p.replyTo ? { r: p.replyTo } : {}),
    ...(p.attachment ? { a: p.attachment } : {}),
    ...(p.system ? { s: 1 } : {}),
  });
}

export function decodePayload(raw: string): Payload {
  if (raw.startsWith('{"v":2')) {
    try {
      const o = JSON.parse(raw) as { t?: string; r?: Quote; a?: Attachment; s?: number };
      return {
        text: o.t ?? '',
        ...(o.r ? { replyTo: o.r } : {}),
        ...(o.a ? { attachment: o.a } : {}),
        ...(o.s ? { system: true } : {}),
      };
    } catch {
      // fall through: treat as text
    }
  }
  return { text: raw };
}

/** A one-line preview for the chat list. */
export function previewOf(p: Payload): string {
  const text = p.text.replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 120);
  if (p.attachment) return `📎 ${p.attachment.title}`.slice(0, 120);
  return '';
}

/** Short quote stored with a reply. */
export const quoteOf = (messageId: string, senderName: string, p: Payload): Quote => ({
  messageId,
  senderName,
  text: previewOf(p).slice(0, 200),
});

// ── Requests ──────────────────────────────────────────────────────────────
const ArtistId = z.string().regex(new RegExp(`^${ARTIST}$`));
const StaffSub = z.string().regex(SUB_PATTERN);

const Settings = z
  .object({
    onlyAdminsSend: z.boolean(),
    artistsShareFiles: z.boolean(),
    artistsAddMembers: z.boolean(),
  })
  .strict();
const Description = z.string().trim().max(500);
const StaffSettings = z
  .object({ onlyAdminsSend: z.boolean(), onlyAdminsEditInfo: z.boolean() })
  .strict();

export const NewConversation = z.discriminatedUnion('kind', [
  /** A direct chat: BMG ↔ artist, artist ↔ artist, or staff ↔ staff (rev 14). */
  z
    .object({
      kind: z.literal('direct'),
      artistId: ArtistId.optional(),
      staffSub: StaffSub.optional(),
    })
    .refine((v) => !(v.artistId && v.staffSub), 'Pick an artist or a team member, not both'),
  /**
   * A group: artists picked → a normal group (Blueprint is in it). Only staff
   * picked → a team group (rev 14). Both → a normal group; the staff picks
   * are ignored there, as Blueprint is one member of artist chats.
   */
  z
    .object({
      kind: z.literal('group'),
      title: z.string().trim().min(1, 'Name the group').max(80),
      description: Description.optional(),
      artistIds: z.array(ArtistId).max(100).default([]),
      staffSubs: z.array(StaffSub).max(MAX_STAFF_GROUP).default([]),
      settings: Settings.optional(),
      staffSettings: StaffSettings.optional(),
    })
    .refine(
      (v) => v.artistIds.length > 0 || v.staffSubs.length > 0,
      'Pick at least one artist or team member',
    ),
  z.object({
    kind: z.literal('announcement'),
    title: z.string().trim().min(1, 'Name the announcement list').max(80),
    description: Description.optional(),
    artistIds: z.array(ArtistId).min(1, 'Pick at least one artist').max(100),
  }),
]);

export const NewMessage = z
  .object({
    text: z.string().trim().max(4000, 'Messages are limited to 4,000 characters').default(''),
    replyTo: z
      .object({
        messageId: z.string().uuid(),
        conversationId: z.string().regex(CONVERSATION_ID_PATTERN).optional(),
      })
      .strict()
      .optional(),
    attachment: Attachment.optional(),
  })
  .refine((m) => m.text.length > 0 || !!m.attachment, 'Write a message');

export const UpdateConversation = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    description: Description.optional(),
    settings: Settings.optional(),
    staffSettings: StaffSettings.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const AddMembers = z
  .object({ artistIds: z.array(ArtistId).min(1, 'Pick an artist').max(100) })
  .strict();

/** The four quick reactions, in the order the bar shows them (rev 14). */
export const QUICK_REACTIONS = ['👍', '👎', '😊', '😢'] as const;
export type QuickReaction = (typeof QUICK_REACTIONS)[number];

/** Stored on the message item: one entry per person (Cognito sub). */
export type StoredReactions = Record<string, { e: QuickReaction; n: string; at: string }>;

export interface ReactionCount {
  emoji: QuickReaction;
  count: number;
  mine: boolean;
  /** Who reacted, for the tooltip ("You" for the viewer). */
  names: string[];
}

/** Groups a message's reactions for one viewer, in bar order, skipping empty ones. */
export function reactionSummary(
  stored: StoredReactions | undefined,
  viewerSub: string,
): ReactionCount[] {
  if (!stored) return [];
  const out: ReactionCount[] = [];
  for (const emoji of QUICK_REACTIONS) {
    const who = Object.entries(stored)
      .filter(([, r]) => r.e === emoji)
      .sort(([, a], [, b]) => a.at.localeCompare(b.at));
    if (!who.length) continue;
    out.push({
      emoji,
      count: who.length,
      mine: who.some(([sub]) => sub === viewerSub),
      names: who.map(([sub, r]) => (sub === viewerSub ? 'You' : r.n)),
    });
  }
  return out;
}

/** Team groups (rev 14): add staff. */
export const AddStaff = z
  .object({ staffSubs: z.array(StaffSub).min(1, 'Pick a team member').max(MAX_STAFF_GROUP) })
  .strict();

/** Team groups (rev 14): make someone admin, or not. */
export const UpdateAdmin = z.object({ sub: StaffSub, admin: z.boolean() }).strict();

export const UpdateMine = z
  .object({
    pinned: z.boolean().optional(),
    muted: z.boolean().optional(),
    archived: z.boolean().optional(),
    clear: z.literal(true).optional(),
    star: z.object({ messageId: z.string().uuid(), starred: z.boolean() }).strict().optional(),
    /** Quick reaction on a message; `null` takes yours off. One per person per message. */
    react: z
      .object({
        messageId: z.string().uuid(),
        createdAt: z.string().datetime(),
        emoji: z.enum(QUICK_REACTIONS).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/**
 * Who starts what:
 * - BMG `direct` with an artist → that artist's `dm-` chat.
 * - Artist `direct` with no artist → their chat with Blueprint.
 * - Artist `direct` with another artist → their shared private chat.
 * - Groups are created by Blueprint, and by artists only when Access &
 *   permissions allows it (off by default). An artist's group always
 *   includes them, and Blueprint is in it like every group.
 * - Artist ↔ artist chats need "message other artists directly" to be on.
 */
export function planConversation(
  viewer: Viewer,
  input: z.input<typeof NewConversation>,
  rules: Pick<AccessRules, 'artistDirectChats' | 'artistGroups'> = DEFAULT_RULES,
):
  | {
      ok: true;
      conversationId: string;
      type: ConversationType;
      artistIds: string[];
      title?: string;
      /** Team chats (rev 14). */
      staffSubs?: string[];
      admins?: string[];
    }
  | { ok: false; reason: string } {
  const req =
    input.kind === 'group'
      ? { ...input, artistIds: input.artistIds ?? [], staffSubs: input.staffSubs ?? [] }
      : input;
  if (req.kind === 'direct' && req.staffSub) {
    if (viewer.role === 'artist') return { ok: false, reason: 'Pick an artist' };
    if (!viewer.sub) return { ok: false, reason: 'No team member on this account' };
    return {
      ok: true,
      conversationId: staffPairId(viewer.sub, req.staffSub),
      type: 'staff-direct',
      artistIds: [],
      staffSubs: [...new Set([viewer.sub, req.staffSub])].sort(),
    };
  }
  if (req.kind === 'group' && req.artistIds.length === 0 && viewer.role !== 'artist') {
    const me = viewer.sub;
    if (!me) return { ok: false, reason: 'No team member on this account' };
    const staffSubs = [...new Set([me, ...req.staffSubs])];
    if (staffSubs.length < 2) return { ok: false, reason: 'Add at least one other team member' };
    if (staffSubs.length > MAX_STAFF_GROUP)
      return { ok: false, reason: `A team group can have up to ${MAX_STAFF_GROUP} people` };
    return {
      ok: true,
      conversationId: '',
      type: 'staff-group',
      artistIds: [],
      title: req.title,
      // The creator first: they are the longest-standing member.
      staffSubs,
      admins: [me],
    };
  }
  if (req.kind === 'group' || req.kind === 'announcement') {
    if (req.artistIds.length === 0) return { ok: false, reason: 'Pick at least one artist' };
    if (viewer.role === 'artist') {
      if (req.kind === 'announcement')
        return { ok: false, reason: 'Announcements are sent by Blueprint' };
      if (!rules.artistGroups) return { ok: false, reason: 'Groups are created by Blueprint' };
      const me = viewer.artistId;
      if (!me) return { ok: false, reason: 'No artist on this account' };
      const artistIds = [...new Set([me, ...req.artistIds])].sort();
      if (artistIds.length < 2) return { ok: false, reason: 'Add at least one other artist' };
      return { ok: true, conversationId: '', type: 'group', artistIds, title: req.title };
    }
    const artistIds = [...new Set(req.artistIds)].sort();
    return { ok: true, conversationId: '', type: req.kind, artistIds, title: req.title };
  }
  if (viewer.role === 'artist') {
    const me = viewer.artistId;
    if (!me) return { ok: false, reason: 'No artist on this account' };
    if (!req.artistId)
      return { ok: true, conversationId: directId(me), type: 'bmg-artist', artistIds: [me] };
    if (req.artistId === me) return { ok: false, reason: 'Pick another artist' };
    if (!rules.artistDirectChats)
      return { ok: false, reason: 'Blueprint has turned off chats between artists' };
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

/**
 * Access & permissions rules on posting, on top of `canSend`: with artist
 * chats off, existing artist ↔ artist chats become read-only; with gig
 * sharing off, artists can't put gig cards where other artists see them.
 */
export function sendRefused(
  viewer: Viewer,
  c: Pick<Conversation, 'type' | 'artistIds'>,
  attachmentKind: string | undefined,
  rules: Pick<AccessRules, 'artistDirectChats' | 'artistGigSharing'>,
): string | null {
  if (viewer.role !== 'artist') return null;
  if (c.type === 'artist-to-artist' && !rules.artistDirectChats)
    return 'Blueprint has turned off chats between artists. You can still read this chat.';
  const otherArtists = c.artistIds.some((id) => id !== viewer.artistId);
  if (
    attachmentKind === 'gig' &&
    !rules.artistGigSharing &&
    otherArtists &&
    (c.type === 'artist-to-artist' || c.type === 'group')
  )
    return 'Blueprint has turned off sharing gigs with other artists';
  return null;
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
export function wrapContext(
  conversationId: string,
  artistId?: string,
  type?: ConversationType,
): Record<string, string> {
  // Team chats (rev 14): their own purpose, so a team key can't be unwrapped as an artist chat's.
  if (type && isStaffType(type)) return { purpose: 'staff-conversation', conversationId };
  return artistId
    ? { artistId, visibility: 'private', conversationId }
    : { purpose: 'conversation-key', conversationId };
}
