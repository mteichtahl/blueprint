import { describe, expect, it } from 'vitest';
import {
  AVATAR_BATCH,
  avatarIds,
  checkAvatar,
  jobTitleFor,
  ProfilePatch,
} from '../src/handlers/me.ts';

describe('job titles', () => {
  it('is always "Artist" for artists', () => {
    expect(jobTitleFor('artist', 'Lead singer')).toBe('Artist');
    expect(jobTitleFor('artist', undefined)).toBe('Artist');
  });

  it("is the person's own for Blueprint", () => {
    expect(jobTitleFor('bmg-admin', 'Founder & Director')).toBe('Founder & Director');
    expect(jobTitleFor('bmg-staff', undefined)).toBe('');
  });

  it('accepts a short title only', () => {
    expect(ProfilePatch.parse({ jobTitle: '  Artist manager ' }).jobTitle).toBe('Artist manager');
    expect(ProfilePatch.safeParse({ jobTitle: 'x'.repeat(81) }).success).toBe(false);
    expect(ProfilePatch.safeParse({ jobTitle: 'A', role: 'bmg-admin' }).success).toBe(false);
  });
});

describe('profile pictures', () => {
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('accepts a picture, a removal, or a title, but not an empty change', () => {
    expect(ProfilePatch.safeParse({ avatar: `data:image/png;base64,${PNG_1PX}` }).success).toBe(
      true,
    );
    expect(ProfilePatch.safeParse({ avatar: null }).success).toBe(true);
    expect(ProfilePatch.safeParse({}).success).toBe(false);
  });

  it('keeps only real raster images', () => {
    expect(checkAvatar(`data:image/png;base64,${PNG_1PX}`)).toBe(
      `data:image/png;base64,${PNG_1PX}`,
    );
    expect(() => checkAvatar('data:image/svg+xml;base64,PHN2Zy8+')).toThrow(/PNG, JPEG or WebP/);
    expect(() => checkAvatar(`data:image/jpeg;base64,${PNG_1PX}`)).toThrow(/valid image/);
  });
});

describe('GET /avatars ids', () => {
  it('takes a comma list, drops blanks and repeats', () => {
    expect(avatarIds('art_a, art_b,,art_a')).toEqual(['art_a', 'art_b']);
    expect(avatarIds(undefined)).toEqual([]);
  });

  it('refuses odd ids and too many at once', () => {
    expect(() => avatarIds('art_a,USER#x')).toThrow(/valid id/);
    const many = Array.from({ length: AVATAR_BATCH + 1 }, (_, i) => `a${i}`).join(',');
    expect(() => avatarIds(many)).toThrow(/at most/);
  });
});
