import { randomUUID } from 'node:crypto';
import { ACCESS_KEY, DEFAULT_RULES, rulesFrom, type AccessRules } from '../access/model.ts';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Principal } from '@bmg/authz';
import { artistKeyAlias, DataAccessSessions } from '@bmg/crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  access,
  AddMembers,
  AddStaff,
  adminsAfterLeaving,
  artistMember,
  BMG_MEMBER,
  BROADCAST_ID,
  canAddMembers,
  canAddStaff,
  canRemoveStaff,
  canSend,
  canShareFiles,
  MAX_STAFF_GROUP,
  channelsFor,
  CONV_META,
  CONVERSATION_ID_PATTERN,
  convPk,
  decodePayload,
  DEFAULT_SETTINGS,
  DEFAULT_STAFF_SETTINGS,
  encodePayload,
  inboxPk,
  inboxSk,
  isAnnouncementType,
  isGroupAdmin,
  members,
  messageSk,
  newConversationKey,
  NewConversation,
  NewMessage,
  open,
  isStaffConversationId,
  isStaffType,
  planConversation,
  sendRefused,
  presenceKey,
  previewOf,
  publicType,
  quoteOf,
  reactionSummary,
  seal,
  staffChannel,
  staffMember,
  SUB_PATTERN,
  ticks,
  UpdateConversation,
  UpdateMine,
  wrapContext,
  type Attachment,
  type Conversation,
  type MemberState,
  type Payload,
  type StoredReactions,
  type Viewer,
} from '../messages/model.ts';
import { chatUseSk, fileUsePk } from '../files/model.ts';
import { people, type Person } from '../files/people.ts';
import { publish } from '../realtime.ts';
import { ROSTER_GSI1PK } from '../workspace/model.ts';
import {
  audit,
  authContext,
  db,
  env,
  handle,
  HttpError,
  json,
  parseBody,
  principalFor,
} from '../lib.ts';

const kms = new KMSClient({});
const events = new EventBridgeClient({});
const sessions = new DataAccessSessions();
const table = () => env('MAIN_TABLE');

interface StoredMessage {
  messageId: string;
  conversationId: string;
  senderSub: string;
  senderRole: Viewer['role'];
  senderArtistId?: string;
  senderName: string;
  cipher: Uint8Array;
  createdAt: string;
  /** System notes ("Kyra created this group"). */
  system?: boolean;
  /** Quick reactions (rev 14), keyed by the reactor's sub. */
  reactions?: StoredReactions;
}

interface InboxRow {
  conversationId: string;
  lastReadAt?: string;
  clearedAt?: string;
  pinned?: boolean;
  muted?: boolean;
  archived?: boolean;
  starred?: string[];
}

const viewerOf = (p: Principal): Viewer => ({
  role: p.role,
  sub: p.sub,
  ...(p.artistId ? { artistId: p.artistId } : {}),
  ...(p.assignedArtistIds ? { assignedArtistIds: p.assignedArtistIds } : {}),
});

// ── Conversation keys (design 9.3) ─────────────────────────────────────────
const keyCache = new Map<string, { key: Uint8Array; until: number }>();
const artistKeyArn = (artistId: string) =>
  `arn:aws:kms:${env('AWS_REGION')}:${env('ACCOUNT_ID')}:${artistKeyAlias(env('PROJECT'), env('BMG_ENV'), artistId)}`;

async function artistKms(artistId: string) {
  // Always an `artist` session: KMS refuses private material to every BMG role.
  const credentials = await sessions.credentials({
    roleArn: env('DATA_ACCESS_ROLE_ARN'),
    artistId,
    role: 'artist',
  });
  return new KMSClient({ credentials });
}

async function wrapKeys(
  c: Pick<Conversation, 'conversationId' | 'type' | 'artistIds'>,
  key: Uint8Array,
) {
  const wraps: Record<string, Uint8Array> = {};
  if (c.type === 'artist-to-artist') {
    for (const artistId of c.artistIds) {
      const res = await (
        await artistKms(artistId)
      ).send(
        new EncryptCommand({
          KeyId: artistKeyArn(artistId),
          Plaintext: key,
          EncryptionContext: wrapContext(c.conversationId, artistId),
        }),
      );
      wraps[artistId] = res.CiphertextBlob!;
    }
  } else {
    const res = await kms.send(
      new EncryptCommand({
        KeyId: env('PLATFORM_KEY_ARN'),
        Plaintext: key,
        EncryptionContext: wrapContext(c.conversationId, undefined, c.type),
      }),
    );
    wraps.platform = res.CiphertextBlob!;
  }
  return wraps;
}

/** Unwraps the conversation key for this viewer: the platform wrap, or their own artist wrap. */
async function conversationKey(viewer: Viewer, c: Conversation): Promise<Uint8Array> {
  const cacheKey = `${c.conversationId}|${c.type === 'artist-to-artist' ? viewer.artistId : 'platform'}`;
  const hit = keyCache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.key;
  let key: Uint8Array;
  if (c.type === 'artist-to-artist') {
    const me = viewer.artistId;
    if (viewer.role !== 'artist' || !me || !c.keyWraps[me])
      throw new HttpError(403, 'Not in this chat');
    const res = await (
      await artistKms(me)
    ).send(
      new DecryptCommand({
        CiphertextBlob: c.keyWraps[me],
        EncryptionContext: wrapContext(c.conversationId, me),
      }),
    );
    key = res.Plaintext!;
  } else {
    const res = await kms.send(
      new DecryptCommand({
        CiphertextBlob: c.keyWraps.platform,
        EncryptionContext: wrapContext(c.conversationId, undefined, c.type),
      }),
    );
    key = res.Plaintext!;
  }
  keyCache.set(cacheKey, { key, until: Date.now() + 5 * 60_000 });
  return key;
}

// ── Storage ────────────────────────────────────────────────────────────────
async function loadConversation(id: string): Promise<Conversation | undefined> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: convPk(id), SK: CONV_META } }),
  );
  return res.Item as Conversation | undefined;
}

/** Creates the conversation and an inbox row per member, once (idempotent for direct chats). */
async function createConversation(
  c: Pick<Conversation, 'conversationId' | 'type' | 'artistIds' | 'title'> &
    Partial<Pick<Conversation, 'staffSubs' | 'admins' | 'staffSettings'>>,
  createdBy: string,
): Promise<Conversation> {
  const key = newConversationKey();
  const conv: Conversation = {
    ...c,
    keyWraps: await wrapKeys(c, key),
    createdBy,
    createdAt: new Date().toISOString(),
  };
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: {
                PK: convPk(c.conversationId),
                SK: CONV_META,
                ...conv,
                type: 'conversation',
                conversationType: c.type,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...members(c).map((m) => ({
            Put: {
              TableName: table(),
              Item: {
                PK: inboxPk(m),
                SK: inboxSk(c.conversationId),
                conversationId: c.conversationId,
              },
            },
          })),
        ],
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'TransactionCanceledException') throw err;
    // Someone created it first (a direct chat started from both ends).
    const existing = await loadConversation(c.conversationId);
    if (existing) return existing;
    throw err;
  }
  return conv;
}

