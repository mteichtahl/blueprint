import { authorize, type Principal } from '@bmg/authz';
import { describe, expect, it } from 'vitest';
import {
  ArtistFilePatch,
  ArtistUpload,
  canBeEditor,
  contentDisposition,
  defaultEditAccess,
  deleteAllowed,
  editAccessOf,
  editAllowed,
  isInlineSafe,
  LibraryPatch,
  LibraryUpload,
  librarySharing,
  manageAllowed,
  MAX_UPLOAD_BYTES,
  ownerOf,
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
      editorIds: [],
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
    const shown = publicFile(f, artistA);
    expect(shown.uploadedByMe).toBe(true);
    expect(JSON.stringify(shown)).not.toContain('artists/');
    expect(publicFile(f, artistB).uploadedByMe).toBe(false);
  });
});

describe('deleting files', () => {
  const admin = { sub: 'u-admin', role: 'bmg-admin' as const };
  const staff = { sub: 'u-staff', role: 'bmg-staff' as const };
  const lib = (uploadedBy: string) =>
    ({ scope: 'library', uploadedBy, uploaderRole: 'bmg-staff' }) as const;
  const art = (uploadedBy: string, uploaderRole: FileRecord['uploaderRole']) =>
    ({ scope: 'artist', uploadedBy, uploaderRole }) as const;

  it('lets an admin or the owner delete library documents, never artists', () => {
    expect(deleteAllowed(admin, lib('someone'))).toBeUndefined();
    expect(deleteAllowed(staff, lib('u-staff'))).toBeUndefined();
    expect(deleteAllowed(staff, lib('someone'))).toMatch(/owner or an admin/);
    expect(deleteAllowed(artistA, lib('someone'))).toMatch(/owner or an admin/);
  });

  it('keeps an artist’s own uploads theirs to delete', () => {
    expect(deleteAllowed(artistA, art('u-a', 'artist'))).toBeUndefined();
    expect(deleteAllowed(artistA, art('u-staff', 'bmg-staff'))).toMatch(/owner or an admin/);
    expect(deleteAllowed(admin, art('u-a', 'artist'))).toMatch(/artist who owns/);
    expect(deleteAllowed(admin, art('u-staff', 'bmg-staff'))).toBeUndefined();
    expect(deleteAllowed(staff, art('u-other', 'bmg-staff'))).toMatch(/owner or an admin/);
  });

  it('follows the owner once a document has been handed over (rev 8)', () => {
    const handed = { ...art('u-staff', 'bmg-staff'), ownerId: 'u-a', ownerRole: 'artist' as const };
    expect(deleteAllowed(artistA, handed)).toBeUndefined();
    expect(deleteAllowed(staff, handed)).toMatch(/artist who owns/);
    expect(deleteAllowed(admin, handed)).toMatch(/artist who owns/);
  });
});

