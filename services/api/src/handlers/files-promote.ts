import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { artistKeyAlias, DataAccessSessions, encryptionContext } from '@bmg/crypto';
import {
  fileSk,
  LIBRARY_PK,
  parseQuarantineKey,
  quarantineKey,
  scanOutcome,
  storedKey,
  THUMB_MAX_BYTES,
  type FileRecord,
  type QuarantineRef,
} from '../files/model.ts';
import { detectFileType } from '../files/type.ts';
import { artistPk } from '../workspace/model.ts';
import { db, env } from '../lib.ts';

// Checksums only when S3 requires them: the body is a stream of known length.
const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
const events = new EventBridgeClient({});
const sessions = new DataAccessSessions();

/** The GuardDuty Malware Protection for S3 result event (EventBridge, default bus). */
export interface ScanResultEvent {
  'detail-type': string;
  source: string;
  detail: {
    scanStatus?: string;
    s3ObjectDetails?: { bucketName?: string; objectKey?: string };
    scanResultDetails?: { scanResultStatus?: string };
  };
}

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', event, ...fields }));

async function auditEvent(
  action: string,
  outcome: 'success' | 'failed',
  fields: Record<string, unknown>,
) {
  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: env('EVENT_BUS'),
          Source: 'bmg.audit',
          DetailType: action,
          Detail: JSON.stringify({
            id: randomUUID(),
            at: new Date().toISOString(),
            action,
            outcome,
            actorRole: 'system',
            ...fields,
          }),
        },
      ],
    }),
  );
}

const pkFor = (ref: QuarantineRef) =>
  ref.scope === 'artist' ? artistPk(ref.artistId) : LIBRARY_PK;

async function setStatus(
  ref: QuarantineRef,
  status: 'available' | 'rejected',
  reason?: string,
): Promise<void> {
  try {
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: { PK: pkFor(ref), SK: fileSk(ref.fileId) },
        UpdateExpression:
          status === 'available'
            ? 'SET #s = :s, availableAt = :at REMOVE #ttl'
            : 'SET #s = :s, rejectReason = :r, rejectedAt = :at',
        ConditionExpression: '#s = :pending',
        ExpressionAttributeNames: {
          '#s': 'status',
          ...(status === 'available' ? { '#ttl': 'ttl' } : {}),
        },
        ExpressionAttributeValues: {
          ':s': status,
          ':pending': 'pending',
          ':at': new Date().toISOString(),
          ...(status === 'rejected' ? { ':r': reason } : {}),
        },
      }),
    );
  } catch (err) {
    // Already settled by an earlier delivery of the same event.
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/** S3 client and write settings for the file's real home. */
async function destination(ref: QuarantineRef, rec: FileRecord) {
  if (ref.scope === 'library') {
    // The org-data bucket encrypts with the platform key by default.
    return { client: s3, bucket: env('LIBRARY_BUCKET'), sse: {} as Partial<PutObjectCommandInput> };
  }
  // Artist files are written in a data-access session for that artist, so the
  // artist key's policy (tag + encryption context) is what allows the write.
  const credentials = await sessions.credentials({
    roleArn: env('DATA_ACCESS_ROLE_ARN'),
    artistId: ref.artistId,
    role: rec.uploaderRole,
  });
  const context = encryptionContext(
    ref.artistId,
    rec.visibility === 'private' ? 'private' : 'normal',
  );
  const alias = artistKeyAlias(env('PROJECT'), env('BMG_ENV'), ref.artistId);
  return {
    client: new S3Client({ credentials, requestChecksumCalculation: 'WHEN_REQUIRED' }),
    bucket: env('ARTIST_BUCKET'),
    sse: {
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: `arn:aws:kms:${env('AWS_REGION')}:${env('ACCOUNT_ID')}:${alias}`,
      SSEKMSEncryptionContext: Buffer.from(JSON.stringify(context)).toString('base64'),
      BucketKeyEnabled: false,
    } satisfies Partial<PutObjectCommandInput>,
  };
}

async function exists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if ((err as Error).name === 'NotFound' || (err as Error).name === 'NoSuchKey') return false;
    throw err;
  }
}

/**
 * Runs when GuardDuty has scanned an upload in the quarantine bucket
 * (design 9.3, F2). A clean file is copied to its real bucket under its real
 * key, the quarantine copy is deleted and the record is marked available.
 * Anything else is deleted and the record is marked rejected. Safe to run
 * more than once for the same object.
 */
