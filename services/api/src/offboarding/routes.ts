import { randomUUID } from 'node:crypto';
import {
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authorize, type Principal } from '@bmg/authz';
import { isArtistId } from '@bmg/crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { z } from 'zod';
import { audit, db, env, HttpError, json, parseBody, publish } from '../lib.ts';
import { DisplayName, renameArtist } from '../people/names.ts';
import {
  countItems,
  DELETE_STEP_UP_SECONDS,
  DeleteBody,
  deletionKey,
  DELETIONS_GSI1PK,
  emptyCounts,
  nameMatches,
  publicDeletion,
  upcomingGigs,
  type DeletionRecord,
} from './model.ts';

/**
 * Rev 22 routes on the Access proxy (no new API resources):
 *   PATCH /access/artists/{id}              rename an artist (assigned staff, admins)
 *   GET   /access/artists/{id}/delete       admin: what deleting them would do
 *   POST  /access/artists/{id}/delete       admin, fresh step-up: start deleting
 *   GET   /access/deletions                 admin: deleted (and deleting) artists
 *   GET   /access/deletions/{id}            admin: one deletion
 *   POST  /access/deletions/{id}/retry      admin: carry on from a paused step
 * Starting a deletion locks the artist at once (login off, signed out, off the
 * roster); the offboarding worker does the rest from the `artist.deleteRequested` event.
 */
const cognito = new CognitoIdentityProviderClient({});
const table = () => env('MAIN_TABLE');
const profileKey = (artistId: string) => ({ PK: `ARTIST#${artistId}`, SK: 'PROFILE' });

const RenameBody = z.object({ displayName: DisplayName }).strict();

function requireAdmin(principal: Principal) {
  const d = authorize(principal, 'admin', { kind: 'org-admin' });
  if (!d.allow) throw new HttpError(403, 'Only a Blueprint admin can delete an artist');
}

async function profile(artistId: string) {
  const item = (await db.send(new GetCommand({ TableName: table(), Key: profileKey(artistId) })))
    .Item;
  if (!item) throw new HttpError(404, 'No such artist');
  return item;
}

async function nameOf(sub: string): Promise<string> {
  const p = (
    await db.send(new GetCommand({ TableName: table(), Key: { PK: `USER#${sub}`, SK: 'PROFILE' } }))
  ).Item;
  return String(p?.displayName ?? 'Blueprint');
}

async function queryAll(pk: string, projection?: string) {
  const out: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ...(projection ? { ProjectionExpression: projection } : {}),
        ExclusiveStartKey: start,
      }),
    );
    out.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** What the confirm screen shows: counts, chats and anything blocking. */
async function preview(artistId: string) {
  const p = await profile(artistId);
  const [items, inbox] = await Promise.all([
    queryAll(`ARTIST#${artistId}`),
    queryAll(`INBOX#ARTIST#${artistId}`, 'SK'),
  ]);
  const gigs = items.filter((i) => String(i.SK).startsWith('GIG#') && i.type !== 'gigMedia');
  return {
    artistId,
    displayName: String(p.displayName ?? ''),
    status: String(p.status ?? ''),
    counts: countItems(
      items.map((i) => String(i.SK)),
      inbox.length,
    ),
    upcomingGigs: upcomingGigs(gigs, new Date()),
  };
}