describe('owner and who can edit (rev 8)', () => {
  const admin = { sub: 'u-admin', role: 'bmg-admin' as const };
  const staff = { sub: 'u-staff', role: 'bmg-staff' as const };
  const kyra = { sub: 'u-kyra', role: 'bmg-staff' as const };
  const artistFile = {
    scope: 'artist' as const,
    artistId: A,
    uploadedBy: 'u-a',
    uploaderRole: 'artist' as const,
  };

  it('the uploader owns it until they hand it on', () => {
    expect(ownerOf(artistFile)).toEqual({ sub: 'u-a', role: 'artist' });
    expect(ownerOf({ ...artistFile, ownerId: 'u-staff', ownerRole: 'bmg-staff' })).toEqual({
      sub: 'u-staff',
      role: 'bmg-staff',
    });
  });

  it('library documents start open to the team; everything else starts locked', () => {
    expect(defaultEditAccess('library')).toBe('everyone');
    expect(defaultEditAccess('artist')).toBe('owner');
    expect(editAccessOf(artistFile)).toBe('owner');
  });

  it('a lock keeps everyone else out, even an admin', () => {
    expect(editAllowed(artistA, artistFile)).toBeUndefined();
    expect(editAllowed(admin, artistFile)).toMatch(/locked/);
    expect(editAllowed(staff, artistFile)).toMatch(/locked/);
  });

  it('chosen people can edit; others cannot', () => {
    const chosen = { ...artistFile, editAccess: 'chosen' as const, editorIds: ['u-staff'] };
    expect(editAllowed(staff, chosen)).toBeUndefined();
    expect(editAllowed(kyra, chosen)).toMatch(/given you edit access/);
  });

  it('everyone who can see it can edit when the owner opens it up', () => {
    expect(editAllowed(kyra, { ...artistFile, editAccess: 'everyone' })).toBeUndefined();
  });

  it('only the owner manages it, plus an admin for Blueprint-owned documents', () => {
    expect(manageAllowed(artistA, artistFile)).toBeUndefined();
    expect(manageAllowed(admin, artistFile)).toMatch(/artist who owns/);
    const staffDoc = { ...artistFile, uploadedBy: 'u-staff', uploaderRole: 'bmg-staff' as const };
    expect(manageAllowed(admin, staffDoc)).toBeUndefined();
    expect(manageAllowed(kyra, staffDoc)).toMatch(/owner or an admin/);
    // A chosen editor still can't manage it.
    expect(
      manageAllowed(staff, { ...artistFile, editAccess: 'chosen', editorIds: ['u-staff'] }),
    ).toBeDefined();
  });

  it('offers edit access only to people who can see the file', () => {
    const f = { scope: 'artist' as const, artistId: A, visibility: 'normal' as const };
    expect(canBeEditor({ role: 'artist', artistId: A }, f)).toBe(true);
    expect(canBeEditor({ role: 'artist', artistId: B }, f)).toBe(false);
    expect(canBeEditor({ role: 'bmg-admin' }, f)).toBe(true);
    expect(canBeEditor({ role: 'bmg-staff', assignedArtistIds: [A] }, f)).toBe(true);
    expect(canBeEditor({ role: 'bmg-staff', assignedArtistIds: [B] }, f)).toBe(false);
    expect(canBeEditor({ role: 'artist', artistId: A }, { ...f, visibility: 'bmg-only' })).toBe(
      false,
    );
    expect(canBeEditor({ role: 'bmg-admin' }, { ...f, visibility: 'private' })).toBe(false);
    const lib = { scope: 'library' as const };
    expect(canBeEditor({ role: 'bmg-staff', assignedArtistIds: [] }, lib)).toBe(true);
    expect(canBeEditor({ role: 'artist', artistId: A }, lib)).toBe(false);
  });

  it('shows each viewer what they can do, and chosen editors only to the owner', () => {
    const rec: FileRecord = {
      fileId,
      scope: 'artist',
      artistId: A,
      name: 'rider.pdf',
      size: 1,
      contentType: 'application/pdf',
      status: 'available',
      visibility: 'normal',
      uploadedBy: 'u-a',
      uploaderRole: 'artist',
      editAccess: 'chosen',
      editorIds: ['u-staff'],
      createdAt: '2026-11-10T00:00:00Z',
    };
    expect(publicFile(rec, artistA)).toMatchObject({
      ownedByMe: true,
      canEdit: true,
      canManage: true,
      locked: false,
      editorIds: ['u-staff'],
    });
    expect(publicFile(rec, { sub: 'u-staff', role: 'bmg-staff' })).toMatchObject({
      ownedByMe: false,
      canEdit: true,
      canManage: false,
      editorIds: [],
    });
    expect(publicFile({ ...rec, editAccess: 'owner' }, admin)).toMatchObject({
      canEdit: false,
      locked: true,
    });
  });

  it('accepts who-can-edit and a new owner, and nothing odd', () => {
    const sub = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(ArtistFilePatch.parse({ editAccess: 'chosen', editorIds: [sub, sub] })).toEqual({
      editAccess: 'chosen',
      editorIds: [sub],
    });
    expect(LibraryPatch.parse({ ownerId: sub }).ownerId).toBe(sub);
    expect(ArtistFilePatch.safeParse({ editAccess: 'anyone' }).success).toBe(false);
    expect(ArtistFilePatch.safeParse({ editorIds: ['bob'] }).success).toBe(false);
    expect(LibraryPatch.safeParse({}).success).toBe(false);
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
