import { describe, expect, it } from 'vitest';
import { artistChannel } from '../src/channels.ts';

describe('realtime channel names', () => {
  it('uses only letters, digits and dashes in an artist’s channel (AppSync Events)', () => {
    const ch = artistChannel('art_4f8owqpa63mvnef8');
    expect(ch).toBe('/inbox/artist-art-4f8owqpa63mvnef8');
    for (const segment of ch.split('/').filter(Boolean)) {
      expect(segment).toMatch(/^[A-Za-z0-9-]{1,50}$/);
    }
  });
  it('fits the longest artist id in one segment', () => {
    expect(artistChannel(`art_${'a'.repeat(32)}`).split('/')[2]!.length).toBeLessThanOrEqual(50);
  });
});
