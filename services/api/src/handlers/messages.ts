import { randomUUID } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  BatchGetCommand,
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
  artistMember,
  BMG_MEMBER,
  BROADCAST_ID,
  channelsFor,
  CONV_META,
  CONVERSATION_ID_PATTERN,
  convPk,
  inboxPk,
  inboxSk,
  members,
  messageSk,
  newConversationKey,
  NewConversation,
  NewMessage,
  open,
  planConversation,
  seal,
  wrapContext,
  type Conversation,
  type Viewer,
} from '../messages/model.ts';
import { publish } from '../realtime.ts';
import { ROSTER_GSI1PK } from '../workspace/model.ts';
import { authContext, db, env, handle, HttpError, json, parseBody, principalFor } from '../lib.ts';

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
}

const viewerOf = (p: Principal): Viewer => ({
  role: p.role,
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
        EncryptionContext: wrapContext(c.conversationId),
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
        EncryptionContext: wrapContext(c.conversationId),
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
  c: Pick<Conversation, 'conversationId' | 'type' | 'artistIds' | 'title'>,
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

function memberFor(viewer: Viewer): string {
  return viewer.role === 'artist' ? artistMember(viewer.artistId!) : BMG_MEMBER;
}

async function markRead(viewer: Viewer, conversationId: string) {
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: inboxPk(memberFor(viewer)), SK: inboxSk(conversationId) },
      UpdateExpression: 'SET conversationId = :id, lastReadAt = :at',
      ExpressionAttributeValues: { ':id': conversationId, ':at': new Date().toISOString() },
    }),
  );
}

function conversationIdParam(event: APIGatewayProxyEvent): string {
  const id = event.pathParameters?.conversationId ?? '';
  if (!CONVERSATION_ID_PATTERN.test(id)) throw new HttpError(404, 'No such conversation');
  return id;
}

/**
 * Messages & groups. Every request checks access against the stored
 * conversation; content is sealed with a per-conversation key, and
 * artist-to-artist keys only open in an artist session for a member.
 */
