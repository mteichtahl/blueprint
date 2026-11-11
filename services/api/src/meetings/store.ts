import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { artistKeyAlias, DataAccessSessions, encryptionContext } from '@bmg/crypto';
import { db, env, HttpError } from '../lib.ts';
import { quarantineKey, fileSk, LIBRARY_PK, PENDING_TTL_SECONDS } from '../files/model.ts';
import type { FileRecord } from '../files/model.ts';
import { artistPk } from '../workspace/model.ts';
import {
  contentKey,
  emptyContent,
  meetingSk,
  MEETINGS_GSI3PK,
  spaceOf,
  spacePk,
  type Meeting,
  type MeetingContent,
  type MeetingSpace,
} from './model.ts';

/**
 * Reading and writing meetings and their content. Content lives in the
 * space's own bucket: an artist's under their key, through a data-access
 * session tagged with that artist (so KMS itself keeps artists apart), and
 * Blueprint's in org-data under the platform key.
 */

const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
const sessions = new DataAccessSessions();
const table = () => env('MAIN_TABLE');

type SessionRole = 'bmg-admin' | 'bmg-staff';

async function bucketFor(m: Pick<Meeting, 'artistId'>, role: SessionRole) {
  if (!m.artistId) {
    // org-data encrypts with the platform key by default.
    return { client: s3, bucket: env('LIBRARY_BUCKET'), sse: {} as Partial<PutObjectCommandInput> };
  }
  const credentials = await sessions.credentials({
    roleArn: env('DATA_ACCESS_ROLE_ARN'),
    artistId: m.artistId,
    role,
  });
  const alias = artistKeyAlias(env('PROJECT'), env('BMG_ENV'), m.artistId);
  return {
    client: new S3Client({ credentials, requestChecksumCalculation: 'WHEN_REQUIRED' }),
    bucket: env('ARTIST_BUCKET'),
    sse: {
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: `arn:aws:kms:${env('AWS_REGION')}:${env('ACCOUNT_ID')}:${alias}`,
      SSEKMSEncryptionContext: Buffer.from(
        JSON.stringify(encryptionContext(m.artistId, 'normal')),
      ).toString('base64'),
      BucketKeyEnabled: false,
    } satisfies Partial<PutObjectCommandInput>,
  };
}

export async function loadMeeting(space: MeetingSpace, meetingId: string): Promise<Meeting> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: spacePk(space), SK: meetingSk(meetingId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such meeting');
  return res.Item as Meeting;
}

export async function createMeeting(m: Meeting): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: spacePk(spaceOf(m)),
        SK: meetingSk(m.meetingId),
        type: 'meeting',
        GSI3PK: MEETINGS_GSI3PK,
        GSI3SK: `${m.createdAt}#${m.meetingId}`,
        ...m,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

/**
 * Sets fields on a meeting (and removes `remove`). `expect` adds conditions
 * on current values, e.g. `{ status: 'uploading' }`; a failed condition
 * returns false rather than throwing.
 */
export async function updateMeeting(
  m: Pick<Meeting, 'meetingId' | 'artistId'>,
  set: Partial<Meeting>,
  opts: { remove?: (keyof Meeting)[]; expect?: Partial<Record<keyof Meeting, unknown>> } = {},
): Promise<boolean> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const fields = { ...set, updatedAt: set.updatedAt ?? new Date().toISOString() };
  for (const [i, [k, v]] of Object.entries(fields).entries()) {
    names[`#s${i}`] = k;
    values[`:s${i}`] = v;
    sets.push(`#s${i} = :s${i}`);
  }
  const removes = (opts.remove ?? []).map((k, i) => {
    names[`#r${i}`] = k;
    return `#r${i}`;
  });
  const conds = ['attribute_exists(PK)'];
  for (const [i, [k, v]] of Object.entries(opts.expect ?? {}).entries()) {
    names[`#e${i}`] = k;
    if (v === undefined) {
      conds.push(`attribute_not_exists(#e${i})`);
    } else {
      values[`:e${i}`] = v;
      conds.push(`#e${i} = :e${i}`);
    }
  }
  try {
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: spacePk(spaceOf(m)), SK: meetingSk(m.meetingId) },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: conds.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function readContent(m: Meeting, role: SessionRole): Promise<MeetingContent> {
  if (!m.contentVersion) return emptyContent();
  const b = await bucketFor(m, role);
  const res = await b.client.send(
    new GetObjectCommand({ Bucket: b.bucket, Key: contentKey(m, m.contentVersion) }),
  );
  const text = await res.Body!.transformToString();
  return { ...emptyContent(), ...(JSON.parse(text) as Partial<MeetingContent>) };
}