export async function handler(event: ScanResultEvent): Promise<void> {
  const quarantine = env('QUARANTINE_BUCKET');
  const bucket = event.detail.s3ObjectDetails?.bucketName;
  const key = event.detail.s3ObjectDetails?.objectKey ?? '';
  if (bucket !== quarantine) return;
  const ref = parseQuarantineKey(key);
  if (!ref) {
    // Only the app writes here; anything else (e.g. GuardDuty's validation object) is ignored.
    log('files.promote.ignored');
    return;
  }

  const rec = (
    await db.send(
      new GetCommand({
        TableName: env('MAIN_TABLE'),
        Key: { PK: pkFor(ref), SK: fileSk(ref.fileId) },
      }),
    )
  ).Item as FileRecord | undefined;
  if (ref.part === 'thumb') return promoteThumb(ref, key, rec, event);
  if (!rec || rec.status !== 'pending') {
    // No record (expired) or already settled: just make sure nothing is left in quarantine.
    await s3.send(new DeleteObjectCommand({ Bucket: quarantine, Key: key }));
    log('files.promote.no-pending-record', { fileId: ref.fileId });
    return;
  }

  const ids = {
    fileId: ref.fileId,
    ...(ref.scope === 'artist' ? { artistId: ref.artistId } : { library: true }),
  };
  const reject = async (reason: string) => {
    await s3.send(new DeleteObjectCommand({ Bucket: quarantine, Key: key }));
    await setStatus(ref, 'rejected', reason);
    // A rejected file keeps no preview.
    if (rec.thumb) await dropThumb(ref, rec);
    await auditEvent('file.rejected', 'success', { ...ids, reason });
    // Tell the uploader and Blueprint (notifications).
    await events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: env('EVENT_BUS'),
            Source: 'bmg.workspace',
            DetailType: 'file.rejected',
            Detail: JSON.stringify({
              id: randomUUID(),
              ...ids,
              uploadedBy: rec.uploadedBy,
              name: rec.title || rec.name,
              reason,
            }),
          },
        ],
      }),
    );
    log('files.promote.rejected', { fileId: ref.fileId });
  };

  const outcome = scanOutcome(event.detail.scanResultDetails?.scanResultStatus);
  if (!outcome.promote) return reject(outcome.reason);

  const dest = await destination(ref, rec);
  const target = storedKey(
    ref.scope,
    ref.fileId,
    ref.scope === 'artist' ? ref.artistId : undefined,
  );

  let size: number | undefined;
  try {
    size = (await s3.send(new HeadObjectCommand({ Bucket: quarantine, Key: key }))).ContentLength;
  } catch (err) {
    if ((err as Error).name !== 'NotFound') throw err;
    // A retry after the copy and delete succeeded but the status update didn't.
    if (await exists(dest.client, dest.bucket, target)) {
      await setStatus(ref, 'available');
      return;
    }
    throw err;
  }
  // The presigned POST pins the size, so a mismatch means something is wrong.
  if (size !== rec.size) return reject('The uploaded file didn’t match what was expected');

  // What the file really is, from its first 64 KB (the claimed type is often wrong or generic).
  const fileType = await detect(quarantine, key, rec);
  const obj = await s3.send(new GetObjectCommand({ Bucket: quarantine, Key: key }));
  await dest.client.send(
    new PutObjectCommand({
      Bucket: dest.bucket,
      Key: target,
      Body: obj.Body as Readable,
      ContentLength: size,
      ContentType: rec.contentType,
      ...dest.sse,
    }),
  );
  await s3.send(new DeleteObjectCommand({ Bucket: quarantine, Key: key }));
  if (fileType) await saveFileType(ref, fileType);
  await setStatus(ref, 'available');
  await auditEvent('file.available', 'success', { ...ids, kind: fileType?.kind ?? 'unknown' });
  log('files.promote.available', { fileId: ref.fileId });
}

async function detect(bucket: string, key: string, rec: FileRecord) {
  try {
    const head = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-65535' }),
    );
    const bytes = await head.Body!.transformToByteArray();
    return detectFileType(bytes, rec.name, rec.contentType);
  } catch (err) {
    // Detection is a nicety: never hold a clean file back for it.
    log('files.promote.detect-failed', { error: (err as Error).name });
    return undefined;
  }
}

