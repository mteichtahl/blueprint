import { expect, test } from '@playwright/test';
import { RUN_ID, tag } from '../src/accounts.ts';
import { artistIdOf, call, ok, subOf } from '../src/api.ts';
import {
  PDF_BYTES,
  PNG_BYTES,
  scanned,
  sendToS3,
  startUpload,
  type FileView,
} from '../src/helpers.ts';

/**
 * UAT script I (and E-07, J-13): real uploads into the test artist's Library,
 * through the presigned form and the malware scan, then who can open, edit,
 * version and delete them. Everything uploaded here is deleted at the end.
 */

test.describe.configure({ mode: 'serial' });

let artistId: string;
let staffSub: string;
let closedFolder: string;
let pressKit: FileView;
let privateFile: FileView;
let disguised: FileView;
let inClosed: FileView;
const made: string[] = [];
const files = (id = '') => `/artists/${artistId}/files${id ? `/${id}` : ''}`;
const listed = async (as: 'admin' | 'staff' | 'artistOn') =>
  (await ok<{ files: FileView[] }>(as, 'GET', files())).files.map((f) => f.fileId);
const denied = (status: number) => expect([403, 404], `status ${status}`).toContain(status);

test.beforeAll(async () => {
  // The scan takes up to a couple of minutes, so all four go up together.
  test.setTimeout(360_000);
  artistId = await artistIdOf('artistOn');
  staffSub = await subOf('staff');
  closedFolder = (
    await ok<{ folderId: string }>('artistOn', 'POST', `/artists/${artistId}/folders`, {
      name: `E2E closed ${RUN_ID.replace(/[\\/]/g, '-')}`,
      parentId: null,
    })
  ).folderId;
  await ok('artistOn', 'PUT', `/artists/${artistId}/folders/access`, {
    item: { kind: 'folder', id: closedFolder },
    grants: { 'g:team': 'none' },
  });
  const started = await Promise.all([
    startUpload('artistOn', artistId, { name: 'e2e-press-kit.pdf', title: tag('Press kit') }),
    startUpload('artistOn', artistId, { name: 'e2e-private.pdf', visibility: 'private' }),
    startUpload('artistOn', artistId, {
      name: 'e2e-photo.pdf',
      bytes: PNG_BYTES,
      contentType: 'application/pdf',
    }),
    startUpload('artistOn', artistId, { name: 'e2e-in-closed.pdf', folderId: closedFolder }),
  ]);
  made.push(...started.map((f) => f.fileId));
  const ready = await Promise.all(started.map((f) => scanned('artistOn', artistId, f.fileId)));
  [pressKit, privateFile, disguised, inClosed] = ready as [FileView, FileView, FileView, FileView];
});

test('I-03, I-04: an artist’s upload is scanned, listed, and only they can edit it', async () => {
  expect(pressKit.status).toBe('available');
  expect(pressKit.title).toBe(tag('Press kit'));
  expect(pressKit.editAccess).toBe('owner');
  expect(pressKit.locked).toBe(true);
  expect(await listed('admin')).toContain(pressKit.fileId);
  expect(await listed('staff')).toContain(pressKit.fileId);
});

test('I-11: Blueprint can open a locked document but not change it', async () => {
  const seen = await ok<FileView>('admin', 'GET', files(pressKit.fileId));
  expect(seen.canEdit).toBe(false);
  expect((await call('admin', 'PATCH', files(pressKit.fileId), { title: 'x' })).status).toBe(403);
  expect((await call('staff', 'PATCH', files(pressKit.fileId), { title: 'x' })).status).toBe(403);
  denied((await call('admin', 'DELETE', files(pressKit.fileId))).status);
});

test('I-07: the document page has its details, owner, version, access and where it’s used', async () => {
  const d = await ok<
    FileView & {
      size: number;
      ownerRole: string;
      ownedByMe: boolean;
      uses: unknown[];
      inUse: boolean;
    }
  >('artistOn', 'GET', `${files(pressKit.fileId)}?include=uses,people`);
  expect(d.name).toBe('e2e-press-kit.pdf');
  expect(d.title).toBe(tag('Press kit'));
  expect(d.fileType.kind).toBe('pdf');
  expect(d.size).toBe(PDF_BYTES.length);
  expect(d.version).toBe(1);
  expect(d.ownedByMe).toBe(true);
  expect(d.ownerRole).toBe('artist');
  expect(Array.isArray(d.uses)).toBe(true);
  expect(d.inUse).toBe(false);
});

test('downloads give back exactly what was uploaded', async () => {
  for (const as of ['artistOn', 'admin'] as const) {
    const { url } = await ok<{ url: string }>(as, 'POST', `${files(pressKit.fileId)}/download`, {});
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
  }
});

test('I-05: the type comes from the bytes, not the name', async () => {
  expect(disguised.fileType.kind).toBe('image');
  expect(disguised.fileType.detected).toBe(true);
});

test('a private file is the artist’s alone', async () => {
  expect(await listed('artistOn')).toContain(privateFile.fileId);
  expect(await listed('admin')).not.toContain(privateFile.fileId);
  denied((await call('admin', 'GET', files(privateFile.fileId))).status);
  denied((await call('admin', 'POST', `${files(privateFile.fileId)}/download`, {})).status);
});

