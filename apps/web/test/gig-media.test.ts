import { describe, expect, it } from 'vitest';
import { isMedia, MEDIA_BATCH, sortPicked } from '../src/components/GigMedia.tsx';

const file = (name: string, type: string, size = 10) => ({ name, type, size }) as File;

describe('gig media picking', () => {
  it('takes photos and videos, not SVGs or documents', () => {
    expect(isMedia({ name: 'a.jpg', type: 'image/jpeg' })).toBe(true);
    expect(isMedia({ name: 'b.MOV', type: 'video/quicktime' })).toBe(true);
    expect(isMedia({ name: 'c.heic', type: '' })).toBe(true);
    expect(isMedia({ name: 'd.svg', type: 'image/svg+xml' })).toBe(false);
    expect(isMedia({ name: 'e.pdf', type: 'application/pdf' })).toBe(false);
  });

  it('says why files were skipped', () => {
    const { ok, skipped } = sortPicked([
      file('a.jpg', 'image/jpeg'),
      file('b.pdf', 'application/pdf'),
      file('c.mp4', 'video/mp4', 0),
      file('d.mp4', 'video/mp4', 600 * 1024 * 1024),
    ]);
    expect(ok.map((f) => f.name)).toEqual(['a.jpg']);
    expect(skipped).toEqual([
      'b.pdf isn’t a photo or video',
      'c.mp4 is empty',
      'd.mp4 is over 500 MB',
    ]);
  });

  it('sends batches no bigger than the API takes', () => {
    expect(MEDIA_BATCH).toBe(20);
  });
});
