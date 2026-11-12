import { expect, test } from '@playwright/test';
import { RUN_ID } from '../src/accounts.ts';
import { artistIdOf, call, ok } from '../src/api.ts';

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

test.afterAll(async () => {
  if (folder) await call('artistOn', 'DELETE', `${base()}/${folder.folderId}`);
});
