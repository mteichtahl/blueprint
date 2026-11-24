import { createHash } from 'node:crypto';
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { artistKeyAlias, DataAccessSessions } from '@bmg/crypto';
import { accountClosedEmail, appOrigin, sendMail } from '@bmg/email';
import { purgeKb } from '../ai/kb-ops.ts';
import { LIBRARY_PK } from '../files/model.ts';
import { db, env, publish } from '../lib.ts';
import {
  ARCHIVE_TAG,
  fileIdOf,
  archivedObjectKey,
  archivePrefix,
  chatAction,
  deletionKey,
  isLiveObject,
  livePrefix,
  mentionFor,
  nextStep,
  RETENTION_YEARS,
  retainUntil,
  STEPS,
  without,
  type DeletionRecord,
  type Mention,
  type Step,
} from './model.ts';

/**
 * The offboarding worker (rev 22). Runs each step of a deletion in order and
 * records it on the deletion record, so a retry starts where it stopped and
 * a step that already ran does nothing harmful the second time.
 *
 * Archiving happens inside the artist's own prefix in the artist bucket
 * (`artists/<id>/archive/<deletionId>/`), as server-side copies under the
 * artist's own key and encryption context. So the archive is exactly as
 * protected as the live data was: private files and private chats stay closed
 * to Blueprint. The copies carry the `bmg-archive` tag, which the bucket's
 * lifecycle rule deletes after 7 years.
 */

const cognito = new CognitoIdentityProviderClient({});
const bus = new EventBridgeClient({});
const sessions = new DataAccessSessions();
const table = () => env('MAIN_TABLE');
const tagging = `${ARCHIVE_TAG.key}=${ARCHIVE_TAG.value}`;

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', event, ...fields }));

// ── Small helpers ──

async function queryAll(
  pk: string,
  opts: { prefix?: string; projection?: string } = {},
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: opts.prefix ? 'PK = :pk AND begins_with(SK, :p)' : 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk, ...(opts.prefix ? { ':p': opts.prefix } : {}) },
        ...(opts.projection ? { ProjectionExpression: opts.projection } : {}),
        ExclusiveStartKey: start,
      }),
    );
    out.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

async function deleteKeys(keys: { PK: string; SK: string }[]) {
  for (let i = 0; i < keys.length; i += 25) {
    let request: Record<string, { DeleteRequest: { Key: Record<string, unknown> } }[]> = {
      [table()]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })),
    };
    for (let tries = 0; tries < 6 && Object.keys(request).length; tries++) {
      if (tries) await new Promise((r) => setTimeout(r, 100 * 2 ** tries));
      const res = await db.send(new BatchWriteCommand({ RequestItems: request }));
      request = (res.UnprocessedItems ?? {}) as typeof request;
    }
    if (Object.keys(request).length) throw new Error('Some items could not be deleted');
  }
}

const keyOf = (i: Record<string, unknown>) => ({ PK: String(i.PK), SK: String(i.SK) });

/** JSON that keeps binary attributes (sealed values) as base64. */
function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) =>
      v instanceof Uint8Array ? { $binary: Buffer.from(v).toString('base64') } : v,
    2,
  );
}

async function artistS3(artistId: string): Promise<S3Client> {
  // An `artist` session: the only one KMS lets copy private items. The worker
  // never reads object bodies; S3 copies them server-side under the same key
  // and encryption context, so nothing private is opened to Blueprint.
  const credentials = await sessions.credentials({
    roleArn: env('DATA_ACCESS_ROLE_ARN'),
    artistId,
    role: 'artist',
  });
  return new S3Client({ credentials });
}

async function listLive(s3: S3Client, artistId: string) {
  const out: { key: string; bytes: number }[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: env('ARTIST_BUCKET'),
        Prefix: livePrefix(artistId),
        ContinuationToken: token,
      }),
    );
    for (const o of res.Contents ?? [])
      if (o.Key && isLiveObject(artistId, o.Key)) out.push({ key: o.Key, bytes: o.Size ?? 0 });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

const keyArn = (artistId: string) =>
  `arn:aws:kms:${env('AWS_REGION')}:${env('ACCOUNT_ID')}:${artistKeyAlias(env('PROJECT'), env('BMG_ENV'), artistId)}`;
const context64 = (c: Record<string, string>) => Buffer.from(JSON.stringify(c)).toString('base64');