/** The stored item uses `conversationType` because the item's own `type` is 'conversation'. */
function fromItem(item: Record<string, unknown>): Conversation {
  return {
    ...(item as unknown as Conversation),
    type: item.conversationType as Conversation['type'],
  };
}

async function getConversation(id: string): Promise<Conversation | undefined> {
  if (id === BROADCAST_ID) {
    const found = await loadConversation(id);
    if (found) return fromItem(found as never);
    return createConversation(
      { conversationId: BROADCAST_ID, type: 'broadcast', artistIds: [] },
      'system',
    );
  }
  const found = await loadConversation(id);
  return found ? fromItem(found as never) : undefined;
}

async function latestMessages(id: string, limit: number, before?: string) {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: before
        ? 'PK = :pk AND SK BETWEEN :start AND :before'
        : 'PK = :pk AND begins_with(SK, :m)',
      ExpressionAttributeValues: before
        ? { ':pk': convPk(id), ':start': 'MSG#', ':before': `MSG#${before}` }
        : { ':pk': convPk(id), ':m': 'MSG#' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  const items = (res.Items ?? []) as StoredMessage[];
  // BETWEEN is inclusive: drop the cursor message itself.
  const cursorId = before?.split('#')[1];
  return items.filter((m) => m.messageId !== cursorId).reverse();
}

async function artistNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const unique = [...new Set(ids)].slice(0, 100);
  const res = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [table()]: { Keys: unique.map((id) => ({ PK: `ARTIST#${id}`, SK: 'PROFILE' })) },
      },
    }),
  );
  return Object.fromEntries(
    (res.Responses?.[table()] ?? []).map((p) => [p.artistId as string, p.displayName as string]),
  );
}

/**
 * The viewer's inbox member for a conversation: their own `STAFF#<sub>` for
 * team chats (rev 14), Blueprint's shared `BMG` for every other chat staff are
 * in, or the artist's own.
 */
function memberFor(viewer: Viewer, c?: Pick<Conversation, 'type'>): string {
  if (viewer.role === 'artist') return artistMember(viewer.artistId!);
  return c && isStaffType(c.type) ? staffMember(viewer.sub!) : BMG_MEMBER;
}

async function markRead(viewer: Viewer, c: Pick<Conversation, 'conversationId' | 'type'>) {
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: inboxPk(memberFor(viewer, c)), SK: inboxSk(c.conversationId) },
      UpdateExpression: 'SET conversationId = :id, lastReadAt = :at',
      ExpressionAttributeValues: { ':id': c.conversationId, ':at': new Date().toISOString() },
    }),
  );
}

// ── The Blueprint team (team chats, rev 14) ───────────────────────────────
/** Blueprint people with a working login, by sub (turned-off logins aren't listed). */
async function activeTeam(): Promise<Map<string, Person>> {
  const all = await people();
  return new Map(all.filter((p) => p.role !== 'artist').map((p) => [p.sub, p]));
}

const FORMER = 'No longer at Blueprint';
const teamName = (team: Map<string, Person>, sub: string) => team.get(sub)?.displayName ?? FORMER;

/**
 * Why nobody can post in this team chat, if they can't: a direct chat whose
 * other person's login was turned off becomes read-only (messages are kept).
 */
function teamSendBlock(
  viewer: Viewer,
  c: Pick<Conversation, 'type' | 'staffSubs'>,
  team: Map<string, Person>,
): string | null {
  if (c.type !== 'staff-direct') return null;
  const other = (c.staffSubs ?? []).find((s) => s !== viewer.sub);
  return other && !team.has(other) ? `${FORMER}. You can still read this chat.` : null;
}

/** What the chat list and info pane show for a team chat (rev 14). */
function teamDetails(
  viewer: Viewer,
  c: Pick<Conversation, 'type' | 'staffSubs' | 'admins' | 'staffSettings'>,
  team: Map<string, Person>,
) {
  return {
    team: true,
    members: (c.staffSubs ?? []).map((sub) => ({
      sub,
      displayName: teamName(team, sub),
      jobTitle: team.get(sub)?.jobTitle ?? '',
      admin: (c.admins ?? []).includes(sub),
      active: team.has(sub),
      me: sub === viewer.sub,
    })),
    isAdmin: isGroupAdmin(viewer, c),
    staffSettings:
      c.type === 'staff-group' ? { ...DEFAULT_STAFF_SETTINGS, ...c.staffSettings } : null,
  };
}

async function inboxRow(member: string, conversationId: string): Promise<InboxRow | undefined> {
  const res = await db.send(
    new GetCommand({
      TableName: table(),
      Key: { PK: inboxPk(member), SK: inboxSk(conversationId) },
    }),
  );
  return res.Item as InboxRow | undefined;
}

/** Records that this member has the app open (delivered ticks, "last seen"). */
async function touchPresence(member: string) {
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: presenceKey(member),
      UpdateExpression: 'SET lastOnlineAt = :at',
      ExpressionAttributeValues: { ':at': new Date().toISOString() },
    }),
  );
}

/** Read and online state of every member except `me` (for ticks and "last seen"). */
async function otherMembers(
  c: Conversation,
  me: string,
): Promise<{ member: string; state: MemberState }[]> {
  // The all-artists broadcast has no member list to measure against.
  if (c.type === 'broadcast') return [];
  const others = members(c)
    .filter((m) => m !== me)
    .slice(0, 50);
  if (others.length === 0) return [];
  const res = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [table()]: {
          Keys: others.flatMap((m) => [
            { PK: inboxPk(m), SK: inboxSk(c.conversationId) },
            presenceKey(m),
          ]),
        },
      },
    }),
  );
  const items = res.Responses?.[table()] ?? [];
  return others.map((m) => {
    const row = items.find((i) => i.PK === inboxPk(m));
    const presence = items.find((i) => i.PK === presenceKey(m).PK);
    return {
      member: m,
      state: {
        ...(row?.lastReadAt ? { lastReadAt: row.lastReadAt as string } : {}),
        ...(presence?.lastOnlineAt ? { lastOnlineAt: presence.lastOnlineAt as string } : {}),
      },
    };
  });
}

