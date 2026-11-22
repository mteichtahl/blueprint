import { expect, test } from '@playwright/test';
import { RUN_ID } from '../src/accounts.ts';
import { artistIdOf, call, ok, subOf } from '../src/api.ts';

/**
 * UAT script J: an artist's folder closed to Blueprint stays closed, to admins
 * too, and nobody can lock the artist out of their own Library.
 */

interface Folder {
  folderId: string;
  name: string;
}

test.describe.configure({ mode: 'serial' });

let artistId: string;
let folder: Folder;
const base = () => `/artists/${artistId}/folders`;
const names = async (as: 'admin' | 'staff' | 'artistOn') =>
  (await ok<{ folders: Folder[] }>(as, 'GET', base())).folders.map((f) => f.folderId);

test.beforeAll(async () => {
  artistId = await artistIdOf('artistOn');
});

test('J-17: the artist makes a folder Blueprint can see by default', async () => {
  folder = await ok<Folder>('artistOn', 'POST', base(), {
    name: `E2E ${RUN_ID.replace(/[\\/]/g, '-')}`,
    parentId: null,
  });
  expect(await names('admin')).toContain(folder.folderId);
});

test('J-18: closed to Blueprint, it disappears for admins and staff', async () => {
  await ok('artistOn', 'PUT', `${base()}/access`, {
    item: { kind: 'folder', id: folder.folderId },
    grants: { 'g:team': 'none', 'g:admins': 'none' },
  });
  expect(await names('artistOn')).toContain(folder.folderId);
  expect(await names('admin')).not.toContain(folder.folderId);
  expect(await names('staff')).not.toContain(folder.folderId);
});

test('Blueprint can’t give itself access back', async () => {
  const res = await call('admin', 'PUT', `${base()}/access`, {
    item: { kind: 'folder', id: folder.folderId },
    grants: { 'g:admins': 'manage' },
  });
  expect([403, 404]).toContain(res.status);
  expect(await names('admin')).not.toContain(folder.folderId);
});

test('J-05: other artists can’t list the Library at all', async () => {
  expect([403, 404]).toContain((await call('artistOther', 'GET', base())).status);
});

// ── Deep folders and how access is worked out (rev 10) ────────────────────

interface Shown extends Folder {
  parentId: string | null;
}
const tree: Shown[] = [];
const access = (id: string, grants?: Record<string, string | null>, inherit?: boolean) =>
  ok('artistOn', 'PUT', `${base()}/access`, {
    item: { kind: 'folder', id },
    ...(grants ? { grants } : {}),
    ...(inherit !== undefined ? { inherit } : {}),
  });
const check = async (who: 'admin' | 'staff', id: string) =>
  ok<{ level: string; because: string }>(
    'artistOn',
    'GET',
    `${base()}/check?kind=folder&id=${id}&sub=${await subOf(who)}`,
  );

test('J-01: folders nest five levels deep', async () => {
  let parentId: string | null = null;
  for (const n of [1, 2, 3, 4, 5]) {
    const name = n === 1 ? `E2E tree ${RUN_ID.replace(/[\\/]/g, '-')}` : `Level ${n}`;
    const made: Shown = await ok<Shown>('artistOn', 'POST', base(), { name, parentId });
    tree.push(made);
    parentId = made.folderId;
  }
  const all = (await ok<{ folders: Shown[] }>('artistOn', 'GET', base())).folders;
  const deepest = all.find((f) => f.folderId === tree[4]!.folderId);
  expect(deepest?.parentId).toBe(tree[3]!.folderId);
});

test('J-02: a slash in the name, or a name already used beside it, is refused', async () => {
  test.skip(tree.length < 5, 'No tree was made');
  const slash = await call('artistOn', 'POST', base(), {
    name: 'a/b',
    parentId: tree[0]!.folderId,
  });
  expect(slash.status).toBe(400);
  const twin = await call('artistOn', 'POST', base(), {
    name: 'Level 2',
    parentId: tree[0]!.folderId,
  });
  expect(twin.status).toBe(409);
});

test('J-12: a folder can’t move into its own subfolder', async () => {
  test.skip(tree.length < 5, 'No tree was made');
  const res = await call('artistOn', 'POST', `${base()}/move`, {
    items: [{ kind: 'folder', id: tree[0]!.folderId }],
    to: tree[4]!.folderId,
  });
  expect(res.status).toBe(409);
});

test('J-06, J-08, J-09: the nearest setting wins, and resetting falls back to the parent', async () => {
  test.skip(tree.length < 5, 'No tree was made');
  const [top, , level3] = tree;
  await access(top!.folderId, { 'g:team': 'none' });
  await access(level3!.folderId, { [`p:${await subOf('staff')}`]: 'view' });
  // Closed at the top, opened for one person further down.
  expect((await check('staff', top!.folderId)).level).toBe('none');
  expect((await check('staff', tree[1]!.folderId)).level).toBe('none');
  expect((await check('staff', level3!.folderId)).level).toBe('view');
  expect((await check('admin', level3!.folderId)).level).toBe('none');
  // Staff now see that folder (and only that one), admins still don't.
  expect(await names('staff')).toContain(level3!.folderId);
  expect(await names('staff')).not.toContain(top!.folderId);
  expect(await names('admin')).not.toContain(level3!.folderId);

  // Reset to inherited: back to the top folder's setting, which the check names.
  await access(level3!.folderId, { [`p:${await subOf('staff')}`]: null });
  const after = await check('staff', level3!.folderId);
  expect(after.level).toBe('none');
  expect(after.because).toContain(top!.name);
});

test('J-10: "Don’t inherit" stops the parent’s setting', async () => {
  test.skip(tree.length < 5, 'No tree was made');
  // Open the top to Blueprint again (its default), then cut Level 4 off from it.
  await access(tree[0]!.folderId, { 'g:team': null });
  expect((await check('staff', tree[1]!.folderId)).level).toBe('edit');
  await access(tree[3]!.folderId, undefined, false);
  expect((await check('staff', tree[3]!.folderId)).level).toBe('none');
  expect((await check('staff', tree[4]!.folderId)).level).toBe('none');
  expect((await check('staff', tree[2]!.folderId)).level).toBe('edit');
});

test('J-16: an empty folder deletes, and so does a tree of empty folders', async () => {
  test.skip(tree.length < 5, 'No tree was made');
  await ok('artistOn', 'DELETE', `${base()}/${tree[4]!.folderId}`);
  const res = await ok<{ folders: number }>('artistOn', 'DELETE', `${base()}/${tree[0]!.folderId}`);
  expect(res.folders).toBe(4);
  const left = await names('artistOn');
  for (const f of tree) expect(left).not.toContain(f.folderId);
  tree.length = 0;
});

test.afterAll(async () => {
  if (folder) await call('artistOn', 'DELETE', `${base()}/${folder.folderId}`);
  if (tree[0]) await call('artistOn', 'DELETE', `${base()}/${tree[0].folderId}`);
});