/**
 * Saves new content as the next version. The meeting moves to it only if
 * it's still on the version this change started from; otherwise 409, and the
 * object written for the losing change is removed.
 */
export async function writeContent(
  m: Meeting,
  content: MeetingContent,
  role: SessionRole,
  extra: Partial<Meeting> = {},
  remove: (keyof Meeting)[] = [],
): Promise<number> {
  const next = m.contentVersion + 1;
  const b = await bucketFor(m, role);
  const Key = contentKey(m, next);
  await b.client.send(
    new PutObjectCommand({
      Bucket: b.bucket,
      Key,
      Body: JSON.stringify(content),
      ContentType: 'application/json',
      ...b.sse,
    }),
  );
  const moved = await updateMeeting(
    m,
    { ...extra, contentVersion: next },
    { expect: { contentVersion: m.contentVersion }, remove },
  );
  if (!moved) {
    await b.client.send(new DeleteObjectCommand({ Bucket: b.bucket, Key })).catch(() => undefined);
    throw new HttpError(409, 'Someone else changed this meeting. Reload and try again.');
  }
  // The previous version is no longer needed.
  if (m.contentVersion) {
    await b.client
      .send(new DeleteObjectCommand({ Bucket: b.bucket, Key: contentKey(m, m.contentVersion) }))
      .catch(() => undefined);
  }
  return next;
}

/**
 * Reads the latest content, changes it and saves it, starting again (up to
 * three times) if someone else saved in between. For changes that only add
 * (a summary, an answer), so re-applying them is safe.
 */
export async function mutateContent(
  space: MeetingSpace,
  meetingId: string,
  role: SessionRole,
  change: (content: MeetingContent, m: Meeting) => MeetingContent,
  extra: Partial<Meeting> = {},
  remove: (keyof Meeting)[] = [],
): Promise<{ meeting: Meeting; content: MeetingContent; version: number }> {
  for (let attempt = 0; ; attempt++) {
    const m = await loadMeeting(space, meetingId);
    const content = change(await readContent(m, role), m);
    try {
      const version = await writeContent(m, content, role, extra, remove);
      return { meeting: { ...m, ...extra, contentVersion: version }, content, version };
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409) || attempt >= 2) throw err;
    }
  }
}

/** Removes every content version still around (meeting deleted). */
export async function deleteContent(m: Meeting, role: SessionRole): Promise<void> {
  const b = await bucketFor(m, role);
  for (let v = Math.max(1, m.contentVersion - 2); v <= m.contentVersion + 1; v++) {
    await b.client
      .send(new DeleteObjectCommand({ Bucket: b.bucket, Key: contentKey(m, v) }))
      .catch(() => undefined);
  }
}

/** The file record of one of the meeting's documents. */
export async function loadMeetingFile(
  m: Pick<Meeting, 'artistId'>,
  fileId: string,
): Promise<(FileRecord & { PK: string; SK: string }) | undefined> {
  const pk = m.artistId ? artistPk(m.artistId) : LIBRARY_PK;
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: pk, SK: fileSk(fileId) } }),
  );
  return res.Item as (FileRecord & { PK: string; SK: string }) | undefined;
}

/**
 * Files a document the app wrote itself (the meeting note) the way an upload
 * is filed: a pending record, and the bytes in quarantine. GuardDuty scans it
 * and the promoter moves it into the space, exactly as for an upload. With
 * `fileId` set, it becomes that file's next version instead.
 */
