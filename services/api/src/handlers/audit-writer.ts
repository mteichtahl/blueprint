import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EventBridgeEvent } from 'aws-lambda';
import { env } from '../lib.ts';

const s3 = new S3Client({});

/** `audit/<yyyy>/<mm>/<dd>/<action>/<event id>.json`, one immutable object per event. */
export function auditKey(at: string, action: string, id: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error('Bad timestamp');
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `audit/${yyyy}/${mm}/${dd}/${safe(action)}/${safe(id)}.json`;
}

/**
 * Writes each audit event to the Object Lock archive (design 15). A checksum
 * is sent with every put, which Object Lock retention requires. Failed
 * deliveries are retried by EventBridge and then land in a dead-letter queue
 * with an alarm.
 */
export const handler = async (event: EventBridgeEvent<string, Record<string, unknown>>) => {
  const detail = event.detail;
  const at = String(detail.at ?? event.time);
  const id = String(detail.id ?? event.id);
  await s3.send(
    new PutObjectCommand({
      Bucket: env('AUDIT_BUCKET'),
      Key: auditKey(at, event['detail-type'], id),
      Body: JSON.stringify({ ...detail, eventId: event.id, source: event.source }),
      ContentType: 'application/json',
      ChecksumAlgorithm: 'SHA256',
    }),
  );
};
