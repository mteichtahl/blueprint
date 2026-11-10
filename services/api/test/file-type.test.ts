import { describe, expect, it } from 'vitest';
import {
  ArtistFilePatch,
  ArtistUpload,
  LibraryPatch,
  LibraryUpload,
  publicFile,
  renameAllowed,
  type FileRecord,
} from '../src/files/model.ts';
import { detectFileType, extensionOf, guessFileType } from '../src/files/type.ts';

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

/** A minimal ZIP local file header for one stored entry. */
function zipEntry(name: string, data = ''): number[] {
  const h = new Uint8Array(30);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint32(18, data.length, true);
  v.setUint32(22, data.length, true);
  v.setUint16(26, name.length, true);
  return [...h, ...[...name].map((c) => c.charCodeAt(0)), ...[...data].map((c) => c.charCodeAt(0))];
}

const detect = (b: Uint8Array, name: string, claimed = '') => {
  const t = detectFileType(b, name, claimed);
  return [t.kind, t.label, t.ext, t.detected] as const;
};

describe('detectFileType', () => {
  it('knows common formats by their bytes, whatever the name says', () => {
    expect(detect(bytes('%PDF-1.7\n'), 'scan.bin')).toEqual(['pdf', 'PDF', 'pdf', true]);
    expect(detect(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'photo.jpg')[1]).toBe(
      'PNG image',
    );
    expect(detect(bytes([0xff, 0xd8, 0xff, 0xe0]), 'IMG_1234')[1]).toBe('JPEG image');
    expect(detect(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '), 'take3')[1]).toBe('WAV audio');
    expect(detect(bytes('ID3', [4, 0, 0]), 'song')[1]).toBe('MP3 audio');
    expect(detect(bytes('fLaC'), 'x')[1]).toBe('FLAC audio');
    expect(detect(bytes([0, 0, 0, 0x18], 'ftypmp42'), 'clip')[1]).toBe('MP4 video');
    expect(detect(bytes([0, 0, 0, 0x14], 'ftypqt  '), 'clip')[1]).toBe('QuickTime video');
    expect(detect(bytes([0, 0, 0, 0x18], 'ftypheic'), 'IMG_0001')[1]).toBe('HEIC photo');
    expect(detect(bytes([0, 0, 0, 0x18], 'ftypM4A '), 'voice')[1]).toBe('M4A audio');
    expect(detect(bytes('8BPS'), 'cover')[1]).toBe('Photoshop file');
  });

  it('tells Office files apart by what is inside the ZIP', () => {
    const docx = bytes(zipEntry('[Content_Types].xml', '<x/>'), zipEntry('word/document.xml'));
    expect(detect(docx, 'contract')).toEqual(['document', 'Word document', 'docx', true]);
    const xlsx = bytes(zipEntry('[Content_Types].xml', '<x/>'), zipEntry('xl/workbook.xml'));
    expect(detect(xlsx, 'budget.zip')[0]).toBe('spreadsheet');
    const pptx = bytes(zipEntry('[Content_Types].xml'), zipEntry('ppt/presentation.xml'));
    expect(detect(pptx, 'deck')[1]).toBe('PowerPoint');
    const odt = bytes(zipEntry('mimetype', 'application/vnd.oasis.opendocument.text'));
    expect(detect(odt, 'letter')[1]).toBe('OpenDocument text');
    // A ZIP whose header doesn't say: the extension decides, else it's an archive.
    const plain = bytes(zipEntry('[Content_Types].xml', 'x'.repeat(10)));
    expect(detect(plain, 'Rider.xlsx')[1]).toBe('Excel spreadsheet');
    expect(detect(bytes(zipEntry('photos/a.jpg')), 'photos')[1]).toBe('ZIP archive');
  });

  it('handles old Office, archives and text', () => {
    const ole = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(detect(ole, 'old.xls')[1]).toBe('Excel spreadsheet');
    expect(detect(ole, 'old')[1]).toBe('Word document');
    expect(detect(bytes('Rar!', [0x1a, 7]), 'x')[1]).toBe('RAR archive');
    expect(detect(bytes([0x1f, 0x8b, 8]), 'x.tgz')[1]).toBe('Gzip archive');
    expect(detect(bytes('name,email\nA,a@x.com\n'), 'guests.csv')).toEqual([
      'spreadsheet',
      'CSV',
      'csv',
      true,
    ]);
    expect(detect(bytes('# Rider\n- 2 vocal mics\n'), 'rider.md')[1]).toBe('Markdown');
    expect(detect(bytes('just notes'), 'notes')[1]).toBe('Text');
    expect(detect(bytes('<?xml version="1.0"?><svg xmlns="x"/>'), 'logo')[1]).toBe('SVG image');
    expect(detect(bytes('<!DOCTYPE html><html>'), 'page.txt')[1]).toBe('HTML');
  });

  it("falls back to a guess (marked as such) when the bytes aren't recognised", () => {
    const unknown = bytes([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(detect(unknown, 'session.logicx')).toEqual(['other', 'LOGICX file', 'logicx', false]);
    expect(detect(unknown, 'song.mp3')).toEqual(['audio', 'MP3 audio', 'mp3', false]);
    expect(detect(new Uint8Array(), 'empty')[0]).toBe('other');
  });
});

describe('guessFileType', () => {
  it('uses the extension, then the claimed type', () => {
    expect(guessFileType('Tour Rider.PDF').label).toBe('PDF');
    expect(guessFileType('IMG_0001', 'image/heic').label).toBe('HEIC photo');
    expect(guessFileType('clip', 'video/x-foo')).toMatchObject({ kind: 'video', label: 'Video' });
    expect(guessFileType('thing').label).toBe('File');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('no-ext.')).toBe('');
  });
});

describe('names and previews on upload', () => {
  it('takes an optional name, trimmed, with limits', () => {
    expect(
      ArtistUpload.parse({ name: 'IMG_0042.jpg', title: '  Press shot  ', size: 1 }).title,
    ).toBe('Press shot');
    expect(ArtistUpload.parse({ name: 'a.pdf', size: 1 }).title).toBeUndefined();
    expect(LibraryUpload.safeParse({ name: 'a', title: 'x'.repeat(201), size: 1 }).success).toBe(
      false,
    );
    expect(LibraryUpload.safeParse({ name: 'a', title: 'a\u0007b', size: 1 }).success).toBe(false);
  });

  it('only accepts a small raster preview', () => {
    const ok = { name: 'a.pdf', size: 1, thumbnail: { size: 9000, contentType: 'image/webp' } };
    expect(LibraryUpload.parse(ok).thumbnail).toEqual({ size: 9000, contentType: 'image/webp' });
    expect(
      LibraryUpload.safeParse({ ...ok, thumbnail: { size: 9000, contentType: 'image/svg+xml' } })
        .success,
    ).toBe(false);
    expect(
      LibraryUpload.safeParse({ ...ok, thumbnail: { size: 65 * 1024, contentType: 'image/png' } })
        .success,
    ).toBe(false);
  });

  it('shows the given name in lists, keeps the file name, and reports the type', () => {
    const rec: FileRecord = {
      fileId: 'f000000001',
      scope: 'library',
      name: 'IMG_0042.JPG',
      title: 'Mixer Night poster',
      size: 10,
      contentType: 'image/jpeg',
      status: 'available',
      uploadedBy: 'u1',
      uploaderRole: 'bmg-admin',
      createdAt: '2026-11-10T00:00:00Z',
      thumb: { status: 'available', size: 900, contentType: 'image/webp' },
    };
    const shown = publicFile(rec, 'u1');
    expect(shown).toMatchObject({
      name: 'IMG_0042.JPG',
      title: 'Mixer Night poster',
      displayName: 'Mixer Night poster',
      hasThumbnail: true,
      fileType: { kind: 'image', label: 'JPEG image', detected: false },
    });
    const plain = publicFile({ ...rec, title: undefined, thumb: undefined }, 'u1');
    expect(plain.displayName).toBe('IMG_0042.JPG');
    expect(plain.hasThumbnail).toBe(false);
    // Once scanned, the detected type wins over the guess.
    const detected = publicFile(
      { ...rec, fileType: detectFileType(bytes('%PDF-1.4'), rec.name, rec.contentType) },
      'u1',
    );
    expect(detected.fileType).toMatchObject({ kind: 'pdf', detected: true });
  });
});

describe('renaming after upload', () => {
  const lib = {
    scope: 'library' as const,
    uploadedBy: 'u-staff',
    uploaderRole: 'bmg-staff' as const,
  };
  const artistUpload = {
    scope: 'artist' as const,
    uploadedBy: 'u-art',
    uploaderRole: 'artist' as const,
  };
  const bmgUpload = {
    scope: 'artist' as const,
    uploadedBy: 'u-staff',
    uploaderRole: 'bmg-staff' as const,
  };
  const artist = { sub: 'u-art', role: 'artist' as const };
  const otherArtist = { sub: 'u-art2', role: 'artist' as const };
  const staff = { sub: 'u-other', role: 'bmg-staff' as const };

  it('Blueprint renames library documents; artists cannot', () => {
    expect(renameAllowed(staff, lib)).toBeUndefined();
    expect(renameAllowed(artist, lib)).toMatch(/Only Blueprint/);
  });

  it("each side renames its own side's files only", () => {
    expect(renameAllowed(artist, artistUpload)).toBeUndefined();
    expect(renameAllowed(otherArtist, artistUpload)).toMatch(/your own uploads/);
    expect(renameAllowed(artist, bmgUpload)).toMatch(/your own uploads/);
    expect(renameAllowed(staff, bmgUpload)).toBeUndefined();
    expect(renameAllowed(staff, artistUpload)).toMatch(/Only the artist/);
  });

  it('accepts a new name, or an empty one to show the file name again', () => {
    expect(ArtistFilePatch.parse({ title: '  Final mix  ' })).toEqual({ title: 'Final mix' });
    expect(ArtistFilePatch.parse({ title: '' })).toEqual({ title: '' });
    expect(ArtistFilePatch.safeParse({}).success).toBe(false);
    expect(ArtistFilePatch.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
    expect(ArtistFilePatch.safeParse({ name: 'evil.exe' }).success).toBe(false);
    expect(LibraryPatch.parse({ title: 'Rider' })).toMatchObject({ title: 'Rider' });
    expect(LibraryPatch.parse({ sharing: 'all-artists' }).sharing).toBe('all-artists');
    expect(LibraryPatch.safeParse({ sharedWithArtistIds: [] }).success).toBe(false);
  });
});
