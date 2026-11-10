import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { libraryRoute } from '../src/files/library-route.ts';
import {
  can,
  entriesFor,
  fileAccess,
  folderAccess,
  hiddenFromBlueprint,
  legacyLevel,
  rootAccess,
  type Viewer,
} from '../src/files/access.ts';
import {
  AccessBody,
  accessTo,
  ancestors,
  cleanGrants,
  compareAccess,
  descendants,
  folderManaged,
  folderMap,
  FolderCreate,
  inheritedGrants,
  isInside,
  keyAllowed,
  legacyLibraryGrants,
  MoveBody,
  nameTaken,
  resolve,
  type FolderRecord,
  type Grants,
  type Space,
} from '../src/files/folders.ts';
import type { FileRecord } from '../src/files/model.ts';

const A = 'art_aaaaaaaaaaaa';
const B = 'art_bbbbbbbbbbbb';
const sub = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const admin: Viewer = { sub: sub(1), role: 'bmg-admin', mfaSatisfied: true };
const staff: Viewer = {
  sub: sub(2),
  role: 'bmg-staff',
  assignedArtistIds: [A],
  mfaSatisfied: true,
};
const staff2: Viewer = {
  sub: sub(3),
  role: 'bmg-staff',
  assignedArtistIds: [A],
  mfaSatisfied: true,
};
const unassigned: Viewer = {
  sub: sub(4),
  role: 'bmg-staff',
  assignedArtistIds: [],
  mfaSatisfied: true,
};
const artistA: Viewer = { sub: sub(5), role: 'artist', artistId: A, mfaSatisfied: true };
const artistB: Viewer = { sub: sub(6), role: 'artist', artistId: B, mfaSatisfied: true };

const LIB: Space = { kind: 'library' };
const SPACE_A: Space = { kind: 'artist', artistId: A };

let n = 0;
function folder(
  name: string,
  parentId: string | null,
  grants?: Record<string, string>,
  extra: Partial<FolderRecord> = {},
): FolderRecord {
  n++;
  return {
    folderId: `f${String(n).padStart(11, '0')}`,
    name,
    parentId,
    ownerId: admin.sub,
    ownerRole: 'bmg-admin',
    createdAt: '2026-11-10T00:00:00Z',
    createdBy: admin.sub,
    ...(grants ? { grants: grants as Grants } : {}),
    ...extra,
  };
}

function file(extra: Partial<FileRecord> = {}): FileRecord {
  return {
    fileId: 'file0000000001',
    scope: 'library',
    name: 'rider.pdf',
    size: 10,
    contentType: 'application/pdf',
    status: 'available',
    uploadedBy: staff.sub,
    uploaderRole: 'bmg-staff',
    createdAt: '2026-11-10T00:00:00Z',
    ...extra,
  };
}

/** The worked example from the rev 10 doc, section 6. */
function example() {
  const contracts = folder('Contracts', null, { 'g:artists': 'none' });
  const y2026 = folder('2026', contracts.folderId);
  const chloe = folder('Chloe', y2026.folderId, { [`a:${A}`]: 'view' });
  const signed = folder('Signed', chloe.folderId, { [`a:${A}`]: 'none' });
  const templates = folder('Templates', contracts.folderId, { 'g:artists': 'view' });
  const all = [contracts, y2026, chloe, signed, templates];
  return { contracts, y2026, chloe, signed, templates, map: folderMap(all), all };
}

const level = (p: Viewer, f: FolderRecord, map: ReturnType<typeof folderMap>, space: Space = LIB) =>
  folderAccess(p, f, map, space).level;

describe('library defaults', () => {
  const map = folderMap([]);
  it('the team edits, admins manage, artists have no access', () => {
    expect(rootAccess(staff, map, LIB).level).toBe('edit');
    expect(rootAccess(admin, map, LIB).level).toBe('manage');
    expect(rootAccess(artistA, map, LIB).level).toBe('none');
  });
  it('without two-step verification, nothing', () => {
    expect(rootAccess({ ...admin, mfaSatisfied: false }, map, LIB).level).toBe('none');
  });
});