test('J-13: an upload into a folder closed to Blueprint stays closed', async () => {
  expect(await listed('artistOn')).toContain(inClosed.fileId);
  expect(await listed('admin')).not.toContain(inClosed.fileId);
  expect(await listed('staff')).not.toContain(inClosed.fileId);
  denied((await call('staff', 'GET', files(inClosed.fileId))).status);
});

test('E-07: files Blueprint can’t open can’t be sent for review', async () => {
  for (const f of [privateFile, inClosed]) {
    const res = await call('artistOn', 'POST', `/artists/${artistId}/submissions`, {
      title: tag('should not submit'),
      type: 'demo',
      neededBy: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      fileIds: [f.fileId],
    });
    expect(res.status, f.name).toBe(400);
  }
});

test('another artist can’t open any of them', async () => {
  for (const f of [pressKit, privateFile, inClosed]) {
    denied((await call('artistOther', 'GET', files(f.fileId))).status);
  }
});

test('I-12: chosen editors can rename and add versions, not change sharing or delete', async () => {
  const shared = await ok<FileView>('artistOn', 'PATCH', files(pressKit.fileId), {
    editAccess: 'chosen',
    editorIds: [staffSub],
  });
  expect(shared.editAccess).toBe('chosen');
  const renamed = await ok<FileView>('staff', 'PATCH', files(pressKit.fileId), {
    title: tag('Press kit (renamed by staff)'),
  });
  expect(renamed.title).toBe(tag('Press kit (renamed by staff)'));
  expect(
    (await call('staff', 'PATCH', files(pressKit.fileId), { editAccess: 'everyone' })).status,
  ).toBe(403);
  denied((await call('staff', 'DELETE', files(pressKit.fileId))).status);
  // Someone not chosen still can't edit.
  expect((await call('admin', 'PATCH', files(pressKit.fileId), { title: 'x' })).status).toBe(403);
});

test('I-08: a new version keeps the name and sharing; the old one stays in history', async () => {
  test.setTimeout(240_000);
  const res = await ok<{ upload: { url: string; fields: Record<string, string> } }>(
    'artistOn',
    'POST',
    `${files(pressKit.fileId)}/versions`,
    {
      name: 'e2e-press-kit-v2.pdf',
      size: PDF_BYTES.length,
      contentType: 'application/pdf',
      note: 'Updated bio',
    },
  );
  await sendToS3(res.upload, PDF_BYTES, 'application/pdf');
  const v2 = await scanned('artistOn', artistId, pressKit.fileId, 2);
  expect(v2.version).toBe(2);
  expect(v2.versions.map((v) => v.v)).toContain(1);
  expect(v2.title).toBe(tag('Press kit (renamed by staff)'));
  expect(v2.editAccess).toBe('chosen');
});

test('I-10: restoring v1 makes it the newest version, and nothing is lost', async () => {
  test.setTimeout(240_000);
  const res = await call('artistOn', 'POST', `${files(pressKit.fileId)}/versions`, {
    restoreFrom: 1,
  });
  expect(res.status).toBe(202);
  const v3 = await scanned('artistOn', artistId, pressKit.fileId, 3);
  expect(v3.version).toBe(3);
  expect(v3.versions.map((v) => v.v)).toEqual(expect.arrayContaining([1, 2]));
});

test('J-15: a folder holding a file that’s in use can’t be deleted', async () => {
  await ok('artistOn', 'PUT', `${files(inClosed.fileId)}/asset`, {
    category: 'press-photo',
    title: tag('asset in a folder'),
  });
  const res = await call('artistOn', 'DELETE', `/artists/${artistId}/folders/${closedFolder}`);
  expect(res.status).toBe(409);
  expect(JSON.stringify(res.data)).toMatch(/in use/);
  await ok('artistOn', 'DELETE', `${files(inClosed.fileId)}/asset`);
});

test('I-13, I-14: a document in the asset library can’t be deleted until it’s taken out', async () => {
  await ok('artistOn', 'PUT', `${files(pressKit.fileId)}/asset`, {
    category: 'press-photo',
    title: tag('Press kit asset'),
  });
  const blocked = await call('artistOn', 'DELETE', files(pressKit.fileId));
  expect(blocked.status).toBe(409);
  expect(JSON.stringify(blocked.data)).toMatch(/use/i);
  await ok('artistOn', 'DELETE', `${files(pressKit.fileId)}/asset`);
  await ok('artistOn', 'DELETE', files(pressKit.fileId));
  made.splice(made.indexOf(pressKit.fileId), 1);
  denied((await call('artistOn', 'GET', files(pressKit.fileId))).status);
});

test.afterAll(async () => {
  for (const id of made) {
    await call('artistOn', 'DELETE', `${files(id)}/asset`);
    await call('artistOn', 'DELETE', files(id));
  }
  if (closedFolder)
    await call('artistOn', 'DELETE', `/artists/${artistId}/folders/${closedFolder}`);
});