async function saveFileType(ref: QuarantineRef, fileType: ReturnType<typeof detectFileType>) {
  await db.send(
    new UpdateCommand({
      TableName: env('MAIN_TABLE'),
      Key: { PK: pkFor(ref), SK: fileSk(ref.fileId) },
      UpdateExpression: 'SET fileType = :t',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':t': fileType },
    }),
  );
}

async function setThumbStatus(ref: QuarantineRef, status: 'available' | 'rejected') {
  try {
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: { PK: pkFor(ref), SK: fileSk(ref.fileId) },
        UpdateExpression: 'SET thumb.#s = :s',
        ConditionExpression: 'attribute_exists(thumb)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
  }
}

/** Removes a preview from quarantine and from storage, and marks it rejected. */
async function dropThumb(ref: QuarantineRef, rec: FileRecord) {
  await s3
    .send(
      new DeleteObjectCommand({
        Bucket: env('QUARANTINE_BUCKET'),
        Key: quarantineKey(
          ref.scope,
          ref.fileId,
          ref.scope === 'artist' ? ref.artistId : undefined,
          'thumb',
        ),
      }),
    )
    .catch(() => undefined);
  try {
    const dest = await destination(ref, rec);
    await dest.client.send(
      new DeleteObjectCommand({
        Bucket: dest.bucket,
        Key: storedKey(
          ref.scope,
          ref.fileId,
          ref.scope === 'artist' ? ref.artistId : undefined,
          'thumb',
        ),
      }),
    );
  } catch {
    /* nothing stored yet */
  }
  await setThumbStatus(ref, 'rejected');
}

/** Only these raster formats are kept as previews, and the bytes must agree. */
function isPreviewImage(b: Uint8Array, contentType: string): boolean {
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp =
    String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';
  return (
    (contentType === 'image/png' && png) ||
    (contentType === 'image/jpeg' && jpeg) ||
    (contentType === 'image/webp' && webp)
  );
}

/**
 * A preview has been scanned. It is kept only if the scan was clean, its file
 * is still wanted (not rejected or deleted), and it is the small raster image
 * the record expects; otherwise it is dropped quietly (the list shows the
 * file type's icon instead). Previews never send notifications.
 */
async function promoteThumb(
  ref: QuarantineRef,
  key: string,
  rec: FileRecord | undefined,
  event: ScanResultEvent,
): Promise<void> {
  const quarantine = env('QUARANTINE_BUCKET');
  const clear = () => s3.send(new DeleteObjectCommand({ Bucket: quarantine, Key: key }));
  if (!rec?.thumb || rec.thumb.status !== 'pending' || rec.status === 'rejected') {
    await clear();
    log('files.promote.thumb-ignored', { fileId: ref.fileId });
    return;
  }
  const outcome = scanOutcome(event.detail.scanResultDetails?.scanResultStatus);
  if (!outcome.promote) {
    await clear();
    await setThumbStatus(ref, 'rejected');
    log('files.promote.thumb-rejected', { fileId: ref.fileId });
    return;
  }
  let bytes: Uint8Array;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: quarantine, Key: key }));
    bytes = await obj.Body!.transformToByteArray();
  } catch (err) {
    if ((err as Error).name === 'NoSuchKey') return; // already handled by an earlier delivery
    throw err;
  }
  if (
    bytes.length !== rec.thumb.size ||
    bytes.length > THUMB_MAX_BYTES ||
    !isPreviewImage(bytes, rec.thumb.contentType)
  ) {
    await clear();
    await setThumbStatus(ref, 'rejected');
    log('files.promote.thumb-invalid', { fileId: ref.fileId });
    return;
  }
  const dest = await destination(ref, rec);
  await dest.client.send(
    new PutObjectCommand({
      Bucket: dest.bucket,
      Key: storedKey(
        ref.scope,
        ref.fileId,
        ref.scope === 'artist' ? ref.artistId : undefined,
        'thumb',
      ),
      Body: bytes,
      ContentLength: bytes.length,
      ContentType: rec.thumb.contentType,
      ...dest.sse,
    }),
  );
  await clear();
  await setThumbStatus(ref, 'available');
  log('files.promote.thumb-available', { fileId: ref.fileId });
}
