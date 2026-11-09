import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const KEY_ARN = 'arn:aws:kms:ap-southeast-2:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const ALIAS_ARN =
  'arn:aws:kms:ap-southeast-2:111122223333:alias/bmg/staging/artist/art_abc123def45';

/**
 * A stand-in for KMS that behaves like the real one where it matters here:
 * GenerateDataKey and Encrypt answer with the key ARN even when called with an
 * alias, and data keys are "wrapped" by tagging them with that ARN.
 */
vi.mock('@aws-sdk/client-kms', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-kms')>();
  const resolve = (id: string) => (id === ALIAS_ARN || id === KEY_ARN ? KEY_ARN : undefined);
  const wrap = (key: Uint8Array) => Buffer.concat([Buffer.from('wrapped:'), Buffer.from(key)]);
  class KMS {
    describeKeyCalls = 0;
    async send(cmd: { input: { KeyId: string } }) {
      if (cmd instanceof real.DescribeKeyCommand) {
        const arn = resolve(cmd.input.KeyId);
        if (!arn) throw new Error('NotFoundException');
        return { KeyMetadata: { Arn: arn } };
      }
      throw new Error('unexpected command');
    }
    async generateDataKey(input: { KeyId: string; NumberOfBytes: number }) {
      const KeyId = resolve(input.KeyId);
      if (!KeyId) throw new Error('NotFoundException');
      const Plaintext = new Uint8Array(randomBytes(input.NumberOfBytes));
      return { KeyId, Plaintext, CiphertextBlob: wrap(Plaintext) };
    }
    async encrypt(input: { KeyId: string; Plaintext: Uint8Array }) {
      return { KeyId: resolve(input.KeyId), CiphertextBlob: wrap(input.Plaintext) };
    }
    async decrypt(input: { KeyId: string; CiphertextBlob: Uint8Array }) {
      return {
        KeyId: resolve(input.KeyId),
        Plaintext: new Uint8Array(Buffer.from(input.CiphertextBlob).subarray(8)),
      };
    }
  }
  return { ...real, KMS };
});

const { decryptForArtist, encryptForArtist, isAliasArn } = await import('../src/envelope.ts');

const credentials = { accessKeyId: 'AKIA', secretAccessKey: 'x', sessionToken: 'y' };

describe('artist envelope encryption', () => {
  it('recognises alias ARNs', () => {
    expect(isAliasArn(ALIAS_ARN)).toBe(true);
    expect(isAliasArn(KEY_ARN)).toBe(false);
  });

  it('decrypts a value sealed through the artist key alias (review notes)', async () => {
    const opts = { keyId: ALIAS_ARN, artistId: 'art_abc123def45', credentials };
    const blob = await encryptForArtist(opts, 'Please listen to the second verse');
    const { plaintext, visibility } = await decryptForArtist(opts, blob);
    expect(Buffer.from(plaintext).toString('utf8')).toBe('Please listen to the second verse');
    expect(visibility).toBe('normal');
  });

  it('refuses a ciphertext that belongs to another artist', async () => {
    const blob = await encryptForArtist(
      { keyId: ALIAS_ARN, artistId: 'art_abc123def45', credentials },
      'secret',
    );
    await expect(
      decryptForArtist({ keyId: ALIAS_ARN, artistId: 'art_zzz999yyy88', credentials }, blob),
    ).rejects.toThrow(/different artist/);
  });
});
