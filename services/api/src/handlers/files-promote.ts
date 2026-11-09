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
  scanOutcome,
  storedKey,
  type FileRecord,
  type QuarantineRef,
} from '../files/model.ts';
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
              name: rec.name,
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
  await setStatus(ref, 'available');
  await auditEvent('file.available', 'success', ids);
  log('files.promote.available', { fileId: ref.fileId });
}
