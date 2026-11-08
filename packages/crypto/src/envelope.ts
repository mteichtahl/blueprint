import { buildClient, CommitmentPolicy, KmsKeyringNode } from '@aws-crypto/client-node';
import { KMS } from '@aws-sdk/client-kms';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { encryptionContext, type Visibility } from './names.ts';

const { encrypt, decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT);

export interface ArtistCipherOptions {
  /** Artist key ARN or alias ARN. */
  keyId: string;
  artistId: string;
  /** Credentials from DataAccessSessions for this artist. */
  credentials: AwsCredentialIdentity;
  region?: string;
}

function keyring(opts: ArtistCipherOptions): KmsKeyringNode {
  const client = new KMS({
    credentials: opts.credentials,
    ...(opts.region ? { region: opts.region } : {}),
  });
  return new KmsKeyringNode({
    generatorKeyId: opts.keyId,
    clientProvider: () => client,
  });
}

/**
 * Envelope-encrypts a value for one artist with the AWS Encryption SDK
 * (key commitment required). Used for sensitive DynamoDB fields and connector
 * tokens (design 9.1).
 */
export async function encryptForArtist(
  opts: ArtistCipherOptions,
  plaintext: Uint8Array | string,
  visibility: Visibility = 'normal',
): Promise<Uint8Array> {
  const { result } = await encrypt(keyring(opts), plaintext, {
    encryptionContext: encryptionContext(opts.artistId, visibility),
  });
  return result;
}

/**
 * Decrypts a value and checks the encryption context it was sealed with
 * belongs to the expected artist, so a ciphertext copied into another
 * artist's record is rejected even before KMS is asked.
 */
export async function decryptForArtist(
  opts: ArtistCipherOptions,
  ciphertext: Uint8Array,
): Promise<{ plaintext: Uint8Array; visibility: Visibility }> {
  const { plaintext, messageHeader } = await decrypt(keyring(opts), ciphertext);
  const ctx = messageHeader.encryptionContext;
  if (ctx.artistId !== opts.artistId) {
    throw new Error('Ciphertext belongs to a different artist');
  }
  return { plaintext, visibility: ctx.visibility === 'private' ? 'private' : 'normal' };
}
