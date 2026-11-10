import { authorize, type Principal } from '@bmg/authz';
import { describe, expect, it } from 'vitest';
import {
  blocksDelete,
  chatUseSk,
  fileUsePk,
  inUseMessage,
  archivedKey,
  asVersion,
  currentVersion,
  MAX_VERSIONS,
  nextVersion,
  trimVersions,
  versionBlocked,
  VersionUpload,
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
    expect(parseQuarantineKey(k)).toEqual({
      scope: 'artist',
      artistId: A,
      fileId,
      part: 'file',
      v: 1,
    });
    expect(parseQuarantineKey(quarantineKey('library', fileId))).toEqual({
      scope: 'library',
      fileId,
      part: 'file',
      v: 1,
    });
    expect(storedKey('artist', fileId, A)).toBe(`artists/${A}/files/${fileId}`);
  });

  it('keeps a preview next to its file, under the same prefix', () => {
    const k = quarantineKey('artist', fileId, A, 'thumb');
    expect(k).toBe(`artists/${A}/${fileId}.thumb`);
    expect(parseQuarantineKey(k)).toEqual({
      scope: 'artist',
      artistId: A,
      fileId,
      part: 'thumb',
      v: 1,
    });
    expect(parseQuarantineKey(`library/${fileId}.thumb`)).toEqual({
      scope: 'library',
      fileId,
      part: 'thumb',
      v: 1,
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

describe('versions (rev 8)', () => {
  const base: FileRecord = {
    fileId,
    scope: 'artist',
    artistId: A,
    name: 'rider-v1.pdf',
    title: 'Tour rider',
    size: 100,
    contentType: 'application/pdf',
    status: 'available',
    visibility: 'normal',
    uploadedBy: 'u-a',
    uploaderRole: 'artist',
    createdAt: '2026-11-01T00:00:00Z',
    availableAt: '2026-11-01T00:01:00Z',
  };

  it('gives a new version its own quarantine key, preview key and archive key', () => {
    const k = quarantineKey('artist', fileId, A, 'file', 3);
    expect(k).toBe(`artists/${A}/${fileId}.v3`);
    expect(parseQuarantineKey(k)).toEqual({
      scope: 'artist',
      artistId: A,
      fileId,
      part: 'file',
      v: 3,
    });
    expect(parseQuarantineKey(`library/${fileId}.v12.thumb`)).toEqual({
      scope: 'library',
      fileId,
      part: 'thumb',
      v: 12,
    });
    expect(parseQuarantineKey(`library/${fileId}`)?.v).toBe(1);
    // Version 1 has no suffix, so ".v1" and ".v0" are not app uploads.
    expect(parseQuarantineKey(`library/${fileId}.v1`)).toBeUndefined();
    expect(parseQuarantineKey(`library/${fileId}.v0`)).toBeUndefined();
    expect(parseQuarantineKey(`library/${fileId}.thumb.v2`)).toBeUndefined();
    // The current version always lives at the plain key; previews are per version.
    expect(storedKey('artist', fileId, A, 'file', 4)).toBe(`artists/${A}/files/${fileId}`);
    expect(storedKey('artist', fileId, A, 'thumb', 4)).toBe(
      `artists/${A}/files/${fileId}.v4.thumb`,
    );
    expect(storedKey('library', fileId, undefined, 'thumb', 1)).toBe(`library/${fileId}.thumb`);
    expect(archivedKey('library', fileId, undefined, 2)).toBe(`library/${fileId}.v2`);
  });

  it('numbers versions after the current one and any that did not make it', () => {
    expect(currentVersion(base)).toBe(1);
    expect(nextVersion(base)).toBe(2);
    expect(nextVersion({ version: 3 })).toBe(4);
    const rejected = {
      version: 3,
      pendingVersion: { v: 4, status: 'rejected' } as FileRecord['pendingVersion'],
    };
    expect(nextVersion(rejected)).toBe(5);
  });

  it('takes one new version at a time, and only once the file is ready', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    expect(versionBlocked(base, now)).toBeUndefined();
    expect(versionBlocked({ ...base, status: 'pending' }, now)).toMatch(/malware scan/);
    const pending = {
      v: 2,
      name: 'x',
      size: 1,
      contentType: 'application/pdf',
      uploadedBy: 'u-a',
      status: 'pending' as const,
    };
    expect(
      versionBlocked(
        { ...base, pendingVersion: { ...pending, createdAt: '2026-11-09T23:59:00Z' } },
        now,
      ),
    ).toMatch(/still being checked/);
    // One that never arrived no longer holds things up after a day.
    expect(
      versionBlocked(
        { ...base, pendingVersion: { ...pending, createdAt: '2026-11-08T00:00:00Z' } },
        now,
      ),
    ).toBeUndefined();
    expect(
      versionBlocked(
        {
          ...base,
          pendingVersion: { ...pending, status: 'rejected', createdAt: '2026-11-09T23:59:00Z' },
        },
        now,
      ),
    ).toBeUndefined();
  });

  it('records the replaced version in the history and keeps the newest 50', () => {
    expect(asVersion(base)).toEqual({
      v: 1,
      name: 'rider-v1.pdf',
      size: 100,
      contentType: 'application/pdf',
      uploadedBy: 'u-a',
      createdAt: '2026-11-01T00:01:00Z',
    });
    const list = Array.from({ length: 52 }, (_, i) => ({ ...asVersion(base), v: 52 - i }));
    const { kept, dropped } = trimVersions(list);
    expect(kept).toHaveLength(MAX_VERSIONS);
    expect(dropped.map((d) => d.v)).toEqual([2, 1]);
  });

  it('accepts a new version with a note, and nothing else', () => {
    expect(
      VersionUpload.parse({
        name: 'rider-v2.pdf',
        size: 5,
        contentType: 'application/pdf',
        note: ' Set times ',
      }),
    ).toMatchObject({ note: 'Set times' });
    expect(VersionUpload.safeParse({ name: 'a.pdf', size: 1, title: 'x' }).success).toBe(false);
    expect(VersionUpload.safeParse({ name: 'a.pdf', size: 1, note: 'x'.repeat(301) }).success).toBe(
      false,
    );
  });

  it('shows the history and a pending version without any keys', () => {
    const f: FileRecord = {
      ...base,
      name: 'rider-v2.pdf',
      version: 2,
      versionUploadedBy: 'u-staff',
      versionCreatedAt: '2026-11-09T00:00:00Z',
      versionNote: 'Set times',
      versions: [asVersion(base)],
      pendingVersion: {
        v: 3,
        name: 'rider-v3.pdf',
        size: 1,
        contentType: 'application/pdf',
        uploadedBy: 'u-a',
        createdAt: '2026-11-10T00:00:00Z',
        status: 'pending',
      },
    };
    const shown = publicFile(f, artistA);
    expect(shown).toMatchObject({
      version: 2,
      versionUploadedBy: 'u-staff',
      versionNote: 'Set times',
      versions: [{ v: 1, name: 'rider-v1.pdf', fileType: { kind: 'pdf' } }],
      pendingVersion: { v: 3, status: 'pending', restoredFrom: null },
    });
    expect(JSON.stringify(shown)).not.toContain('files/');
  });
});

describe('where it’s used (rev 8)', () => {
  it('blocks deleting while used anywhere other than chat', () => {
    expect(blocksDelete('asset')).toBe(true);
    expect(blocksDelete('brand-kit')).toBe(true);
    expect(blocksDelete('submission', 'open')).toBe(true);
    expect(blocksDelete('submission', 'reviewed')).toBe(false);
    expect(blocksDelete('chat')).toBe(false);
  });

  it('says how many places hold it', () => {
    expect(inUseMessage([{ blocks: false }])).toBeUndefined();
    expect(inUseMessage([{ blocks: true }])).toBe(
      'This document is used in 1 place. Remove it from there before deleting.',
    );
    expect(inUseMessage([{ blocks: true }, { blocks: true }, { blocks: false }])).toMatch(
      /used in 2 places\. Remove it from them/,
    );
  });

  it('keeps chat uses next to the file they belong to', () => {
    expect(fileUsePk('artist', fileId, A)).toBe(`FILEUSE#${A}#${fileId}`);
    expect(fileUsePk('library', fileId)).toBe(`FILEUSE#library#${fileId}`);
    expect(chatUseSk('dm-art_aaaaaaaaaaaa')).toBe('CHAT#dm-art_aaaaaaaaaaaa');
  });
});