export async function fileDocument(
  m: Meeting,
  doc: {
    name: string;
    body: string;
    contentType: string;
    folderId?: string;
    fileId?: string;
    note?: string;
  },
  newFileId: () => string,
): Promise<string> {
  const bytes = Buffer.from(doc.body, 'utf8');
  const scope = m.artistId ? ('artist' as const) : ('library' as const);
  const pk = m.artistId ? artistPk(m.artistId) : LIBRARY_PK;
  const now = new Date().toISOString();
  let fileId = doc.fileId;
  let v = 1;
  if (fileId) {
    const current = await loadMeetingFile(m, fileId);
    if (!current || current.status !== 'available') fileId = undefined;
    else {
      v = (current.pendingVersion?.v ?? current.version ?? 1) + 1;
      try {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: pk, SK: fileSk(fileId) },
            UpdateExpression: 'SET pendingVersion = :p',
            ConditionExpression: current.pendingVersion
              ? 'pendingVersion.v = :was'
              : 'attribute_exists(PK) AND attribute_not_exists(pendingVersion)',
            ExpressionAttributeValues: {
              ':p': {
                v,
                name: doc.name,
                size: bytes.length,
                contentType: doc.contentType,
                uploadedBy: m.createdBy,
                createdAt: now,
                ...(doc.note ? { note: doc.note } : {}),
                status: 'pending',
              },
              ...(current.pendingVersion ? { ':was': current.pendingVersion.v } : {}),
            },
          }),
        );
      } catch (err) {
        if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
        throw new HttpError(409, 'The meeting note is being updated. Try again in a minute.');
      }
    }
  }
  if (!fileId) {
    fileId = newFileId();
    v = 1;
    const rec: FileRecord = {
      fileId,
      scope,
      ...(m.artistId ? { artistId: m.artistId } : {}),
      name: doc.name,
      size: bytes.length,
      contentType: doc.contentType,
      status: 'pending',
      ...(m.artistId
        ? { visibility: m.shared ? ('normal' as const) : ('bmg-only' as const) }
        : { sharing: 'bmg-only' as const }),
      uploadedBy: m.createdBy,
      uploaderRole: m.createdByRole,
      ...(doc.folderId ? { folderId: doc.folderId } : {}),
      editAccess: 'everyone',
      createdAt: now,
    };
    await db.send(
      new PutCommand({
        TableName: table(),
        Item: {
          PK: pk,
          SK: fileSk(fileId),
          type: 'file',
          ...rec,
          meetingId: m.meetingId,
          ttl: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: env('QUARANTINE_BUCKET'),
      Key: quarantineKey(scope, fileId, m.artistId, 'file', v),
      Body: bytes,
      ContentType: doc.contentType,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: env('QUARANTINE_KEY_ARN'),
    }),
  );
  return fileId;
}

/**
 * Sharing a meeting with its artist opens (or closes) its audio and note to
 * them: the files' per-file "BMG only" setting follows the meeting. Returns
 * the files that changed, so the knowledge base can be told.
 */
export async function shareFiles(m: Meeting, shared: boolean): Promise<string[]> {
  if (!m.artistId) return [];
  const changed: string[] = [];
  for (const fileId of [m.audioFileId, m.noteFileId]) {
    if (!fileId) continue;
    try {
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: artistPk(m.artistId), SK: fileSk(fileId) },
          UpdateExpression: 'SET visibility = :v, updatedAt = :at',
          // Never touches an artist's private file, or a file that isn't this meeting's.
          ConditionExpression: 'attribute_exists(PK) AND meetingId = :m AND visibility <> :private',
          ExpressionAttributeValues: {
            ':v': shared ? 'normal' : 'bmg-only',
            ':at': new Date().toISOString(),
            ':m': m.meetingId,
            ':private': 'private',
          },
        }),
      );
      changed.push(fileId);
    } catch (err) {
      if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
    }
  }
  return changed;
}

/** A short random id for content that never needs sorting. */
export const shortId = () => randomUUID().replace(/-/g, '').slice(0, 20);