describe('the worked example (section 6)', () => {
  const ex = example();
  it('Chloe opens her folder but not Signed', () => {
    expect(level(artistA, ex.chloe, ex.map)).toBe('view');
    expect(level(artistA, ex.signed, ex.map)).toBe('none');
    expect(level(artistA, ex.contracts, ex.map)).toBe('none');
    expect(level(artistA, ex.y2026, ex.map)).toBe('none');
  });
  it('every artist can view Templates', () => {
    expect(level(artistA, ex.templates, ex.map)).toBe('view');
    expect(level(artistB, ex.templates, ex.map)).toBe('view');
    expect(level(artistB, ex.chloe, ex.map)).toBe('none');
  });
  it('the team edits everything', () => {
    for (const f of ex.all) expect(level(staff, f, ex.map)).toBe('edit');
  });
  it('turning off inheritance on 2026 changes nothing until edited', () => {
    const copied = inheritedGrants({ kind: 'folder', folder: ex.y2026 }, ex.map, LIB);
    const y = { ...ex.y2026, inherit: false, grants: copied };
    const map = folderMap(ex.all.map((f) => (f.folderId === y.folderId ? y : f)));
    for (const p of [staff, artistA, artistB]) {
      for (const f of ex.all) expect(level(p, map.get(f.folderId)!, map)).toBe(level(p, f, ex.map));
    }
  });
  it('a file in Chloe’s folder inherits; its own setting overrides', () => {
    const inChloe = file({ folderId: ex.chloe.folderId });
    expect(fileAccess(artistA, inChloe, ex.map).level).toBe('view');
    const closed = { ...inChloe, grants: { [`a:${A}`]: 'none' } as Grants };
    expect(fileAccess(artistA, closed, ex.map).level).toBe('none');
  });
});

describe('nearest setting wins', () => {
  it('the nearest node decides, even a group setting over a person further up', () => {
    const top = folder('Top', null, { [`p:${staff.sub}`]: 'none' });
    const mid = folder('Mid', top.folderId, { 'g:team': 'view' });
    const map = folderMap([top, mid]);
    expect(level(staff, mid, map)).toBe('view');
    expect(level(staff, top, map)).toBe('none');
  });
  it('on one item, the person beats the group', () => {
    const f = folder('F', null, { 'g:team': 'edit', [`p:${staff.sub}`]: 'view' });
    const map = folderMap([f]);
    expect(level(staff, f, map)).toBe('view');
    expect(level(staff2, f, map)).toBe('edit');
  });
  it('two groups on one item: the higher level', () => {
    const f = folder('F', null, { 'g:team': 'view', 'g:admins': 'none' });
    // Admins manage the whole library regardless; check the rule itself.
    expect(resolve(admin, [f], LIB).level).toBe('view');
  });
  it('"Don\'t inherit" stops the walk', () => {
    const top = folder('Top', null, { 'g:team': 'edit' });
    const closed = folder(
      'Closed',
      top.folderId,
      { [`p:${staff2.sub}`]: 'edit' },
      { inherit: false },
    );
    const map = folderMap([top, closed]);
    expect(level(staff, closed, map)).toBe('none');
    expect(level(staff2, closed, map)).toBe('edit');
  });
});

describe('fixed rules', () => {
  it('owners keep manage in the library', () => {
    const f = folder(
      'Mine',
      null,
      { 'g:team': 'none' },
      { ownerId: staff.sub, ownerRole: 'bmg-staff' },
    );
    expect(level(staff, f, folderMap([f]))).toBe('manage');
    expect(level(staff2, f, folderMap([f]))).toBe('none');
  });
  it('artists never edit the library', () => {
    const f = folder('F', null, { 'g:artists': 'edit' });
    expect(level(artistA, f, folderMap([f]))).toBe('view');
  });
  it('the artist always manages their own space; Blueprint edits by default', () => {
    const f = folder('Demos', null, undefined, { ownerId: artistA.sub, ownerRole: 'artist' });
    const map = folderMap([f]);
    expect(level(artistA, f, map, SPACE_A)).toBe('manage');
    expect(level(staff, f, map, SPACE_A)).toBe('edit');
    expect(level(admin, f, map, SPACE_A)).toBe('edit');
    expect(level(unassigned, f, map, SPACE_A)).toBe('none');
    expect(level(artistB, f, map, SPACE_A)).toBe('none');
  });
  it('the artist can close a folder to Blueprint, and Blueprint can’t override it', () => {
    const f = folder(
      'Private demos',
      null,
      { 'g:team': 'none' },
      { ownerId: staff.sub, ownerRole: 'bmg-staff' },
    );
    const map = folderMap([f]);
    expect(level(staff, f, map, SPACE_A)).toBe('none'); // even the owner
    expect(level(admin, f, map, SPACE_A)).toBe('none');
    expect(level(artistA, f, map, SPACE_A)).toBe('manage');
  });
  it('private and BMG-only files keep their caps in folders', () => {
    const f = folder('All', null, { 'g:team': 'edit' });
    const map = folderMap([f]);
    const priv = file({
      scope: 'artist',
      artistId: A,
      folderId: f.folderId,
      visibility: 'private',
      uploadedBy: artistA.sub,
      uploaderRole: 'artist',
    });
    const bmgOnly = file({
      scope: 'artist',
      artistId: A,
      folderId: f.folderId,
      visibility: 'bmg-only',
    });
    expect(fileAccess(admin, priv, map).level).toBe('none');
    expect(fileAccess(artistA, priv, map).level).toBe('manage');
    expect(fileAccess(artistA, bmgOnly, map).level).toBe('none');
    expect(fileAccess(staff, bmgOnly, map).level).toBe('manage'); // its owner
  });
  it('another artist only opens what was sent in a chat', () => {
    const f = folder('All', null);
    const map = folderMap([f]);
    const sent = file({
      scope: 'artist',
      artistId: A,
      folderId: f.folderId,
      visibility: 'private',
      sharedWithArtistIds: [B],
    });
    expect(fileAccess(artistB, sent, map).level).toBe('view');
    expect(fileAccess(artistB, { ...sent, sharedWithArtistIds: [] }, map).level).toBe('none');
  });
  it('only Blueprint can be named in an artist’s space', () => {
    expect(keyAllowed(SPACE_A, 'g:team')).toBe(true);
    expect(keyAllowed(SPACE_A, `p:${staff.sub}`)).toBe(true);
    expect(keyAllowed(SPACE_A, 'g:artists')).toBe(false);
    expect(keyAllowed(SPACE_A, `a:${B}`)).toBe(false);
    expect(cleanGrants(SPACE_A, { 'g:artists': 'view', 'g:team': 'none' })).toEqual({
      'g:team': 'none',
    });
    expect(cleanGrants(LIB, {})).toBeUndefined();
  });
});

