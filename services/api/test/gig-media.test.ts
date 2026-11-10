import { describe, expect, it } from 'vitest';
import {
  counterSk,
  countByKind,
  extensionOf,
  gigNamePart,
  MAX_MEDIA_PER_REQUEST,
  mediaFileName,
  mediaFolderLabel,
  mediaFolderPath,
  mediaKindOf,
  MediaUpload,
  numberFiles,
  pad5,
  pathFolderId,
  reservedNumbers,
  walkFolderPath,
} from '../src/gigs/media.ts';

describe('gig media kinds', () => {
  it('takes photos and videos only', () => {
    expect(mediaKindOf('image/jpeg')).toBe('img');
    expect(mediaKindOf('image/heic')).toBe('img');
    expect(mediaKindOf('VIDEO/QuickTime')).toBe('video');
    expect(mediaKindOf('image/svg+xml')).toBeUndefined();
    expect(mediaKindOf('audio/mpeg')).toBeUndefined();
    expect(mediaKindOf('application/pdf')).toBeUndefined();
  });
});

describe('gig media names', () => {
  it('names files <gig name>_<img|video>_<00000> and keeps the extension', () => {
    expect(mediaFileName('Northcote Social Club', 'img', 1, 'IMG_2231.JPG')).toBe(
      'Northcote Social Club_img_00001.jpg',
    );
    expect(mediaFileName('Northcote Social Club', 'video', 42, 'clip.mov')).toBe(
      'Northcote Social Club_video_00042.mov',
    );
    expect(mediaFileName('Gig', 'img', 99_999, 'a')).toBe('Gig_img_99999');
  });

  it('pads to five digits and refuses numbers outside 1–99999', () => {
    expect(pad5(7)).toBe('00007');
    expect(() => mediaFileName('Gig', 'img', 0, 'a.jpg')).toThrow();
    expect(() => mediaFileName('Gig', 'img', 100_000, 'a.jpg')).toThrow();
  });

  it('cleans the gig name for a file name', () => {
    expect(gigNamePart('AC/DC  tribute \\ night')).toBe('AC DC tribute night');
    expect(gigNamePart('Launch...')).toBe('Launch');
    expect(gigNamePart('   ')).toBe('Gig');
    expect(gigNamePart('x'.repeat(200))).toHaveLength(90);
    // Whole name stays inside the 120-character folder item limit.
    expect(mediaFileName('x'.repeat(200), 'video', 1, 'a.webm').length).toBeLessThanOrEqual(120);
  });

  it('keeps only a plain extension', () => {
    expect(extensionOf('a.tar.GZ')).toBe('.gz');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('weird.<script>')).toBe('');
  });
});

describe('gig media folders', () => {
  it('files a gig under gigs/<year>/<month>/<day>', () => {
    expect(mediaFolderPath('2026-12-11')).toEqual(['gigs', '2026', '12', '11']);
    expect(mediaFolderLabel('2026-01-05')).toBe('gigs › 2026 › 01 › 05');
    expect(() => mediaFolderPath('11/12/2026')).toThrow();
  });
});

describe('gig media counters', () => {
  it('counts per day, gig name (case ignored) and kind', () => {
    expect(counterSk('2026-12-11', 'Northcote Social Club', 'img')).toBe(
      counterSk('2026-12-11', 'northcote social club', 'img'),
    );
    expect(counterSk('2026-12-11', 'A', 'img')).not.toBe(counterSk('2026-12-11', 'A', 'video'));
    expect(counterSk('2026-12-11', 'A', 'img')).not.toBe(counterSk('2026-12-12', 'A', 'img'));
  });

  it('works out the reserved block from the new counter value', () => {
    expect(reservedNumbers(5, 3)).toEqual([3, 4, 5]);
    expect(reservedNumbers(1, 1)).toEqual([1]);
  });

  it('numbers a mixed upload per kind, in the order picked', () => {
    const files = [
      { name: 'a.jpg', contentType: 'image/jpeg' },
      { name: 'b.mp4', contentType: 'video/mp4' },
      { name: 'c.png', contentType: 'image/png' },
    ];
    expect(countByKind(files)).toEqual({ img: 2, video: 1 });
    expect(numberFiles(files, 'Show', { img: 8, video: 1 }).map((f) => f.fileName)).toEqual([
      'Show_img_00008.jpg',
      'Show_video_00001.mp4',
      'Show_img_00009.png',
    ]);
  });
});

describe('gig media upload request', () => {
  const G = 'gabcdefgh0123456789';
  const file = { name: 'a.jpg', size: 10, contentType: 'image/jpeg' };
  it('takes several files at once', () => {
    expect(
      MediaUpload.parse({ gigId: G, files: [file, { ...file, contentType: 'video/mp4' }] }).files,
    ).toHaveLength(2);
  });
  it('refuses anything that is not a photo or video, empty uploads and too many', () => {
    expect(MediaUpload.safeParse({ gigId: 'BAD', files: [file] }).success).toBe(false);
    expect(
      MediaUpload.safeParse({ gigId: G, files: [{ ...file, contentType: 'application/pdf' }] })
        .success,
    ).toBe(false);
    expect(
      MediaUpload.safeParse({ gigId: G, files: [{ ...file, contentType: 'image/svg+xml' }] })
        .success,
    ).toBe(false);
    expect(MediaUpload.safeParse({ gigId: G, files: [] }).success).toBe(false);
    expect(
      MediaUpload.safeParse({ gigId: G, files: Array(MAX_MEDIA_PER_REQUEST + 1).fill(file) })
        .success,
    ).toBe(false);
    expect(MediaUpload.safeParse({ gigId: G, files: [{ ...file, size: 0 }] }).success).toBe(false);
  });
});

describe('gig media folder path', () => {
  const f = (folderId: string, name: string, parentId: string | null) => ({
    folderId,
    name,
    parentId,
  });
  const names = ['gigs', '2026', '12', '11'];
  it('finds what exists (case ignored) and lists what to make', () => {
    const folders = [f('a', 'Gigs', null), f('b', '2026', 'a'), f('x', '12', null)];
    const w = walkFolderPath(folders, names);
    expect(w.found.map((x) => x.folderId)).toEqual(['a', 'b']);
    expect(w.missing).toEqual(['12', '11']);
  });
  it('needs everything in an empty Library, and nothing once made', () => {
    expect(walkFolderPath([], names).missing).toEqual(names);
    const all = [f('a', 'gigs', null), f('b', '2026', 'a'), f('c', '12', 'b'), f('d', '11', 'c')];
    expect(walkFolderPath(all, names)).toEqual({ found: all, missing: [] });
  });
  it('gives each path one id that fits folder ids, the same for every upload', () => {
    const id = pathFolderId('art_aaaaaaaaaaaa', ['gigs', '2026']);
    expect(id).toMatch(/^[a-z0-9]{10,40}$/);
    expect(pathFolderId('art_aaaaaaaaaaaa', ['GIGS', '2026'])).toBe(id);
    expect(pathFolderId('art_bbbbbbbbbbbb', ['gigs', '2026'])).not.toBe(id);
    expect(pathFolderId('art_aaaaaaaaaaaa', ['gigs', '2026', '12'])).not.toBe(id);
  });
});
