import { authorize, type Principal } from '@bmg/authz';
import { describe, expect, it } from 'vitest';
import {
  ArtistUpload,
  contentDisposition,
  deleteAllowed,
  isInlineSafe,
  LibraryUpload,
  librarySharing,
  MAX_UPLOAD_BYTES,
  parseQuarantineKey,
  publicFile,
  quarantineKey,
  scanOutcome,
  storedKey,
  visibilityAllowed,
  type FileRecord,
} from '../src/files/model.ts';

const A = 'art_aaaaaaaaaaaa';
const B = 'art_bbbbbbbbbbbb';
const fileId = 'mabcdefgh0123456789';
const fresh = { mfaSatisfied: true, secondsSinceAuth: 60 };
const artistA: Principal = { sub: 'u-a', role: 'artist', artistId: A, ...fresh };
const artistB: Principal = { sub: 'u-b', role: 'artist', artistId: B, ...fresh };

describe('S3 keys', () => {
  it('round-trips quarantine keys and keeps artists apart', () => {
    const k = quarantineKey('artist', fileId, A);
    expect(k).toBe(`artists/${A}/${fileId}`);
    expect(parseQuarantineKey(k)).toEqual({ scope: 'artist', artistId: A, fileId, part: 'file' });
    expect(parseQuarantineKey(quarantineKey('library', fileId))).toEqual({
      scope: 'library',
      fileId,
      part: 'file',
    });
    expect(storedKey('artist', fileId, A)).toBe(`artists/${A}/files/${fileId}`);
  });

  it('keeps a preview next to its file, under the same prefix', () => {
    const k = quarantineKey('artist', fileId, A, 'thumb');
    expect(k).toBe(`artists/${A}/${fileId}.thumb`);
    expect(parseQuarantineKey(k)).toEqual({ scope: 'artist', artistId: A, fileId, part: 'thumb' });
    expect(parseQuarantineKey(`library/${fileId}.thumb`)).toEqual({
      scope: 'library',
      fileId,
      part: 'thumb',
    });
    expect(storedKey('artist', fileId, A, 'thumb')).toBe(`artists/${A}/files/${fileId}.thumb`);
    expect(storedKey('library', fileId, undefined, 'thumb')).toBe(`library/${fileId}.thumb`);
    expect(parseQuarantineKey(`library/${fileId}.thumb.thumb`)).toBeUndefined();
    expect(parseQuarantineKey(`library/${fileId}.png`)).toBeUndefined();
  });

  it('ignores anything that is not an app upload', () => {
    expect(parseQuarantineKey('malware-protection-resource-validation-object')).toBeUndefined();
    expect(parseQuarantineKey(`artists/${A}/../${B}/${fileId}`)).toBeUndefined();
    expect(parseQuarantineKey(`artists/${A}/files/${fileId}`)).toBeUndefined();
    expect(parseQuarantineKey(`library/${fileId}/x`)).toBeUndefined();
  });
});