describe('files from before rev 10', () => {
  it('keep their rev 8 rules until put in a folder', () => {
    const lib = file({ sharing: 'selected', sharedWithArtistIds: [A] });
    expect(folderManaged(lib)).toBe(false);
    expect(legacyLevel(artistA, lib)).toBe('view');
    expect(legacyLevel(artistB, lib)).toBe('none');
    expect(legacyLevel(staff, lib)).toBe('edit');
    expect(legacyLevel(admin, lib)).toBe('manage');
    const art = file({ scope: 'artist', artistId: A, visibility: 'normal' });
    expect(legacyLevel(artistA, art)).toBe('manage');
    expect(legacyLevel(staff, art)).toBe('edit');
    expect(legacyLevel(unassigned, art)).toBe('none');
    expect(legacyLevel(admin, { ...art, visibility: 'private' })).toBe('none');
  });
  it('their sharing comes along as their own setting when moved', () => {
    expect(legacyLibraryGrants({ sharing: 'all-artists' })).toEqual({ 'g:artists': 'view' });
    expect(legacyLibraryGrants({ sharing: 'selected', sharedWithArtistIds: [A, B] })).toEqual({
      [`a:${A}`]: 'view',
      [`a:${B}`]: 'view',
    });
    expect(legacyLibraryGrants({ sharing: 'bmg-only' })).toBeUndefined();
    const moved = file({
      sharing: 'selected',
      sharedWithArtistIds: [A],
      folderId: 'f00000000099',
      grants: legacyLibraryGrants({ sharing: 'selected', sharedWithArtistIds: [A] }),
    });
    expect(fileAccess(artistA, moved, folderMap([])).level).toBe('view');
    expect(fileAccess(artistB, moved, folderMap([])).level).toBe('none');
  });
});

describe('no depth limit', () => {
  it('a 2,000-level tree resolves quickly, from the bottom', () => {
    const chain: FolderRecord[] = [folder('L0', null, { [`a:${A}`]: 'view' })];
    for (let i = 1; i < 2000; i++) chain.push(folder(`L${i}`, chain[i - 1]!.folderId));
    const map = folderMap(chain);
    const leaf = chain.at(-1)!;
    const t = performance.now();
    for (let i = 0; i < 20; i++) expect(level(artistA, leaf, map)).toBe('view');
    expect((performance.now() - t) / 20).toBeLessThan(150);
    expect(ancestors(map, leaf.parentId)).toHaveLength(1999);
    expect(isInside(map, leaf.folderId, chain[0]!.folderId)).toBe(true);
    expect(descendants(chain, chain[0]!.folderId)).toHaveLength(1999);
  });
  it('a loop in bad data ends the walk instead of hanging', () => {
    const a = folder('A', 'f99999999998');
    const b = folder('B', a.folderId);
    const looped = { ...a, parentId: b.folderId };
    const map = folderMap([looped, b]);
    expect(ancestors(map, b.parentId).length).toBeLessThanOrEqual(2);
    expect(level(staff, b, map)).toBe('edit');
  });
});