async function putArchiveJson(s3: S3Client, artistId: string, key: string, body: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: env('ARTIST_BUCKET'),
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: keyArn(artistId),
      SSEKMSEncryptionContext: context64({ artistId }),
      Tagging: tagging,
    }),
  );
  return createHash('sha256').update(body).digest('hex');
}

/** Every conversation the artist is in, with what happens to it. */
async function conversationsOf(artistId: string) {
  const rows = await queryAll(`INBOX#ARTIST#${artistId}`);
  const ids = rows.map((r) => String(r.conversationId ?? String(r.SK).slice('CONV#'.length)));
  const metas: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const res = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table()]: {
            Keys: ids.slice(i, i + 100).map((id) => ({ PK: `CONV#${id}`, SK: 'META' })),
          },
        },
      }),
    );
    metas.push(...(res.Responses?.[table()] ?? []));
  }
  // Their chat with Blueprint has an inbox row for Blueprint, not always for them.
  const dm = (
    await db.send(
      new GetCommand({ TableName: table(), Key: { PK: `CONV#dm-${artistId}`, SK: 'META' } }),
    )
  ).Item;
  if (dm && !metas.some((m) => m.conversationId === dm.conversationId)) metas.push(dm);
  return metas.map((m) => ({
    conversationId: String(m.conversationId),
    type: String(m.type),
    action: chatAction(artistId, String(m.conversationId), String(m.type)),
    meta: m,
  }));
}

async function save(rec: DeletionRecord, fields: Partial<DeletionRecord>) {
  const sets = Object.keys(fields).map((k, i) => `#k${i} = :v${i}`);
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: deletionKey(rec.artistId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(
        Object.keys(fields).map((k, i) => [`#k${i}`, k]),
      ),
      ExpressionAttributeValues: Object.fromEntries(
        Object.values(fields).map((v, i) => [`:v${i}`, v]),
      ),
    }),
  );
  Object.assign(rec, fields);
}

// ── Steps ──

/** 1. Their knowledge base goes, and Blueprint's library is checked for mentions. */
async function stepAi(rec: DeletionRecord) {
  await purgeKb(rec.artistId);
  const files = await queryAll(LIBRARY_PK, { prefix: 'FILE#' });
  const mentions: Mention[] = [];
  for (const f of files) {
    const m = mentionFor(
      f as { fileId: string; name?: string; title?: string; sharedWithArtistIds?: string[] },
      rec.artistId,
      rec.names,
    );
    if (m) mentions.push(m);
  }
  await save(rec, { mentions: mentions.slice(0, 200) });
}

/** 2. Data and files are copied into the archive, then checked. */
async function stepArchive(rec: DeletionRecord) {
  const s3 = await artistS3(rec.artistId);
  const prefix = archivePrefix(rec.artistId, rec.deletionId);
  const data: { name: string; items: number; sha256: string }[] = [];
  const add = async (name: string, items: Record<string, unknown>[]) => {
    const sha256 = await putArchiveJson(s3, rec.artistId, `${prefix}data/${name}`, toJson(items));
    data.push({ name, items: items.length, sha256 });
  };

  // Workspace items, without connector tokens (nothing to keep them for).
  const items = (await queryAll(`ARTIST#${rec.artistId}`)).filter(
    (i) => !String(i.SK).startsWith('CONN#'),
  );
  await add('workspace.json', items);

  // Chats, as stored: sealed values stay sealed under the keys they were sealed with.
  for (const c of await conversationsOf(rec.artistId)) {
    if (c.action !== 'archive-remove' && c.action !== 'archive-close') continue;
    await add(`chats/${c.conversationId}.json`, await queryAll(`CONV#${c.conversationId}`));
  }
  if (rec.sub) {
    await add(
      'account.json',
      (await queryAll(`USER#${rec.sub}`)).filter((i) => i.SK === 'PROFILE' || i.SK === 'PREFS'),
    );
  }

  // Files: server-side copies under the same key and context. A private file's
  // copy keeps visibility=private, so KMS still refuses it to every Blueprint role.
  const privateFiles = new Set(
    items
      .filter((i) => String(i.SK).startsWith('FILE#') && i.visibility === 'private')
      .map((i) => String(i.fileId)),
  );
  const live = await listLive(s3, rec.artistId);
  for (const o of live) {
    await s3.send(
      new CopyObjectCommand({
        Bucket: env('ARTIST_BUCKET'),
        Key: archivedObjectKey(rec.artistId, rec.deletionId, o.key),
        CopySource: `${env('ARTIST_BUCKET')}/${o.key.split('/').map(encodeURIComponent).join('/')}`,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: keyArn(rec.artistId),
        SSEKMSEncryptionContext: context64(
          privateFiles.has(fileIdOf(rec.artistId, o.key) ?? '')
            ? { artistId: rec.artistId, visibility: 'private' }
            : { artistId: rec.artistId },
        ),
        TaggingDirective: 'REPLACE',
        Tagging: tagging,
      }),
    );
  }
  // Check: every copy is there, the same size.
  for (const o of live) {
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: env('ARTIST_BUCKET'),
        Key: archivedObjectKey(rec.artistId, rec.deletionId, o.key),
      }),
    );
    if ((head.ContentLength ?? -1) !== o.bytes)
      throw new Error('An archived file is not the same size as the original');
  }
  const bytes = live.reduce((n, o) => n + o.bytes, 0);
  const until = retainUntil(new Date());
  await putArchiveJson(
    s3,
    rec.artistId,
    `${prefix}manifest.json`,
    toJson({
      artistId: rec.artistId,
      deletionId: rec.deletionId,
      deletedBy: rec.by,
      reason: rec.reason,
      startedAt: rec.startedAt,
      archivedAt: new Date().toISOString(),
      retainUntil: until,
      appVersion: process.env.BMG_VERSION ?? null,
      counts: rec.counts,
      data,
      files: live.map((o) => ({
        key: o.key.slice(livePrefix(rec.artistId).length),
        bytes: o.bytes,
      })),
    }),
  );
  await save(rec, {
    archive: {
      bucket: env('ARTIST_BUCKET'),
      prefix,
      objects: live.length,
      bytes,
      items: data.reduce((n, d) => n + d.items, 0),
    },
    retainUntil: until,
  });
}

