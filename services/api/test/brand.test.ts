import { describe, expect, it } from 'vitest';
import {
  BrandKitBody,
  contrastChecks,
  contrastGrade,
  contrastRatio,
  EMPTY_KIT,
  referencedFiles,
} from '../src/brand/model.ts';
import { ArtistUpload, AssetMetaSchema, guessCategory, publicFile } from '../src/files/model.ts';

describe('brand kit', () => {
  it('starts empty at version 0', () => {
    expect(EMPTY_KIT.version).toBe(0);
    expect(EMPTY_KIT.colours).toEqual([]);
    expect(EMPTY_KIT.voice.bio).toBe('');
  });

  it('takes six-digit hex colours only, upper-cased', () => {
    const k = BrandKitBody.parse({
      version: 0,
      colours: [{ name: 'Plum', hex: '#3b1f3a', role: 'primary' }],
    });
    expect(k.colours[0]!.hex).toBe('#3B1F3A');
    expect(
      BrandKitBody.safeParse({ version: 0, colours: [{ name: 'X', hex: 'red', role: 'text' }] })
        .success,
    ).toBe(false);
    expect(BrandKitBody.safeParse({ version: 0, extra: 1 }).success).toBe(false);
  });

  it('lists every file it refers to once', () => {
    expect(
      referencedFiles({
        logos: [{ fileId: 'aaaaaaaaaa', label: 'Dark' }],
        imagery: { note: '', fileIds: ['aaaaaaaaaa', 'bbbbbbbbbb'] },
      }),
    ).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb']);
  });

  it('checks contrast the WCAG way', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    expect(contrastGrade(4.5)).toBe('AA');
    expect(contrastGrade(3.2)).toBe('AA large only');
    expect(contrastGrade(2)).toBe('Fails');
    const checks = contrastChecks([
      { name: 'Plum', hex: '#3B1F3A', role: 'primary' },
      { name: 'Sand', hex: '#E9D8C4', role: 'background' },
      { name: 'Ink', hex: '#1C1C1C', role: 'text' },
    ]);
    expect(checks.map((c) => c.label)).toEqual([
      'Text on background',
      'Primary on background',
      'Background on primary',
    ]);
    expect(checks[0]!.grade).toBe('AA');
  });
});

describe('assets', () => {
  it('describe what a file is and what it is approved for', () => {
    const a = AssetMetaSchema.parse({
      category: 'press-photo',
      title: 'Press shot 01',
      approvedFor: ['press', 'social'],
    });
    expect(a.status).toBe('draft');
    expect(
      AssetMetaSchema.safeParse({
        category: 'press-photo',
        title: 'x',
        approvedFor: ['billboards'],
      }).success,
    ).toBe(false);
  });

  it('can be uploaded straight into the asset library', () => {
    const u = ArtistUpload.parse({
      name: 'shot.jpg',
      size: 10,
      contentType: 'image/jpeg',
      asset: { category: 'press-photo', title: 'Shot' },
    });
    expect(u.asset?.title).toBe('Shot');
  });

  it('guesses a category from the file type', () => {
    expect(guessCategory('image/jpeg')).toBe('press-photo');
    expect(guessCategory('image/svg+xml')).toBe('logo');
    expect(guessCategory('video/mp4')).toBe('video');
    expect(guessCategory('audio/wav')).toBe('audio');
    expect(guessCategory('application/pdf')).toBe('other');
  });

  it('are returned with the file', () => {
    const f = publicFile(
      {
        fileId: 'f1',
        scope: 'artist',
        artistId: 'art_aaaaaaaaaaaa',
        name: 'shot.jpg',
        size: 1,
        contentType: 'image/jpeg',
        status: 'available',
        uploadedBy: 'u',
        uploaderRole: 'artist',
        createdAt: '',
        asset: { category: 'logo', title: 'Wordmark', approvedFor: [], status: 'approved' },
      },
      { sub: 'u', role: 'artist' },
    );
    expect(f.asset).toMatchObject({ title: 'Wordmark' });
  });
});