describe('the Access panel and summaries', () => {
  const ex = example();
  it('lists each setting with where it comes from, nearest first', () => {
    const e = entriesFor({ kind: 'folder', folder: ex.signed }, ex.map, LIB);
    expect(e.find((x) => x.key === `a:${A}`)).toMatchObject({
      level: 'none',
      source: { kind: 'here' },
    });
    expect(e.find((x) => x.key === 'g:artists')).toMatchObject({
      level: 'none',
      source: { kind: 'inherited', folderName: 'Contracts' },
    });
    expect(e.find((x) => x.key === 'g:team')).toMatchObject({
      level: 'edit',
      source: { kind: 'default' },
    });
  });
  it('counts who gains and loses access', () => {
    const before = { kind: 'folder' as const, folder: ex.chloe };
    const after = { kind: 'folder' as const, folder: { ...ex.chloe, grants: {} } };
    const changes = compareAccess([artistA, artistB, staff], [{ before, after }], {
      before: (p, it) => accessTo(p, it, ex.map, LIB).level,
      after: (p, it) => accessTo(p, it, ex.map, LIB).level,
    });
    expect(changes).toEqual([{ sub: artistA.sub, gains: 0, loses: 1 }]);
  });
  it('knows when Blueprint has been closed out of an artist’s file (knowledge base)', () => {
    const closed = folder('Closed', null, { [`p:${staff.sub}`]: 'none' });
    const open = folder('Open', null);
    const map = folderMap([closed, open]);
    const f = file({ scope: 'artist', artistId: A });
    expect(hiddenFromBlueprint({ ...f, folderId: closed.folderId }, map)).toBe(true);
    expect(hiddenFromBlueprint({ ...f, folderId: open.folderId }, map)).toBe(false);
    expect(hiddenFromBlueprint(f, map)).toBe(false);
  });
  it('can() compares levels', () => {
    expect(can({ level: 'edit', why: { kind: 'default' } }, 'view')).toBe(true);
    expect(can({ level: 'view', why: { kind: 'default' } }, 'edit')).toBe(false);
  });
});

describe('requests', () => {
  it('folder names: required, 120 characters, no slashes, unique beside each other', () => {
    expect(FolderCreate.safeParse({ name: 'Contracts' }).success).toBe(true);
    expect(FolderCreate.safeParse({ name: '  ' }).success).toBe(false);
    expect(FolderCreate.safeParse({ name: 'a/b' }).success).toBe(false);
    expect(FolderCreate.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    const ex = example();
    expect(nameTaken(ex.all, null, 'contracts')).toBe(true);
    expect(nameTaken(ex.all, ex.contracts.folderId, 'contracts')).toBe(false);
    expect(nameTaken(ex.all, null, 'Contracts', ex.contracts.folderId)).toBe(false);
  });
  it('access changes name real people and groups only', () => {
    expect(
      AccessBody.safeParse({
        item: { kind: 'folder', id: 'f00000000001' },
        grants: { 'g:team': 'view' },
      }).success,
    ).toBe(true);
    expect(
      AccessBody.safeParse({
        item: { kind: 'folder', id: 'f00000000001' },
        grants: { everyone: 'view' },
      }).success,
    ).toBe(false);
    expect(AccessBody.safeParse({ item: { kind: 'folder', id: 'f00000000001' } }).success).toBe(
      false,
    );
  });
  it('moves take up to 200 items to a folder or the top', () => {
    expect(
      MoveBody.safeParse({ items: [{ kind: 'file', id: 'file0000000001' }], to: null }).success,
    ).toBe(true);
    expect(MoveBody.safeParse({ items: [], to: null }).success).toBe(false);
  });
});

describe('the library proxy route', () => {
  const ev = (proxy: string) =>
    libraryRoute({
      resource: '/library/{proxy+}',
      pathParameters: { proxy },
    } as unknown as APIGatewayProxyEvent);
  it('maps paths back to the old routes', () => {
    expect(ev('files').resource).toBe('/library/files');
    expect(ev('files/abc123defg4').resource).toBe('/library/files/{fileId}');
    expect(ev('files/abc123defg4').pathParameters).toEqual({ fileId: 'abc123defg4' });
    expect(ev('files/abc123defg4/download').resource).toBe('/library/files/{fileId}/download');
    expect(ev('files/abc123defg4/versions').resource).toBe('/library/files/{fileId}/versions');
    expect(ev('files/abc123defg4/other').resource).toBe('/library/unknown');
    expect(ev('folders').resource).toBe('/library/folders');
    expect(ev('folders/move')).toMatchObject({
      resource: '/library/folders/{proxy+}',
      pathParameters: { proxy: 'move' },
    });
    expect(ev('elsewhere').resource).toBe('/library/unknown');
  });
});