/** Messages after `after` from other people (capped at 99). */
async function unreadCount(conversationId: string, after: string | undefined, me: string) {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND SK > :after',
      FilterExpression: 'senderSub <> :me',
      ExpressionAttributeValues: {
        ':pk': convPk(conversationId),
        ':after': `MSG#${after ?? ''}`,
        ':me': me,
      },
      Select: 'COUNT',
      Limit: 200,
    }),
  );
  return Math.min(res.Count ?? 0, 99);
}

function conversationIdParam(event: APIGatewayProxyEvent): string {
  const id = event.pathParameters?.conversationId ?? '';
  if (!CONVERSATION_ID_PATTERN.test(id)) throw new HttpError(404, 'No such conversation');
  return id;
}

const openPayload = (key: Uint8Array, m: StoredMessage) =>
  decodePayload(open(key, m.cipher, m.conversationId, m.messageId));

function titleFor(
  viewer: Viewer,
  c: Conversation,
  names: Record<string, string>,
  team: Map<string, Person> = new Map(),
): string {
  if (c.type === 'staff-group') return c.title ?? 'Team group';
  if (c.type === 'staff-direct') {
    const other = (c.staffSubs ?? []).find((s) => s !== viewer.sub);
    // Message yourself: WhatsApp's "<name> (You)".
    return other ? teamName(team, other) : `${teamName(team, viewer.sub!)} (You)`;
  }
  if (c.type === 'broadcast') return 'All artists';
  if (c.type === 'group') return c.title ?? 'Group';
  if (c.type === 'announcement') return c.title ?? 'Announcement';
  if (c.type === 'bmg-artist')
    return viewer.role === 'artist' ? 'Blueprint' : (names[c.artistIds[0]!] ?? 'Artist');
  return names[c.artistIds.find((id) => id !== viewer.artistId)!] ?? 'Artist';
}

/**
 * The name shown on a message. Artists see Blueprint as one "Blueprint" in
 * their chats; in team chats (rev 14) each person is named.
 */
async function senderNameOf(principal: Principal, c?: Pick<Conversation, 'type'>): Promise<string> {
  if (principal.role === 'artist') {
    return (await artistNames([principal.artistId!]))[principal.artistId!] ?? 'Artist';
  }
  if (c && isStaffType(c.type)) {
    const me = (await activeTeam().catch(() => new Map<string, Person>())).get(principal.sub);
    return me?.displayName ?? 'Blueprint';
  }
  return 'Blueprint';
}

/**
 * Stores a message (sealed), moves the conversation to the top, nudges the
 * members' apps and tells the notifier (ids and names only, never content).
 */
async function postMessage(
  conv: Conversation,
  principal: Principal,
  viewer: Viewer,
  payload: Payload,
  senderName: string,
  opts: { markRead?: boolean } = {},
): Promise<{ messageId: string; createdAt: string }> {
  const messageId = randomUUID();
  const at = new Date().toISOString();
  const msg: StoredMessage = {
    messageId,
    conversationId: conv.conversationId,
    senderSub: principal.sub,
    senderRole: principal.role,
    ...(principal.artistId ? { senderArtistId: principal.artistId } : {}),
    senderName,
    cipher: seal(
      await conversationKey(viewer, conv),
      encodePayload(payload),
      conv.conversationId,
      messageId,
    ),
    createdAt: at,
    ...(payload.system ? { system: true } : {}),
  };
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: convPk(conv.conversationId),
        SK: messageSk(at, messageId),
        type: 'message',
        ...msg,
      },
    }),
  );
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: convPk(conv.conversationId), SK: CONV_META },
      UpdateExpression: 'SET lastMessageAt = :at',
      ExpressionAttributeValues: { ':at': at },
    }),
  );
  // Not for someone who has just left: that would put the chat back in their list.
  if (opts.markRead !== false) await markRead(viewer, conv);
  await publish(channelsFor(conv), { conversationId: conv.conversationId, at });
  // Members who muted this chat get no email or push for it.
  const muted =
    conv.type === 'broadcast'
      ? []
      : ((
          await db.send(
            new BatchGetCommand({
              RequestItems: {
                [table()]: {
                  Keys: members(conv)
                    .slice(0, 100)
                    .map((m) => ({ PK: inboxPk(m), SK: inboxSk(conv.conversationId) })),
                  ProjectionExpression: 'PK, muted',
                },
              },
            }),
          )
        ).Responses?.[table()]
          ?.filter((r) => r.muted)
          .map((r) => String(r.PK).replace(/^INBOX#/, '')) ?? []);
  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: env('EVENT_BUS'),
          Source: 'bmg.workspace',
          DetailType: 'message.created',
          Detail: JSON.stringify({
            id: randomUUID(),
            at,
            conversationId: conv.conversationId,
            conversationType: conv.type,
            artistIds: conv.artistIds,
            senderSub: principal.sub,
            senderName,
            mutedMembers: muted,
            ...(payload.system ? { system: true } : {}),
            ...(isStaffType(conv.type) ? { staffSubs: conv.staffSubs ?? [] } : {}),
            ...((conv.type === 'group' ||
              conv.type === 'announcement' ||
              conv.type === 'staff-group') &&
            conv.title
              ? { title: conv.title }
              : {}),
          }),
        },
      ],
    }),
  );
  return { messageId, createdAt: at };
}

const systemNote = (text: string): Payload => ({ text, system: true });

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Sets or clears the caller's quick reaction on a message (rev 14). Anyone who
 * can read the chat can react, including in announcements and admin-only
 * groups, like WhatsApp. System notes can't be reacted to. No new route: this
 * rides on PATCH …/me because the API stack is at its resource limit.
 */