export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const viewer = viewerOf(principal);
  const route = `${event.httpMethod} ${event.resource}`;

  switch (route) {
    case 'GET /conversations': {
      const inbox = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
          ExpressionAttributeValues: { ':pk': inboxPk(memberFor(viewer)), ':c': 'CONV#' },
          Limit: 200,
        }),
      );
      const rows = (inbox.Items ?? []) as { conversationId: string; lastReadAt?: string }[];
      const readAt = Object.fromEntries(rows.map((r) => [r.conversationId, r.lastReadAt]));
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
        .filter((c) => access(viewer, c) !== 'none');
      const names = await artistNames(convs.flatMap((c) => c.artistIds));
      const list = await Promise.all(
        convs.map(async (c) => {
          const [last] = await latestMessages(c.conversationId, 1);
          let preview: string | null = null;
          if (last) {
            const text = open(
              await conversationKey(viewer, c),
              last.cipher,
              c.conversationId,
              last.messageId,
            );
            preview = `${last.senderSub === principal.sub ? 'You: ' : ''}${text}`.slice(0, 120);
          }
          return {
            conversationId: c.conversationId,
            type: c.type,
            title:
              c.type === 'broadcast'
                ? 'All artists'
                : c.type === 'group'
                  ? (c.title ?? 'Group')
                  : c.type === 'bmg-artist'
                    ? viewer.role === 'artist'
                      ? 'Blueprint'
                      : (names[c.artistIds[0]!] ?? 'Artist')
                    : (names[c.artistIds.find((id) => id !== viewer.artistId)!] ?? 'Artist'),
            artists: c.artistIds.map((id) => ({
              artistId: id,
              displayName: names[id] ?? 'Artist',
            })),
            access: access(viewer, c),
            lastMessageAt: c.lastMessageAt ?? null,
            preview,
            unread:
              !!c.lastMessageAt &&
              (!readAt[c.conversationId] || readAt[c.conversationId]! < c.lastMessageAt),
          };
        }),
      );
      list.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
      return json(200, { conversations: list });
    }

    case 'POST /conversations': {
      const body = parseBody(event, NewConversation);
      const plan = planConversation(viewer, body);
      if (!plan.ok) throw new HttpError(403, plan.reason);
      if (plan.artistIds.some((id) => !/^art_/.test(id)))
        throw new HttpError(400, 'Unknown artist');
      // Every artist must exist (and, for staff, be theirs to message).
      const names = await artistNames(plan.artistIds);
      if (plan.artistIds.some((id) => !names[id])) throw new HttpError(404, 'No such artist');
      const id =
        plan.type === 'group'
          ? `grp-${randomUUID().replace(/-/g, '').slice(0, 20)}`
          : plan.conversationId;
      if (access(viewer, { type: plan.type, artistIds: plan.artistIds }) !== 'read-write') {
        throw new HttpError(403, 'You can’t start this conversation');
      }
      const existing = plan.type === 'group' ? undefined : await getConversation(id);
      const conv =
        existing ??
        (await createConversation(
          {
            conversationId: id,
            type: plan.type,
            artistIds: plan.artistIds,
            ...(plan.title ? { title: plan.title } : {}),
          },
          principal.sub,
        ));
      return json(existing ? 200 : 201, { conversationId: conv.conversationId });
    }

    case 'GET /conversations/{conversationId}/messages': {
      const conv = await getConversation(conversationIdParam(event));
      if (!conv || access(viewer, conv) === 'none')
        throw new HttpError(404, 'No such conversation');
      const before = event.queryStringParameters?.before;
      if (before && !/^[\dT:.\-Z]+#?[a-z0-9-]*$/i.test(before))
        throw new HttpError(400, 'Bad cursor');
      const items = await latestMessages(conv.conversationId, 50, before);
      const key = items.length ? await conversationKey(viewer, conv) : undefined;
      const messages = items.map((m) => ({
        messageId: m.messageId,
        text: open(key!, m.cipher, conv.conversationId, m.messageId),
        senderName: m.senderName,
        senderRole: m.senderRole,
        mine: m.senderSub === principal.sub,
        createdAt: m.createdAt,
      }));
      await markRead(viewer, conv.conversationId);
      return json(200, {
        conversationId: conv.conversationId,
        type: conv.type,
        access: access(viewer, conv),
        messages,
        nextBefore: items.length === 50 ? `${items[0]!.createdAt}#${items[0]!.messageId}` : null,
      });
    }

    case 'POST /conversations/{conversationId}/messages': {
      const conv = await getConversation(conversationIdParam(event));
      if (!conv || access(viewer, conv) === 'none')
        throw new HttpError(404, 'No such conversation');
      if (access(viewer, conv) !== 'read-write')
        throw new HttpError(403, 'Only Blueprint posts here');
      const { text } = parseBody(event, NewMessage);
      const messageId = randomUUID();
      const at = new Date().toISOString();
      const senderName =
        principal.role === 'artist'
          ? ((await artistNames([principal.artistId!]))[principal.artistId!] ?? 'Artist')
          : 'Blueprint';
      const msg: StoredMessage = {
        messageId,
        conversationId: conv.conversationId,
        senderSub: principal.sub,
        senderRole: principal.role,
        ...(principal.artistId ? { senderArtistId: principal.artistId } : {}),
        senderName,
        cipher: seal(await conversationKey(viewer, conv), text, conv.conversationId, messageId),
        createdAt: at,
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
      await markRead(viewer, conv.conversationId);
      await publish(channelsFor(conv), { conversationId: conv.conversationId, at });
      // For notifications: ids, the sender's name and the group name only, never the text.
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
                ...(conv.type === 'group' && conv.title ? { title: conv.title } : {}),
              }),
            },
          ],
        }),
      );
      return json(201, { messageId, createdAt: at });
    }

    case 'GET /directory': {
      // Artists can start a chat with another artist, so they see names only.
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
        .map((p) => ({ artistId: p.artistId as string, displayName: p.displayName as string }));
      return json(200, { artists });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