describe('upload requests', () => {
  it('accepts a normal upload and lower-cases the type', () => {
    const r = ArtistUpload.parse({ name: ' demo.mp3 ', size: 10, contentType: 'Audio/MPEG' });
    expect(r).toEqual({
      name: 'demo.mp3',
      size: 10,
      contentType: 'audio/mpeg',
      visibility: 'normal',
      sharedWithArtistIds: [],
    });
  });

  it('refuses empty, oversized and oddly named files', () => {
    expect(ArtistUpload.safeParse({ name: 'a', size: 0 }).success).toBe(false);
    expect(ArtistUpload.safeParse({ name: 'a', size: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
    expect(ArtistUpload.safeParse({ name: '../x', size: 1 }).success).toBe(false);
    expect(ArtistUpload.safeParse({ name: 'a\nb', size: 1 }).success).toBe(false);
    expect(
      ArtistUpload.safeParse({ name: 'a', size: 1, contentType: 'text/html; x' }).success,
    ).toBe(false);
  });

  it('only artists choose private, only BMG chooses BMG-only', () => {
    expect(visibilityAllowed('artist', 'private')).toBe(true);
    expect(visibilityAllowed('artist', 'bmg-only')).toBe(false);
    expect(visibilityAllowed('bmg-staff', 'private')).toBe(false);
    expect(visibilityAllowed('bmg-admin', 'bmg-only')).toBe(true);
    expect(visibilityAllowed('bmg-staff', 'normal')).toBe(true);
  });

  it('library uploads default to BMG-only', () => {
    expect(LibraryUpload.parse({ name: 'x.pdf', size: 1 }).sharing).toBe('bmg-only');
  });
});

describe('library sharing', () => {
  const rec = (sharing: FileRecord['sharing'], ids: string[] = []) =>
    librarySharing({ sharing, sharedWithArtistIds: ids });

  it('shares with every artist, named artists, or nobody', () => {
    expect(authorize(artistA, 'read', rec('all-artists')).allow).toBe(true);
    expect(authorize(artistA, 'read', rec('bmg-only')).allow).toBe(false);
    expect(authorize(artistA, 'read', rec('selected', [A])).allow).toBe(true);
    expect(authorize(artistB, 'read', rec('selected', [A])).allow).toBe(false);
  });

  it('ignores a stale artist list once a file is BMG-only again', () => {
    expect(authorize(artistA, 'read', rec('bmg-only', [A])).allow).toBe(false);
  });
});

describe('scan results', () => {
  it('promotes only clean files', () => {
    expect(scanOutcome('NO_THREATS_FOUND')).toEqual({ promote: true });
    for (const s of ['THREATS_FOUND', 'UNSUPPORTED', 'ACCESS_DENIED', 'FAILED', undefined]) {
      expect(scanOutcome(s).promote).toBe(false);
    }
  });
});

describe('downloads', () => {
  it('opens media inline and downloads everything else', () => {
    expect(isInlineSafe('image/png')).toBe(true);
    expect(isInlineSafe('audio/mpeg')).toBe(true);
    expect(isInlineSafe('image/svg+xml')).toBe(false);
    expect(isInlineSafe('text/html')).toBe(false);
    expect(isInlineSafe('application/pdf')).toBe(false);
  });

  it('writes a safe Content-Disposition for any name', () => {
    expect(contentDisposition('Mix "v2".wav', 'audio/wav')).toBe(
      `inline; filename="Mix _v2_.wav"; filename*=UTF-8''Mix%20%22v2%22.wav`,
    );
    expect(contentDisposition('Café.docx', 'application/msword')).toMatch(
      /^attachment; filename="Caf_.docx"; filename\*=UTF-8''Caf%C3%A9\.docx$/,
    );
  });

  it('never shows S3 keys and marks the viewer’s own uploads', () => {
    const f: FileRecord = {
      fileId,
      scope: 'artist',
      artistId: A,
      name: 'a',
      size: 1,
      contentType: 'audio/mpeg',
      status: 'available',
      visibility: 'normal',
      uploadedBy: 'u-a',
      uploaderRole: 'artist',
      createdAt: '2026-11-09T00:00:00Z',
    };
    const shown = publicFile(f, 'u-a');
    expect(shown.uploadedByMe).toBe(true);
    expect(JSON.stringify(shown)).not.toContain('artists/');
    expect(publicFile(f, 'u-b').uploadedByMe).toBe(false);
  });
});

describe('deleting files', () => {
  const admin = { sub: 'u-admin', role: 'bmg-admin' as const };
  const staff = { sub: 'u-staff', role: 'bmg-staff' as const };
  const lib = (uploadedBy: string) =>
    ({ scope: 'library', uploadedBy, uploaderRole: 'bmg-staff' }) as const;
  const art = (uploadedBy: string, uploaderRole: FileRecord['uploaderRole']) =>
    ({ scope: 'artist', uploadedBy, uploaderRole }) as const;

  it('lets an admin or the uploader delete library documents, never artists', () => {
    expect(deleteAllowed(admin, lib('someone'))).toBeUndefined();
    expect(deleteAllowed(staff, lib('u-staff'))).toBeUndefined();
    expect(deleteAllowed(staff, lib('someone'))).toMatch(/admin or the person/);
    expect(deleteAllowed(artistA, lib('u-a'))).toMatch(/Only Blueprint/);
  });

  it('keeps an artist’s own uploads theirs to delete', () => {
    expect(deleteAllowed(artistA, art('u-a', 'artist'))).toBeUndefined();
    expect(deleteAllowed(artistA, art('u-staff', 'bmg-staff'))).toMatch(/your own uploads/);
    expect(deleteAllowed(admin, art('u-a', 'artist'))).toMatch(/Only the artist/);
    expect(deleteAllowed(admin, art('u-staff', 'bmg-staff'))).toBeUndefined();
    expect(deleteAllowed(staff, art('u-other', 'bmg-staff'))).toMatch(/admin or the person/);
  });
});

describe('files sent in chat (rev 7)', () => {
  it('records the other artists in the chat on upload', () => {
    const up = ArtistUpload.parse({
      name: 'demo.mp3',
      size: 1000,
      contentType: 'audio/mpeg',
      visibility: 'private',
      sharedWithArtistIds: ['art_bbbbbbbbbbbb'],
    });
    expect(up.sharedWithArtistIds).toEqual(['art_bbbbbbbbbbbb']);
    expect(ArtistUpload.parse({ name: 'a.pdf', size: 1 }).sharedWithArtistIds).toEqual([]);
    expect(
      ArtistUpload.safeParse({ name: 'a.pdf', size: 1, sharedWithArtistIds: ['bob'] }).success,
    ).toBe(false);
  });
});