async function react(
  conv: Conversation,
  principal: Principal,
  r: { messageId: string; createdAt: string; emoji: StoredReactions[string]['e'] | null },
) {
  const Key = { PK: convPk(conv.conversationId), SK: messageSk(r.createdAt, r.messageId) };
  const guard = 'messageId = :mid AND attribute_not_exists(#sys)';
  const names = { '#r': 'reactions', '#who': principal.sub, '#sys': 'system' };
  const isMissingMap = (e: unknown) =>
    (e as Error).name === 'ValidationException' &&
    /document path/i.test((e as Error).message ?? '');
  const isGone = (e: unknown) => (e as Error).name === 'ConditionalCheckFailedException';
  try {
    if (r.emoji) {
      const value = {
        e: r.emoji,
        n: await senderNameOf(principal, conv),
        at: new Date().toISOString(),
      };
      try {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key,
            UpdateExpression: 'SET #r.#who = :v',
            ConditionExpression: `${guard} AND attribute_exists(#r)`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: { ':mid': r.messageId, ':v': value },
          }),
        );
      } catch (e) {
        if (!isGone(e) && !isMissingMap(e)) throw e;
        // First reaction on this message: create the map. If someone beat us
        // to it, the map now exists, so set our entry inside it.
        try {
          await db.send(
            new UpdateCommand({
              TableName: table(),
              Key,
              UpdateExpression: 'SET #r = :m',
              ConditionExpression: `${guard} AND attribute_not_exists(#r)`,
              ExpressionAttributeNames: { '#r': 'reactions', '#sys': 'system' },
              ExpressionAttributeValues: { ':mid': r.messageId, ':m': { [principal.sub]: value } },
            }),
          );
        } catch (e2) {
          if (!isGone(e2)) throw e2;
          await db.send(
            new UpdateCommand({
              TableName: table(),
              Key,
              UpdateExpression: 'SET #r.#who = :v',
              ConditionExpression: `${guard} AND attribute_exists(#r)`,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: { ':mid': r.messageId, ':v': value },
            }),
          );
        }
      }
    } else {
      await db
        .send(
          new UpdateCommand({
            TableName: table(),
            Key,
            UpdateExpression: 'REMOVE #r.#who',
            ConditionExpression: guard,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: { ':mid': r.messageId },
          }),
        )
        .catch((e: unknown) => {
          // Nothing to take off.
          if (!isMissingMap(e)) throw e;
        });
    }
  } catch (e) {
    if (isGone(e)) throw new HttpError(404, 'That message is gone');
    throw e;
  }
  const res = await db.send(new GetCommand({ TableName: table(), Key }));
  await publish(channelsFor(conv), { conversationId: conv.conversationId });
  return reactionSummary((res.Item as StoredMessage | undefined)?.reactions, principal.sub);
}

/** Finds a message by id in a conversation (newest first, a few pages at most). */
async function findMessage(conversationId: string, messageId: string) {
  let start: Record<string, unknown> | undefined;
  for (let page = 0; page < 4; page++) {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :m)',
        FilterExpression: 'messageId = :id',
        ExpressionAttributeValues: {
          ':pk': convPk(conversationId),
          ':m': 'MSG#',
          ':id': messageId,
        },
        ScanIndexForward: false,
        Limit: 250,
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    const hit = res.Items?.[0] as StoredMessage | undefined;
    if (hit) return hit;
    start = res.LastEvaluatedKey;
    if (!start) break;
  }
  return undefined;
}

async function describe(viewer: Viewer, c: Conversation): Promise<string | null> {
  if (!c.descriptionCipher) return null;
  return open(
    await conversationKey(viewer, c),
    c.descriptionCipher,
    c.conversationId,
    'description',
  );
}

async function loadReadable(viewer: Viewer, id: string): Promise<Conversation> {
  // Team chats (rev 14) are never an artist's: refuse before any lookup.
  if (viewer.role === 'artist' && isStaffConversationId(id))
    throw new HttpError(404, 'No such conversation');
  const conv = await getConversation(id);
  if (!conv || conv.deletedAt || access(viewer, conv) === 'none')
    throw new HttpError(404, 'No such conversation');
  return conv;
}

/**
 * Chat. Every request checks access against the stored conversation; content
 * is sealed with a per-conversation key, and artist-to-artist keys only open
 * in an artist session for a member.
 */
/**
 * Notes that a document was posted in this chat (rev 8), for its "Where it's
 * used" list. Ids and the chat's type only; never the message. Best effort:
 * the message is already sent.
 */
async function recordFileUse(conv: Conversation, a: Attachment) {
  const scope = a.scope === 'library' ? 'library' : 'artist';
  if (scope === 'artist' && !a.artistId) return;
  try {
    await db.send(
      new PutCommand({
        TableName: table(),
        Item: {
          PK: fileUsePk(scope, a.id, a.artistId),
          SK: chatUseSk(conv.conversationId),
          type: 'file-use',
          kind: 'chat',
          conversationId: conv.conversationId,
          at: new Date().toISOString(),
        },
      }),
    );
  } catch (err) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'file-use.failed', error: (err as Error).name }),
    );
  }
}

/** Access & permissions switches; only artists are bound by them. */
async function accessRules(viewer: Viewer): Promise<AccessRules> {
  if (viewer.role !== 'artist') return DEFAULT_RULES;
  const res = await db.send(new GetCommand({ TableName: table(), Key: ACCESS_KEY }));
  return rulesFrom(res.Item);
}

