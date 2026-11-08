import { describe, expect, it } from 'vitest';
import {
  artistKeyAlias,
  encryptionContext,
  isArtistId,
  newArtistId,
  UNBIASED_LIMIT,
} from '../src/names.ts';

describe('artist ids', () => {
  it('generates valid, unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newArtistId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(isArtistId(id)).toBe(true);
  });

  it('discards bytes that would bias the alphabet (no modulo bias)', () => {
    expect(UNBIASED_LIMIT).toBe(252); // 7 × 36
    // Bytes 252–255 would map to a–d a second time; they must be skipped.
    const bytes = Uint8Array.from([252, 253, 254, 255, ...Array.from({ length: 28 }, (_, i) => i)]);
    expect(newArtistId(() => bytes)).toBe('art_abcdefghijklmnop');
  });

  it('rejects anything that could escape a key, alias or tag', () => {
    for (const bad of [
      '',
      'art_',
      'art_ABCDEFGHIJ',
      'art_abc/../xyz00',
      'art_abcdefghij*',
      'x_abcdefghijk',
    ]) {
      expect(isArtistId(bad)).toBe(false);
    }
  });
});

describe('artistKeyAlias', () => {
  it('namespaces aliases by environment', () => {
    expect(artistKeyAlias('bmg', 'staging', 'art_0123456789ab')).toBe(
      'alias/bmg/staging/artist/art_0123456789ab',
    );
  });
  it('refuses an invalid artist id', () => {
    expect(() => artistKeyAlias('bmg', 'prod', 'art_x*')).toThrow();
  });
});

describe('encryptionContext', () => {
  it('always names the artist and only adds visibility for private items', () => {
    expect(encryptionContext('art_0123456789ab')).toEqual({ artistId: 'art_0123456789ab' });
    expect(encryptionContext('art_0123456789ab', 'private')).toEqual({
      artistId: 'art_0123456789ab',
      visibility: 'private',
    });
  });
});
