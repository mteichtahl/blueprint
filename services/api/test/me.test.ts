import { describe, expect, it } from 'vitest';
import { jobTitleFor, ProfilePatch } from '../src/handlers/me.ts';

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