/** 3. Out of chats, library sharing and staff assignments. */
async function stepUnlink(rec: DeletionRecord) {
  const id = rec.artistId;
  for (const c of await conversationsOf(id)) {
    if (c.action === 'leave') {
      const { list, changed } = without(c.meta.artistIds as string[] | undefined, id);
      if (changed)
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: `CONV#${c.conversationId}`, SK: 'META' },
            UpdateExpression: 'SET artistIds = :ids',
            ExpressionAttributeValues: { ':ids': list },
          }),
        );
    } else if (c.action === 'archive-close') {
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: `CONV#${c.conversationId}`, SK: 'META' },
          UpdateExpression: 'SET closedReason = :r, closedAt = :at',
          ExpressionAttributeValues: {
            ':r': 'This artist is no longer at Blueprint',
            ':at': new Date().toISOString(),
          },
        }),
      );
    }
  }

  for (const f of await queryAll(LIBRARY_PK, { prefix: 'FILE#' })) {
    const { list, changed } = without(f.sharedWithArtistIds as string[] | undefined, id);
    if (!changed) continue;
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: keyOf(f),
        UpdateExpression: 'SET sharedWithArtistIds = :ids',
        ExpressionAttributeValues: { ':ids': list },
      }),
    );
  }

  let token: string | undefined;
  const subs: string[] = [];
  do {
    const page = await cognito.send(
      new ListUsersInGroupCommand({
        UserPoolId: env('USER_POOL_ID'),
        GroupName: 'bmg-staff',
        NextToken: token,
        Limit: 60,
      }),
    );
    for (const u of page.Users ?? []) {
      const sub = u.Attributes?.find((a) => a.Name === 'sub')?.Value;
      if (sub) subs.push(sub);
    }
    token = page.NextToken;
  } while (token);
  for (const sub of subs) {
    const a = (
      await db.send(
        new GetCommand({ TableName: table(), Key: { PK: `STAFF#${sub}`, SK: 'ASSIGNMENTS' } }),
      )
    ).Item;
    const { list, changed } = without(a?.artistIds as string[] | undefined, id);
    if (!changed) continue;
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: `STAFF#${sub}`, SK: 'ASSIGNMENTS' },
        UpdateExpression: 'SET artistIds = :ids, updatedAt = :at',
        ExpressionAttributeValues: { ':ids': list, ':at': new Date().toISOString() },
      }),
    );
  }
}