export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const viewer = viewerOf(principal);
  const me = memberFor(viewer);
  const route = `${event.httpMethod} ${event.resource}`;

  // ── Team groups (rev 14) ──
  async function updateTeamGroup(conv: Conversation) {
    const body = parseBody(event, UpdateConversation);
    const admin = isGroupAdmin(viewer, conv);
    const editsInfo = body.title !== undefined || body.description !== undefined;
    if (editsInfo && conv.staffSettings?.onlyAdminsEditInfo && !admin)
      throw new HttpError(403, 'Only group admins can edit group info');
    if ((body.staffSettings || body.admin) && !admin)
      throw new HttpError(403, 'Only group admins can change this');
    if (body.settings) throw new HttpError(400, 'Use team group settings here');
    const team = await activeTeam();
    const who = teamName(team, principal.sub);
    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    const notes: string[] = [];
    if (body.title !== undefined && body.title !== conv.title) {
      sets.push('title = :t');
      values[':t'] = body.title;
      notes.push(`${who} changed the name to “${body.title}”`);
    }
    if (body.description !== undefined) {
      sets.push('descriptionCipher = :d');
      values[':d'] = seal(
        await conversationKey(viewer, conv),
        body.description,
        conv.conversationId,
        'description',
      );
      notes.push(`${who} changed the description`);
    }
    if (body.staffSettings) {
      sets.push('staffSettings = :ss');
      values[':ss'] = body.staffSettings;
    }
    if (body.admin) {
      const { sub, admin: makeAdmin } = body.admin;
      if (!(conv.staffSubs ?? []).includes(sub)) throw new HttpError(404, 'Not a member');
      const next = new Set(conv.admins ?? []);
      if (makeAdmin) next.add(sub);
      else next.delete(sub);
      if (next.size === 0) throw new HttpError(409, 'A group needs at least one admin');
      sets.push('admins = :ad');
      values[':ad'] = [...next];
    }
    if (sets.length)
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: convPk(conv.conversationId), SK: CONV_META },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeValues: values,
        }),
      );
    const updated = { ...conv, ...(body.title ? { title: body.title } : {}) };
    for (const n of notes) await postMessage(updated, principal, viewer, systemNote(n), who);
    if (!notes.length) await publish(channelsFor(conv), { conversationId: conv.conversationId });
    await audit(event, 'chat.update', 'success', { conversationId: conv.conversationId });
    return json(200, { conversationId: conv.conversationId });
  }

  async function addTeamMembers(conv: Conversation) {
    if (!canAddStaff(viewer, conv)) throw new HttpError(403, 'Only group admins can add people');
    const { staffSubs } = parseBody(event, AddStaff);
    const current = conv.staffSubs ?? [];
    const adding = [...new Set(staffSubs)].filter((s) => !current.includes(s));
    if (!adding.length) return json(200, { added: [] });
    const team = await activeTeam();
    // Only Blueprint people with a working login; never artists.
    if (adding.some((s) => !team.has(s))) throw new HttpError(404, 'No such team member');
    const next = [...current, ...adding];
    if (next.length > MAX_STAFF_GROUP)
      throw new HttpError(409, `A team group can have up to ${MAX_STAFF_GROUP} people`);
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: convPk(conv.conversationId), SK: CONV_META },
        UpdateExpression: 'SET staffSubs = :s',
        ExpressionAttributeValues: { ':s': next },
      }),
    );
    for (const s of adding)
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            PK: inboxPk(staffMember(s)),
            SK: inboxSk(conv.conversationId),
            conversationId: conv.conversationId,
          },
        }),
      );
    const who = teamName(team, principal.sub);
    await postMessage(
      { ...conv, staffSubs: next },
      principal,
      viewer,
      systemNote(`${who} added ${listNames(adding.map((s) => teamName(team, s)))}`),
      who,
    );
    await audit(event, 'chat.addMembers', 'success', { conversationId: conv.conversationId });
    return json(200, { added: adding });
  }

  async function removeTeamMember(conv: Conversation, sub: string | undefined) {
    if (!sub || !SUB_PATTERN.test(sub) || !(conv.staffSubs ?? []).includes(sub))
      throw new HttpError(404, 'Not a member');
    if (!canRemoveStaff(viewer, conv, sub))
      throw new HttpError(403, 'Only group admins can remove people');
    const leaving = sub === principal.sub;
    const { staffSubs, admins } = adminsAfterLeaving(conv, sub);
    const team = await activeTeam();
    const name = teamName(team, sub);
    const who = teamName(team, principal.sub);
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: convPk(conv.conversationId), SK: CONV_META },
        // The last person out closes the group.
        UpdateExpression: staffSubs.length
          ? 'SET staffSubs = :s, admins = :a'
          : 'SET staffSubs = :s, admins = :a, deletedAt = :at',
        ExpressionAttributeValues: {
          ':s': staffSubs,
          ':a': admins,
          ...(staffSubs.length ? {} : { ':at': new Date().toISOString() }),
        },
      }),
    );
    await db.send(
      new DeleteCommand({
        TableName: table(),
        Key: { PK: inboxPk(staffMember(sub)), SK: inboxSk(conv.conversationId) },
      }),
    );
    if (staffSubs.length)
      await postMessage(
        { ...conv, staffSubs, admins },
        principal,
        viewer,
        systemNote(leaving ? `${name} left` : `${who} removed ${name}`),
        who,
        { markRead: !leaving },
      );
    await publish([staffChannel(sub)], { conversationId: conv.conversationId });
    await audit(event, 'chat.removeMember', 'success', { conversationId: conv.conversationId });
    return json(200, { removed: sub });
  }

  switch (route) {
    case 'GET /conversations': {
      // Staff read two inboxes: Blueprint's shared one, and their own for team chats (rev 14).
      const myInboxes = viewer.role === 'artist' ? [me] : [me, staffMember(principal.sub)];
      await Promise.all(myInboxes.map(touchPresence));
      const inboxes = await Promise.all(
        myInboxes.map((m) =>
          db.send(
            new QueryCommand({
              TableName: table(),
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
              ExpressionAttributeValues: { ':pk': inboxPk(m), ':c': 'CONV#' },
              Limit: 200,
            }),
          ),
        ),
      );
      const rows = inboxes.flatMap((r) => (r.Items ?? []) as InboxRow[]);
      const rowOf = Object.fromEntries(rows.map((r) => [r.conversationId, r]));
      const ids = [...new Set([BROADCAST_ID, ...rows.map((r) => r.conversationId)])].slice(0, 100);
      await getConversation(BROADCAST_ID);
      const metas = await db.send(
        new BatchGetCommand({
          RequestItems: {
            [table()]: { Keys: ids.map((id) => ({ PK: convPk(id), SK: CONV_META })) },
          },
        }),
      );
      const convs = (metas.Responses?.[table()] ?? [])
        .map((i) => fromItem(i))
        .filter((c) => !c.deletedAt && access(viewer, c) !== 'none');
      const names = await artistNames(convs.flatMap((c) => c.artistIds));
      const team = convs.some((c) => isStaffType(c.type))
        ? await activeTeam()
        : new Map<string, Person>();
      const list = await Promise.all(
        convs.map(async (c) => {
          const row = rowOf[c.conversationId];
          const meHere = memberFor(viewer, c);
          const key = await conversationKey(viewer, c);
          const after = [row?.lastReadAt, row?.clearedAt].filter(Boolean).sort().at(-1);
          const [last] = await latestMessages(c.conversationId, 1);
          const shown =
            last && (!row?.clearedAt || last.createdAt > row.clearedAt) ? last : undefined;
          const payload = shown ? openPayload(key, shown) : undefined;
          const mine = !!shown && shown.senderSub === principal.sub && !shown.system;
          const direct =
            c.type === 'bmg-artist' || c.type === 'artist-to-artist' || c.type === 'staff-direct';
          const others = mine || direct ? await otherMembers(c, meHere) : [];
          return {
            conversationId: c.conversationId,
            type: publicType(c.type),
            title: titleFor(viewer, c, names, team),
            description: await describe(viewer, c),
            artists: c.artistIds.map((id) => ({
              artistId: id,
              displayName: names[id] ?? 'Artist',
            })),
            access: access(viewer, c),
            canSend: canSend(viewer, c) && !teamSendBlock(viewer, c, team),
            settings: c.type === 'group' ? { ...DEFAULT_SETTINGS, ...c.settings } : null,
            ...(isStaffType(c.type) ? teamDetails(viewer, c, team) : {}),
            lastMessageAt: shown ? shown.createdAt : null,
            preview: payload ? previewOf(payload) : null,
            previewSender: !shown
              ? null
              : mine
                ? 'You'
                : shown.system || direct
                  ? null
                  : shown.senderName,
            previewTicks: mine
              ? ticks(
                  shown!.createdAt,
                  others.map((o) => o.state),
                )
              : null,
            unreadCount: c.lastMessageAt
              ? await unreadCount(c.conversationId, after, principal.sub)
              : 0,
            pinned: !!row?.pinned,
            muted: !!row?.muted,
            archived: !!row?.archived,
            private: c.type === 'artist-to-artist',
            lastSeen: direct ? (others[0]?.state.lastOnlineAt ?? null) : null,
          };
        }),
      );
      list.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
      return json(200, { conversations: list });
    }

    case 'POST /conversations': {
      const body = parseBody(event, NewConversation);
      const plan = planConversation(viewer, body, await accessRules(viewer));
      if (!plan.ok) throw new HttpError(403, plan.reason);
      if (isStaffType(plan.type)) {
        // Team chats (rev 14): everyone in it must be on the Blueprint team with a working login.
        const team = await activeTeam();
        const staffSubs = plan.staffSubs ?? [];
        if (staffSubs.some((s) => !team.has(s))) throw new HttpError(404, 'No such team member');
        if (plan.type === 'staff-direct') {
          const existing = await getConversation(plan.conversationId);
          if (existing) return json(200, { conversationId: existing.conversationId });
        }
        const id =
          plan.type === 'staff-group'
            ? `sg-${randomUUID().replace(/-/g, '').slice(0, 20)}`
            : plan.conversationId;
        let conv = await createConversation(
          {
            conversationId: id,
            type: plan.type,
            artistIds: [],
            staffSubs,
            ...(plan.type === 'staff-group'
              ? {
                  admins: plan.admins ?? [principal.sub],
                  staffSettings: {
                    ...DEFAULT_STAFF_SETTINGS,
                    ...(body.kind === 'group' ? (body.staffSettings ?? {}) : {}),
                  },
                }
              : {}),
            ...(plan.title ? { title: plan.title } : {}),
          },
          principal.sub,
        );
        if (plan.type === 'staff-group') {
          const description = body.kind === 'group' ? body.description : undefined;
          if (description) {
            const descriptionCipher = seal(
              await conversationKey(viewer, conv),
              description,
              id,
              'description',
            );
            await db.send(
              new UpdateCommand({
                TableName: table(),
                Key: { PK: convPk(id), SK: CONV_META },
                UpdateExpression: 'SET descriptionCipher = :d',
                ExpressionAttributeValues: { ':d': descriptionCipher },
              }),
            );
            conv = { ...conv, descriptionCipher };
          }
          const who = teamName(team, principal.sub);
          const added = staffSubs.filter((s) => s !== principal.sub).map((s) => teamName(team, s));
          await postMessage(
            conv,
            principal,
            viewer,
            systemNote(`${who} created this group and added ${listNames(added)}`),
            who,
          );
        }
        await audit(event, 'chat.create', 'success', { conversationId: id, kind: plan.type });
        return json(201, { conversationId: conv.conversationId });
      }
      // Every artist must exist (and, for staff, be theirs to message).
      const names = await artistNames(plan.artistIds);
      if (plan.artistIds.some((id) => !names[id])) throw new HttpError(404, 'No such artist');
      const multi = plan.type === 'group' || plan.type === 'announcement';
      const id = multi
        ? `${plan.type === 'group' ? 'grp' : 'ann'}-${randomUUID().replace(/-/g, '').slice(0, 20)}`
        : plan.conversationId;
      // Groups and announcements need write access to every artist in them
      // (staff only to their own); direct chats need write access too.
      const checkType = multi ? 'group' : plan.type;
      if (access(viewer, { type: checkType, artistIds: plan.artistIds }) !== 'read-write')
        throw new HttpError(403, 'You can’t start this conversation');
      const existing = multi ? undefined : await getConversation(id);
      if (existing) return json(200, { conversationId: existing.conversationId });
      // Artists who start a group (when allowed) get Blueprint's defaults; the
      // admin-only settings stay Blueprint's to change.
      const settings =
        body.kind === 'group'
          ? { ...DEFAULT_SETTINGS, ...(viewer.role === 'artist' ? {} : (body.settings ?? {})) }
          : undefined;
      let conv = await createConversation(
        {
          conversationId: id,
          type: plan.type,
          artistIds: plan.artistIds,
          ...(plan.title ? { title: plan.title } : {}),
        },
        principal.sub,
      );
      if (multi) {
        const description = 'description' in body ? body.description : undefined;
        if (settings || description) {
          const descriptionCipher = description
            ? seal(await conversationKey(viewer, conv), description, id, 'description')
            : undefined;
          await db.send(
            new UpdateCommand({
              TableName: table(),
              Key: { PK: convPk(id), SK: CONV_META },
              UpdateExpression: `SET ${[
                settings ? 'settings = :s' : '',
                descriptionCipher ? 'descriptionCipher = :d' : '',
              ]
                .filter(Boolean)
                .join(', ')}`,
              ExpressionAttributeValues: {
                ...(settings ? { ':s': settings } : {}),
                ...(descriptionCipher ? { ':d': descriptionCipher } : {}),
              },
            }),
          );
          conv = {
            ...conv,
            ...(settings ? { settings } : {}),
            ...(descriptionCipher ? { descriptionCipher } : {}),
          };
        }
        const who = await senderNameOf(principal);
        await postMessage(
          conv,
          principal,
          viewer,
          systemNote(
            `${who} created this ${plan.type === 'group' ? 'group' : 'announcement list'} and added ${listNames(plan.artistIds.map((a) => names[a]!))}`,
          ),
          who,
        );
        await audit(event, 'chat.create', 'success', { conversationId: id, kind: plan.type });
      }
      return json(201, { conversationId: conv.conversationId });
    }

    case 'PATCH /conversations/{conversationId}': {
      const conv = await loadReadable(viewer, conversationIdParam(event));
      if (conv.type === 'staff-group') return updateTeamGroup(conv);
      if (viewer.role === 'artist' || (conv.type !== 'group' && conv.type !== 'announcement'))
        throw new HttpError(403, 'Only Blueprint can change this');
      if (access(viewer, conv) !== 'read-write') throw new HttpError(403, 'Not your chat');
      const body = parseBody(event, UpdateConversation);
      const sets: string[] = [];
      const values: Record<string, unknown> = {};
      const notes: string[] = [];
      const who = await senderNameOf(principal);
      if (body.title !== undefined && body.title !== conv.title) {
        sets.push('title = :t');
        values[':t'] = body.title;
        notes.push(`${who} changed the name to “${body.title}”`);
      }
      if (body.description !== undefined) {
        sets.push('descriptionCipher = :d');
        values[':d'] = seal(
          await conversationKey(viewer, conv),
          body.description,
          conv.conversationId,
          'description',
        );
        notes.push(`${who} changed the description`);
      }
      if (body.settings && conv.type === 'group') {
        sets.push('settings = :s');
        values[':s'] = body.settings;
      }
      if (sets.length) {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: convPk(conv.conversationId), SK: CONV_META },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ExpressionAttributeValues: values,
          }),
        );
      }
      const updated = { ...conv, ...(body.title ? { title: body.title } : {}) };
      for (const n of notes) await postMessage(updated, principal, viewer, systemNote(n), who);
      if (!notes.length) await publish(channelsFor(conv), { conversationId: conv.conversationId });
      await audit(event, 'chat.update', 'success', { conversationId: conv.conversationId });
      return json(200, { conversationId: conv.conversationId });
    }

    case 'DELETE /conversations/{conversationId}': {
      const conv = await loadReadable(viewer, conversationIdParam(event));
      if (conv.type === 'staff-group') {
        // Team groups (rev 14): the group's own admins delete it, not Blueprint admins.
        if (!isGroupAdmin(viewer, conv))
          throw new HttpError(403, 'Only a group admin can delete this group');
      } else if (
        principal.role !== 'bmg-admin' ||
        (conv.type !== 'group' && conv.type !== 'announcement')
      )
        throw new HttpError(403, 'Only an admin can delete a group');
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: convPk(conv.conversationId), SK: CONV_META },
          UpdateExpression: 'SET deletedAt = :at',
          ExpressionAttributeValues: { ':at': new Date().toISOString() },
        }),
      );
      for (const m of members(conv)) {
        await db.send(
          new DeleteCommand({
            TableName: table(),
            Key: { PK: inboxPk(m), SK: inboxSk(conv.conversationId) },
          }),
        );
      }
      await publish(channelsFor(conv), { conversationId: conv.conversationId });
      await audit(event, 'chat.delete', 'success', { conversationId: conv.conversationId });
      return json(200, { deleted: conv.conversationId });
    }

    case 'POST /conversations/{conversationId}/members': {
      const conv = await loadReadable(viewer, conversationIdParam(event));
      if (conv.type === 'staff-group') return addTeamMembers(conv);
      if (!canAddMembers(viewer, conv)) throw new HttpError(403, 'You can’t add people here');
      const { artistIds } = parseBody(event, AddMembers);
      const adding = [...new Set(artistIds)].filter((a) => !conv.artistIds.includes(a));
      if (!adding.length) return json(200, { added: [] });
      const names = await artistNames(adding);
      if (adding.some((a) => !names[a])) throw new HttpError(404, 'No such artist');
      const next = [...conv.artistIds, ...adding].sort();
      // Staff can only build chats out of their own artists.
      if (
        viewer.role === 'bmg-staff' &&
        access(viewer, { ...conv, artistIds: next }) !== 'read-write'
      )
        throw new HttpError(403, 'You can only add your own artists');
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: convPk(conv.conversationId), SK: CONV_META },
          UpdateExpression: 'SET artistIds = :a',
          ExpressionAttributeValues: { ':a': next },
        }),
      );
      for (const a of adding) {
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: {
              PK: inboxPk(artistMember(a)),
              SK: inboxSk(conv.conversationId),
              conversationId: conv.conversationId,
            },
          }),
        );
      }
      const who = await senderNameOf(principal);
      await postMessage(
        { ...conv, artistIds: next },
        principal,
        viewer,
        systemNote(`${who} added ${listNames(adding.map((a) => names[a]!))}`),
        who,
      );
      await audit(event, 'chat.addMembers', 'success', { conversationId: conv.conversationId });
      return json(200, { added: adding });
    }

    case 'DELETE /conversations/{conversationId}/members/{artistId}': {
      const conv = await loadReadable(viewer, conversationIdParam(event));
      // Team groups (rev 14) put a team member's sub in the {artistId} slot (no new route).
      if (conv.type === 'staff-group')
        return removeTeamMember(conv, event.pathParameters?.artistId);
      const artistId = event.pathParameters?.artistId ?? '';
      if (conv.type !== 'group' && conv.type !== 'announcement')
        throw new HttpError(403, 'Only groups have members to remove');
      if (!conv.artistIds.includes(artistId)) throw new HttpError(404, 'Not a member');
      const leaving = viewer.role === 'artist' && viewer.artistId === artistId;
      if (!leaving && (viewer.role === 'artist' || access(viewer, conv) !== 'read-write'))
        throw new HttpError(403, 'Only Blueprint can remove people');
      if (conv.artistIds.length === 1 && !leaving)
        throw new HttpError(409, 'A group needs at least one artist. Delete the group instead.');
      const next = conv.artistIds.filter((a) => a !== artistId);
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: convPk(conv.conversationId), SK: CONV_META },
          UpdateExpression: 'SET artistIds = :a',
          ExpressionAttributeValues: { ':a': next },
        }),
      );
      await db.send(
        new DeleteCommand({
          TableName: table(),
          Key: { PK: inboxPk(artistMember(artistId)), SK: inboxSk(conv.conversationId) },
        }),
      );
      const name = (await artistNames([artistId]))[artistId] ?? 'An artist';
      const who = await senderNameOf(principal);
      // The note is written as Blueprint when an artist leaves (they're no longer a member).
      await postMessage(
        { ...conv, artistIds: next },
        principal,
        leaving ? { role: 'bmg-admin' } : viewer,
        systemNote(leaving ? `${name} left` : `${who} removed ${name}`),
        who,
      );
      await publish([`/inbox/artist-${artistId}`], { conversationId: conv.conversationId });
      await audit(event, 'chat.removeMember', 'success', { conversationId: conv.conversationId });
      return json(200, { removed: artistId });
    }

    case 'PATCH /conversations/{conversationId}/me': {
      const conv = await loadReadable(viewer, conversationIdParam(event));
      const body = parseBody(event, UpdateMine);
      const sets: string[] = ['conversationId = :id'];
      const values: Record<string, unknown> = { ':id': conv.conversationId };
      for (const k of ['pinned', 'muted', 'archived'] as const) {
        if (body[k] !== undefined) {
          sets.push(`${k} = :${k}`);
          values[`:${k}`] = body[k];
        }
      }
      if (body.clear) {
        sets.push('clearedAt = :c');
        values[':c'] = new Date().toISOString();
      }
      const meHere = memberFor(viewer, conv);
      if (body.star) {
        const row = await inboxRow(meHere, conv.conversationId);
        const starred = new Set(row?.starred ?? []);
        if (body.star.starred) starred.add(body.star.messageId);
        else starred.delete(body.star.messageId);
        sets.push('starred = :st');
        values[':st'] = [...starred].slice(-500);
      }
      if (body.react) {
        const reactions = await react(conv, principal, body.react);
        // Only a reaction: leave the inbox row alone.
        if (Object.keys(body).length === 1) return json(200, { reactions });
      }
      const res = await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: inboxPk(meHere), SK: inboxSk(conv.conversationId) },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      const row = res.Attributes as InboxRow;
      return json(200, { pinned: !!row.pinned, muted: !!row.muted, archived: !!row.archived });
    }

    case 'GET /conversations/{conversationId}/messages': {
      const conv = await loadReadable(viewer, conversationIdParam(event));
      const before = event.queryStringParameters?.before;
      if (before && !/^[\dT:.\-Z]+#?[a-z0-9-]*$/i.test(before))
        throw new HttpError(400, 'Bad cursor');
      const meHere = memberFor(viewer, conv);
      const row = await inboxRow(meHere, conv.conversationId);
      const items = (await latestMessages(conv.conversationId, 50, before)).filter(
        (m) => !row?.clearedAt || m.createdAt > row.clearedAt,
      );
      const key = items.length ? await conversationKey(viewer, conv) : undefined;
      const others = items.some((m) => m.senderSub === principal.sub)
        ? (await otherMembers(conv, meHere)).map((o) => o.state)
        : [];
      const starred = new Set(row?.starred ?? []);
      const messages = items.map((m) => {
        const p = openPayload(key!, m);
        const mine = m.senderSub === principal.sub && !m.system;
        return {
          messageId: m.messageId,
          createdAt: m.createdAt,
          kind: m.system || p.system ? 'system' : 'message',
          text: p.text,
          senderName: m.senderName,
          senderRole: m.senderRole,
          senderArtistId: m.senderArtistId ?? null,
          mine,
          ...(mine ? { ticks: ticks(m.createdAt, others) } : {}),
          starred: starred.has(m.messageId),
          reactions: m.system ? [] : reactionSummary(m.reactions, principal.sub),
          replyTo: p.replyTo ?? null,
          attachment: p.attachment ?? null,
        };
      });
      const firstUnread = messages.find(
        (m) =>
          !m.mine && m.kind === 'message' && (!row?.lastReadAt || m.createdAt > row.lastReadAt),
      );
      await markRead(viewer, conv);
      // Senders see their ticks turn coral.
      if (firstUnread)
        await publish(channelsFor(conv), { conversationId: conv.conversationId, read: true });
      const team = isStaffType(conv.type) ? await activeTeam() : new Map<string, Person>();
      const blocked = teamSendBlock(viewer, conv, team);
      return json(200, {
        conversationId: conv.conversationId,
        type: publicType(conv.type),
        access: access(viewer, conv),
        canSend: canSend(viewer, conv) && !blocked,
        ...(blocked ? { readOnlyReason: blocked } : {}),
        ...(isStaffType(conv.type) ? teamDetails(viewer, conv, team) : {}),
        firstUnreadMessageId: row?.lastReadAt ? (firstUnread?.messageId ?? null) : null,
        messages,
        nextBefore: items.length === 50 ? `${items[0]!.createdAt}#${items[0]!.messageId}` : null,
      });
    }

    case 'POST /conversations/{conversationId}/messages': {
      const conv = await loadReadable(viewer, conversationIdParam(event));
      if (!canSend(viewer, conv))
        throw new HttpError(
          403,
          isAnnouncementType(conv.type)
            ? 'Only Blueprint posts here. Reply privately in your chat with Blueprint.'
            : 'Only admins can send messages in this group',
        );
      const body = parseBody(event, NewMessage);
      const refused =
        sendRefused(viewer, conv, body.attachment?.kind, await accessRules(viewer)) ??
        (conv.type === 'staff-direct' ? teamSendBlock(viewer, conv, await activeTeam()) : null);
      if (refused) throw new HttpError(403, refused);
      if (body.attachment?.kind === 'file' && !canShareFiles(viewer, conv))
        throw new HttpError(403, 'Artists can’t share files in this group');
      let replyTo: Payload['replyTo'];
      if (body.replyTo) {
        const sourceId = body.replyTo.conversationId ?? conv.conversationId;
        const source =
          sourceId === conv.conversationId ? conv : await loadReadable(viewer, sourceId);
        const quoted = await findMessage(source.conversationId, body.replyTo.messageId);
        if (!quoted) throw new HttpError(404, 'That message is gone');
        replyTo = quoteOf(
          quoted.messageId,
          quoted.senderName,
          openPayload(await conversationKey(viewer, source), quoted),
        );
      }
      const senderName = await senderNameOf(principal, conv);
      const posted = await postMessage(
        conv,
        principal,
        viewer,
        {
          text: body.text,
          ...(replyTo ? { replyTo } : {}),
          ...(body.attachment ? { attachment: body.attachment } : {}),
        },
        senderName,
      );
      if (body.attachment?.kind === 'file') await recordFileUse(conv, body.attachment);
      return json(201, posted);
    }

    case 'GET /directory': {
      // Artists can start a chat with another artist, so they see names only.
      // With artist chats and artist groups both off, they don't need the list.
      if (viewer.role === 'artist') {
        const rules = await accessRules(viewer);
        if (!rules.artistDirectChats && !rules.artistGroups) return json(200, { artists: [] });
      }
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': ROSTER_GSI1PK },
          Limit: 200,
        }),
      );
      const artists = (res.Items ?? [])
        .filter((p) => p.artistId !== principal.artistId)
        .filter(
          (p) =>
            viewer.role !== 'bmg-staff' || viewer.assignedArtistIds?.includes(p.artistId as string),
        )
        .map((p) => ({ artistId: p.artistId as string, displayName: p.displayName as string }));
      if (viewer.role === 'artist') return json(200, { artists });
      // The Blueprint team, for team chats (rev 14): working logins only, with "last seen".
      const team = [...(await activeTeam()).values()].slice(0, 100);
      const seen = team.length
        ? ((
            await db.send(
              new BatchGetCommand({
                RequestItems: {
                  [table()]: { Keys: team.map((p) => presenceKey(staffMember(p.sub))) },
                },
              }),
            )
          ).Responses?.[table()] ?? [])
        : [];
      const lastSeen = new Map(seen.map((i) => [i.PK as string, i.lastOnlineAt as string]));
      return json(200, {
        artists,
        team: team
          .map((p) => ({
            sub: p.sub,
            displayName: p.displayName,
            jobTitle: p.jobTitle,
            me: p.sub === principal.sub,
            lastSeen: lastSeen.get(presenceKey(staffMember(p.sub)).PK) ?? null,
          }))
          .sort(
            (x, y) => Number(y.me) - Number(x.me) || x.displayName.localeCompare(y.displayName),
          ),
      });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
