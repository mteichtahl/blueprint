import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { env } from '../lib.ts';

/**
 * Consultation requests' personal details (rev 21), sealed under the platform
 * key. A request can be longer than KMS encrypts directly (4 KB), so each
 * value gets its own data key (AES-256-GCM), wrapped by KMS with an encryption
 * context naming the request, so a sealed value copied onto another request
 * won't open.
 *
 * Layout: [1 byte version][2 bytes wrapped-key length][wrapped key][12 IV][16 tag][ciphertext]
 */
const kms = new KMSClient({});
const VERSION = 1;

const context = (enquiryId: string, part: string) => ({ purpose: 'enquiry', enquiryId, part });

export async function seal(enquiryId: string, part: string, value: unknown): Promise<Uint8Array> {
  const key = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: env('PLATFORM_KEY_ARN'),
      KeySpec: 'AES_256',
      EncryptionContext: context(enquiryId, part),
    }),
  );
  const plain = Buffer.from(key.Plaintext!);
  const wrapped = Buffer.from(key.CiphertextBlob!);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', plain, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const head = Buffer.alloc(3);
    head.writeUInt8(VERSION, 0);
    head.writeUInt16BE(wrapped.length, 1);
    return new Uint8Array(Buffer.concat([head, wrapped, iv, cipher.getAuthTag(), body]));
  } finally {
    plain.fill(0);
  }
}

export async function open<T>(enquiryId: string, part: string, sealed: Uint8Array): Promise<T> {
  const buf = Buffer.from(sealed);
  if (buf.readUInt8(0) !== VERSION) throw new Error('Unknown sealed format');
  const n = buf.readUInt16BE(1);
  const wrapped = buf.subarray(3, 3 + n);
  const iv = buf.subarray(3 + n, 15 + n);
  const tag = buf.subarray(15 + n, 31 + n);
  const body = buf.subarray(31 + n);
  const key = await kms.send(
    new DecryptCommand({ CiphertextBlob: wrapped, EncryptionContext: context(enquiryId, part) }),
  );
  const plain = Buffer.from(key.Plaintext!);
  try {
    const decipher = createDecipheriv('aes-256-gcm', plain, iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return JSON.parse(text) as T;
  } finally {
    plain.fill(0);
  }
}