/** 4. The live copies go: files, workspace items, their chat with Blueprint, inbox and account items. */
async function stepRemove(rec: DeletionRecord) {
  const id = rec.artistId;
  const s3 = await artistS3(id);
  for (const o of await listLive(s3, id))
    await s3.send(new DeleteObjectCommand({ Bucket: env('ARTIST_BUCKET'), Key: o.key }));

  const keys: { PK: string; SK: string }[] = [];
  for (const c of await conversationsOf(id)) {
    if (c.action === 'archive-remove') {
      keys.push(
        ...(await queryAll(`CONV#${c.conversationId}`, { projection: 'PK, SK' })).map(keyOf),
      );
      keys.push({ PK: 'INBOX#BMG', SK: `CONV#${c.conversationId}` });
    }
  }
  keys.push(...(await queryAll(`INBOX#ARTIST#${id}`, { projection: 'PK, SK' })).map(keyOf));
  keys.push({ PK: `PRESENCE#ARTIST#${id}`, SK: 'STATE' });
  if (rec.sub) {
    keys.push(...(await queryAll(`USER#${rec.sub}`, { projection: 'PK, SK' })).map(keyOf));
    keys.push(...(await queryAll(`NOTIF#${rec.sub}`, { projection: 'PK, SK' })).map(keyOf));
  }
  if (rec.email) keys.push({ PK: `INVITE#${rec.email}`, SK: 'INVITE' });
  // The workspace last, so a retry can still find the chats above.
  keys.push(...(await queryAll(`ARTIST#${id}`, { projection: 'PK, SK' })).map(keyOf));
  await deleteKeys(keys);
}

/** 5. The login goes; the email, if the admin asked for it. */
async function stepLogin(rec: DeletionRecord) {
  if (rec.email) {
    if (rec.emailArtist) {
      try {
        await sendMail(
          rec.email,
          accountClosedEmail(
            { appOrigin: await appOrigin() },
            { displayName: rec.displayName, retainYears: RETENTION_YEARS },
          ),
        );
      } catch (err) {
        // Not worth pausing a deletion for: the admin sees it in the log.
        log('offboarding.emailFailed', { artistId: rec.artistId, name: (err as Error).name });
      }
    }
    try {
      await cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: rec.email }),
      );
    } catch (err) {
      if ((err as Error).name !== 'UserNotFoundException') throw err;
    }
  }
}

const RUN: Record<Exclude<Step, 'done'>, (rec: DeletionRecord) => Promise<void>> = {
  ai: stepAi,
  archive: stepArchive,
  unlink: stepUnlink,
  remove: stepRemove,
  login: stepLogin,
};

async function auditEvent(action: string, fields: Record<string, string | number | boolean>) {
  await bus.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: env('EVENT_BUS'),
          Source: 'bmg.audit',
          DetailType: action,
          Detail: JSON.stringify({
            id: `${fields.artistId}-${action}-${Date.now()}`,
            at: new Date().toISOString(),
            action,
            outcome: 'success',
            actorRole: 'offboarding',
            ...fields,
          }),
        },
      ],
    }),
  );
}

/** Runs a deletion from its current step to the end, pausing (not undoing) on a failure. */
export async function runDeletion(artistId: string): Promise<DeletionRecord | undefined> {
  const rec = (await db.send(new GetCommand({ TableName: table(), Key: deletionKey(artistId) })))
    .Item as DeletionRecord | undefined;
  if (!rec || rec.status !== 'running') return rec;
  while (rec.step !== 'done') {
    const step = rec.step;
    try {
      await RUN[step](rec);
    } catch (err) {
      log('offboarding.paused', { artistId, step, name: (err as Error).name });
      await save(rec, {
        status: 'paused',
        error: `${(err as Error).name}: ${String((err as Error).message).slice(0, 300)}`,
      });
      return rec;
    }
    await save(rec, { step: nextStep(step), stepsDone: [...new Set([...rec.stepsDone, step])] });
    log('offboarding.step', { artistId, step });
  }
  const finishedAt = new Date().toISOString();
  await save(rec, { status: 'done', finishedAt, stepsDone: [...STEPS] });
  // The email was only needed to close the login; drop it from the record.
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: deletionKey(artistId),
      UpdateExpression: 'REMOVE email',
    }),
  );
  await auditEvent('artist.deleted', {
    artistId,
    deletionId: rec.deletionId,
    files: rec.archive?.objects ?? 0,
    items: rec.archive?.items ?? 0,
    mentions: rec.mentions.length,
  });
  await publish('artist.deleted', {
    artistId,
    name: rec.displayName,
    bySub: rec.by,
    mentions: rec.mentions.length,
  });
  return rec;
}