export async function artistAccessRoutes(
  event: APIGatewayProxyEvent,
  principal: Principal,
  path: string,
  method: string,
): Promise<APIGatewayProxyResult> {
  const parts = path.split('/');

  // ── Rename ──
  if (parts[0] === 'artists' && parts.length === 2 && method === 'PATCH') {
    const artistId = parts[1];
    if (!isArtistId(artistId)) throw new HttpError(404, 'No such artist');
    const d = authorize(principal, 'write', {
      kind: 'artist-data',
      artistId,
      visibility: 'normal',
    });
    if (!d.allow) throw new HttpError(403, 'You can only rename artists you work with');
    const { displayName } = parseBody(event, RenameBody);
    const changed = await renameArtist(artistId, displayName);
    if (changed.before !== changed.after) {
      await audit(event, 'artist.rename', 'success', { artistId });
      // The artist hears when Blueprint changes their name (not when they do it themselves).
      if (principal.role !== 'artist')
        await publish('artist.renamed', {
          artistId,
          name: displayName,
          bySub: principal.sub,
          byName: await nameOf(principal.sub),
        });
    }
    return json(200, { artistId, displayName });
  }

  // ── Delete: preview and start ──
  if (parts[0] === 'artists' && parts.length === 3 && parts[2] === 'delete') {
    const artistId = parts[1];
    if (!isArtistId(artistId)) throw new HttpError(404, 'No such artist');
    requireAdmin(principal);
    if (method === 'GET') return json(200, await preview(artistId));
    if (method !== 'POST') throw new HttpError(404, 'Not found');
    if (principal.secondsSinceAuth > DELETE_STEP_UP_SECONDS) {
      await audit(event, 'artist.delete', 'denied', { artistId, reason: 'step-up' });
      throw new HttpError(403, 'Deleting an artist needs a fresh step-up');
    }
    const body = parseBody(event, DeleteBody);
    const look = await preview(artistId);
    if (look.status === 'deleting' || look.status === 'deleted')
      throw new HttpError(409, 'This artist is already being deleted');
    if (!nameMatches(body.confirmName, look.displayName))
      throw new HttpError(400, `Type ${look.displayName} exactly to confirm`);
    if (look.upcomingGigs.length > 0 && !body.acknowledgeUpcoming)
      throw new HttpError(
        409,
        `They have ${look.upcomingGigs.length} gig${look.upcomingGigs.length === 1 ? '' : 's'} in the next 7 days. Tick the box to delete anyway.`,
      );
    return json(
      202,
      await startDeletion(event, principal, artistId, look.displayName, look.counts, body),
    );
  }

  // ── Deleted list, one deletion, retry ──
  if (parts[0] === 'deletions') {
    requireAdmin(principal);
    if (parts.length === 1 && method === 'GET') {
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': DELETIONS_GSI1PK },
          ScanIndexForward: false,
          Limit: 100,
        }),
      );
      return json(200, {
        deletions: (res.Items ?? []).map((i) => publicDeletion(i as unknown as DeletionRecord)),
      });
    }
    const artistId = parts[1];
    if (!isArtistId(artistId)) throw new HttpError(404, 'No such deletion');
    const rec = (await db.send(new GetCommand({ TableName: table(), Key: deletionKey(artistId) })))
      .Item as DeletionRecord | undefined;
    if (!rec) throw new HttpError(404, 'No such deletion');
    if (parts.length === 2 && method === 'GET') return json(200, publicDeletion(rec));
    if (parts.length === 3 && parts[2] === 'retry' && method === 'POST') {
      if (rec.status !== 'paused')
        throw new HttpError(409, 'Only a paused deletion can be retried');
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: deletionKey(artistId),
          UpdateExpression: 'SET #s = :running REMOVE #e',
          ConditionExpression: '#s = :paused',
          ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
          ExpressionAttributeValues: { ':running': 'running', ':paused': 'paused' },
        }),
      );
      await publish('artist.deleteRequested', { artistId, deletionId: rec.deletionId });
      await audit(event, 'artist.deleteRetry', 'success', { artistId, step: rec.step });
      return json(202, publicDeletion({ ...rec, status: 'running' }));
    }
  }
  throw new HttpError(404, 'Not found');
}

/**
 * Locks the artist straight away and hands over to the worker:
 * 1. their roster entry is marked `deleting` and taken off the roster (GSI1);
 * 2. their login is turned off and signed out everywhere;
 * 3. a pending invitation is revoked;
 * 4. the deletion record is written and `artist.deleteRequested` goes on the bus.
 */
async function startDeletion(
  event: APIGatewayProxyEvent,
  principal: Principal,
  artistId: string,
  displayName: string,
  counts: ReturnType<typeof emptyCounts>,
  body: z.infer<typeof DeleteBody>,
) {
  const now = new Date().toISOString();
  try {
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: profileKey(artistId),
        UpdateExpression:
          'SET #s = :deleting, deletingAt = :at, deletedBy = :by REMOVE GSI1PK, GSI1SK',
        ConditionExpression: 'attribute_exists(PK) AND NOT #s IN (:deleting, :deleted)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':deleting': 'deleting',
          ':deleted': 'deleted',
          ':at': now,
          ':by': principal.sub,
        },
      }),
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException')
      throw new HttpError(409, 'This artist is already being deleted');
    throw err;
  }

  const contact = (
    await db.send(
      new GetCommand({ TableName: table(), Key: { PK: `ARTIST#${artistId}`, SK: 'CONTACT' } }),
    )
  ).Item as { email?: string } | undefined;
  const email = contact?.email;
  let sub: string | undefined;
  if (email) {
    try {
      const user = await cognito.send(
        new AdminGetUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }),
      );
      sub = user.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
      await cognito.send(
        new AdminDisableUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }),
      );
      await cognito.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }),
      );
    } catch (err) {
      if ((err as Error).name !== 'UserNotFoundException') throw err;
    }
    // A pending invitation stops working (pre sign-up checks it for social sign-in).
    await db
      .send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: `INVITE#${email}`, SK: 'INVITE' },
          UpdateExpression: 'SET #s = :revoked, revokedAt = :at',
          ConditionExpression: 'attribute_exists(PK) AND artistId = :a',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':revoked': 'revoked', ':at': now, ':a': artistId },
        }),
      )
      .catch((err: Error) => {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
      });
  }

  const record: DeletionRecord = {
    artistId,
    deletionId: `${now.slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`,
    displayName,
    names: [displayName],
    reason: body.reason,
    ...(body.note ? { note: body.note } : {}),
    emailArtist: body.emailArtist,
    ...(email ? { email } : {}),
    ...(sub ? { sub } : {}),
    by: principal.sub,
    byName: await nameOf(principal.sub),
    startedAt: now,
    status: 'running',
    step: 'ai',
    stepsDone: [],
    counts,
    mentions: [],
  };
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        ...deletionKey(artistId),
        type: 'artistDeletion',
        ...record,
        GSI1PK: DELETIONS_GSI1PK,
        GSI1SK: `${now}#${artistId}`,
      },
    }),
  );
  await publish('artist.deleteRequested', { artistId, deletionId: record.deletionId });
  await audit(event, 'artist.delete', 'success', {
    artistId,
    reason: body.reason,
    files: counts.files,
    chats: counts.chats,
  });
  return publicDeletion(record);
}
