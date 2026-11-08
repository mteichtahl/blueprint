import { randomBytes } from 'node:crypto';

/** `art_` + 10–32 lowercase letters or digits. Used in key tags, aliases and DynamoDB keys. */
export const ARTIST_ID_PATTERN = /^art_[a-z0-9]{10,32}$/;

export function isArtistId(value: unknown): value is string {
  return typeof value === 'string' && ARTIST_ID_PATTERN.test(value);
}

export function assertArtistId(value: unknown): string {
  if (!isArtistId(value)) throw new Error('Invalid artist id');
  return value;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Largest multiple of the alphabet size below 256: bytes at or above it are discarded. */
export const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

/**
 * A new random artist id: 16 characters drawn uniformly from [a-z0-9]
 * (~82 bits). Rejection sampling keeps every character equally likely.
 */
export function newArtistId(random: (size: number) => Uint8Array = randomBytes): string {
  let id = 'art_';
  while (id.length < 4 + 16) {
    for (const b of random(32)) {
      if (b >= UNBIASED_LIMIT) continue;
      id += ALPHABET[b % ALPHABET.length];
      if (id.length === 4 + 16) break;
    }
  }
  return id;
}

/** Alias of an artist's KMS key (design 9.1), namespaced by environment in the single account. */
export function artistKeyAlias(project: string, env: string, artistId: string): string {
  return `alias/${project}/${env}/artist/${assertArtistId(artistId)}`;
}

/** Tag keys the key policies and the data-access role compare (design 6.3, 9.1). */
export const TAG_ARTIST_ID = 'artistId';
export const TAG_SESSION_ROLE = 'role';

/** Session roles allowed on the data-access role. `ai-tools` arrives in Phase 5. */
export const SESSION_ROLES = ['artist', 'bmg-admin', 'bmg-staff'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export type Visibility = 'normal' | 'private';

/**
 * KMS encryption context for an artist's data. KMS binds it to the ciphertext
 * and the key policy checks it, so data encrypted for one artist can't be
 * decrypted under another artist's context, and `private` items are refused to
 * every BMG role (design 9.1, "Private items").
 */
export function encryptionContext(
  artistId: string,
  visibility: Visibility = 'normal',
): Record<string, string> {
  return {
    artistId: assertArtistId(artistId),
    ...(visibility === 'private' ? { visibility: 'private' } : {}),
  };
}
