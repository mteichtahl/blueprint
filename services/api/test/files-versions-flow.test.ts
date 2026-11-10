import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * New versions and Restore end to end through the promoter (rev 8), against
 * an in-memory S3, DynamoDB and event bus. Library documents, so no artist
 * data-access sessions are involved.
 */

const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
const sent: { DetailType: string; Detail: string }[] = [];
const items = new Map<string, Record<string, unknown>>();

vi.mock('@aws-sdk/client-s3', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-s3')>();
  const k = (b: string, key: string) => `${b}/${key}`;
  class S3Client {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const i = cmd.input as {
        Bucket: string;
        Key: string;
        Range?: string;
        Body?: Uint8Array;
        ContentType?: string;
        CopySource?: string;
      };
      switch (cmd.constructor.name) {
        case 'HeadObjectCommand': {
          const o = objects.get(k(i.Bucket, i.Key));
          if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
          return { ContentLength: o.body.length };
        }
        case 'GetObjectCommand': {
          const o = objects.get(k(i.Bucket, i.Key));
          if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
          const range = /bytes=0-(\d+)/.exec(String(i.Range ?? ''));
          const body = (
            range ? o.body.slice(0, Number(range[1]) + 1) : o.body.slice()
          ) as Uint8Array;
          return { Body: Object.assign(body, { transformToByteArray: async () => body }) };
        }
        case 'PutObjectCommand':
          objects.set(k(i.Bucket, i.Key), {
            body: Uint8Array.from(i.Body as Uint8Array),
            contentType: i.ContentType,
          });
          return {};
        case 'CopyObjectCommand': {
          const src = objects.get(String(i.CopySource));
          if (!src) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
          objects.set(k(i.Bucket, i.Key), { ...src });
          return {};
        }
        case 'DeleteObjectCommand':
          objects.delete(k(i.Bucket, i.Key));
          return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  }
  return { ...real, S3Client };
});

vi.mock('@aws-sdk/client-eventbridge', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-eventbridge')>();
  class EventBridgeClient {
    async send(cmd: { input: { Entries: { DetailType: string; Detail: string }[] } }) {
      sent.push(...cmd.input.Entries);
      return {};
    }
  }
  return { ...real, EventBridgeClient };
});

/** Just enough of DynamoDB's update expressions for the promoter: SET a.b = :v, REMOVE a. */
function update(
  item: Record<string, unknown>,
  expr: string,
  names: Record<string, string> = {},
  values: Record<string, unknown> = {},
) {
  const name = (p: string) =>
    p
      .trim()
      .split('.')
      .map((x) => names[x] ?? x);
  const [, set = '', remove = ''] = /^(?:SET (.*?))?(?: ?REMOVE (.*))?$/.exec(expr.trim())!;
  for (const clause of set.split(',').filter(Boolean)) {
    const [path, value] = clause.split('=').map((x) => x.trim());
    const parts = name(path!);
    let at = item;
    for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
    at[parts.at(-1)!] = values[value!];
  }
  for (const path of remove.split(',').filter(Boolean)) {
    const parts = name(path);
    let at = item;
    for (const p of parts.slice(0, -1)) at = (at[p] ?? {}) as Record<string, unknown>;
    delete at[parts.at(-1)!];
  }
}

vi.mock('../src/lib.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib.ts')>();
  const key = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
  const db = {
    async send(cmd: { constructor: { name: string }; input: unknown }) {
      const i = cmd.input as {
        Key: { PK: string; SK: string };
        UpdateExpression: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
      if (cmd.constructor.name === 'GetCommand') {
        const it = items.get(key(i.Key));
        return { Item: it ? structuredClone(it) : undefined };
      }
      if (cmd.constructor.name === 'UpdateCommand') {
        const it = items.get(key(i.Key));
        if (!it)
          throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
        update(it, i.UpdateExpression, i.ExpressionAttributeNames, i.ExpressionAttributeValues);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  return { ...real, db };
});

const { handler } = await import('../src/handlers/files-promote.ts');
const { archivedKey, fileSk, LIBRARY_PK, quarantineKey, storedKey } =
  await import('../src/files/model.ts');

const FILE = 'mabcdefgh0123456789';
const Q = 'quarantine';
const LIB = 'org-data';
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.7\n${text}`);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const scanned = (key: string, status = 'NO_THREATS_FOUND') =>
  handler({
    'detail-type': 'GuardDuty Malware Protection Object Scan Result',
    source: 'aws.guardduty',
    detail: {
      s3ObjectDetails: { bucketName: Q, objectKey: key },
      scanResultDetails: { scanResultStatus: status },
    },
  });
const record = () => items.get(`${LIBRARY_PK}|${fileSk(FILE)}`)!;

beforeEach(() => {
  objects.clear();
  items.clear();
  sent.length = 0;
  Object.assign(process.env, {
    MAIN_TABLE: 'main',
    EVENT_BUS: 'bus',
    QUARANTINE_BUCKET: Q,
    LIBRARY_BUCKET: LIB,
    ARTIST_BUCKET: 'artist-data',
  });
  const v1 = pdf('version one');
  objects.set(`${LIB}/${storedKey('library', FILE)}`, { body: v1 });
  items.set(`${LIBRARY_PK}|${fileSk(FILE)}`, {
    PK: LIBRARY_PK,
    SK: fileSk(FILE),
    fileId: FILE,
    scope: 'library',
    name: 'rider-v1.pdf',
    title: 'Tour rider',
    size: v1.length,
    contentType: 'application/pdf',
    status: 'available',
    sharing: 'all-artists',
    uploadedBy: 'u-kyra',
    uploaderRole: 'bmg-admin',
    createdAt: '2026-11-01T00:00:00Z',
    availableAt: '2026-11-01T00:01:00Z',
  });
});

function startVersion(v: number, body: Uint8Array, withThumb = false) {
  Object.assign(record(), {
    pendingVersion: {
      v,
      name: `rider-v${v}.pdf`,
      size: body.length,
      contentType: 'application/pdf',
      uploadedBy: 'u-staff',
      createdAt: new Date().toISOString(),
      note: 'Set times',
      status: 'pending',
      ...(withThumb
        ? { thumb: { status: 'pending', v, size: png.length, contentType: 'image/png' } }
        : {}),
    },
  });
  objects.set(`${Q}/${quarantineKey('library', FILE, undefined, 'file', v)}`, { body });
  if (withThumb) {
    objects.set(`${Q}/${quarantineKey('library', FILE, undefined, 'thumb', v)}`, { body: png });
  }
}

describe('a new version (rev 8)', () => {
  it('replaces the current bytes once clean, and keeps the old ones in the history', async () => {
    const v2 = pdf('version two, longer');
    startVersion(2, v2);
    await scanned(quarantineKey('library', FILE, undefined, 'file', 2));

    expect(objects.get(`${LIB}/${storedKey('library', FILE)}`)!.body).toEqual(v2);
    expect(objects.get(`${LIB}/${archivedKey('library', FILE, undefined, 1)}`)!.body).toEqual(
      pdf('version one'),
    );
    expect(objects.has(`${Q}/${quarantineKey('library', FILE, undefined, 'file', 2)}`)).toBe(false);
    const r = record();
    expect(r).toMatchObject({
      version: 2,
      name: 'rider-v2.pdf',
      title: 'Tour rider', // the name it's shown under stays
      size: v2.length,
      sharing: 'all-artists', // and so does who can see it
      versionUploadedBy: 'u-staff',
      versionNote: 'Set times',
      fileType: { kind: 'pdf', detected: true },
      versions: [{ v: 1, name: 'rider-v1.pdf', uploadedBy: 'u-kyra' }],
    });
    expect(r.pendingVersion).toBeUndefined();
    // The knowledge base re-reads the document.
    expect(sent.map((e) => e.DetailType)).toContain('file.available');
  });

  it('takes the new preview, whether it arrives before or after the file', async () => {
    startVersion(2, pdf('two'), true);
    await scanned(quarantineKey('library', FILE, undefined, 'thumb', 2));
    expect((record().pendingVersion as { thumb: { status: string } }).thumb.status).toBe(
      'available',
    );
    await scanned(quarantineKey('library', FILE, undefined, 'file', 2));
    expect(record().thumb).toMatchObject({ status: 'available', v: 2 });
    expect(objects.has(`${LIB}/${storedKey('library', FILE, undefined, 'thumb', 2)}`)).toBe(true);

    startVersion(3, pdf('three'), true);
    await scanned(quarantineKey('library', FILE, undefined, 'file', 3));
    expect(record().thumb).toMatchObject({ status: 'pending', v: 3 });
    await scanned(quarantineKey('library', FILE, undefined, 'thumb', 3));
    expect(record().thumb).toMatchObject({ status: 'available', v: 3 });
  });

  it('leaves the document as it was when the new version fails the scan', async () => {
    startVersion(2, pdf('two'), true);
    await scanned(quarantineKey('library', FILE, undefined, 'file', 2), 'THREATS_FOUND');
    expect(objects.get(`${LIB}/${storedKey('library', FILE)}`)!.body).toEqual(pdf('version one'));
    expect(record()).toMatchObject({
      name: 'rider-v1.pdf',
      pendingVersion: { v: 2, status: 'rejected', rejectReason: 'The malware scan found a threat' },
    });
    expect(record().version).toBeUndefined();
    // The person who uploaded it is told.
    const told = sent.find((e) => e.DetailType === 'file.rejected')!;
    expect(JSON.parse(told.Detail)).toMatchObject({ uploadedBy: 'u-staff' });
    // Its preview is dropped too.
    await scanned(quarantineKey('library', FILE, undefined, 'thumb', 2));
    expect(objects.has(`${LIB}/${storedKey('library', FILE, undefined, 'thumb', 2)}`)).toBe(false);
  });

  it('ignores a repeat delivery once settled', async () => {
    startVersion(2, pdf('two'));
    const key = quarantineKey('library', FILE, undefined, 'file', 2);
    await scanned(key);
    objects.set(`${Q}/${key}`, { body: pdf('sneaky') });
    await scanned(key);
    expect(objects.get(`${LIB}/${storedKey('library', FILE)}`)!.body).toEqual(pdf('two'));
    expect(objects.has(`${Q}/${key}`)).toBe(false);
    expect(record().versions).toHaveLength(1);
  });
});

describe('restoring an earlier version (rev 8)', () => {
  it('brings it back as the newest version, keeping everything', async () => {
    startVersion(2, pdf('two'));
    await scanned(quarantineKey('library', FILE, undefined, 'file', 2));
    Object.assign(record(), {
      pendingVersion: {
        v: 3,
        name: 'rider-v1.pdf',
        size: pdf('version one').length,
        contentType: 'application/pdf',
        uploadedBy: 'u-kyra',
        createdAt: new Date().toISOString(),
        note: 'Restored version 1',
        status: 'pending',
        restoredFrom: 1,
      },
    });
    await handler({
      'detail-type': 'file.restore',
      source: 'bmg.audit',
      detail: { fileId: FILE, library: true, v: 3 },
    });
    expect(objects.get(`${LIB}/${storedKey('library', FILE)}`)!.body).toEqual(pdf('version one'));
    expect(objects.get(`${LIB}/${archivedKey('library', FILE, undefined, 2)}`)!.body).toEqual(
      pdf('two'),
    );
    expect(record()).toMatchObject({
      version: 3,
      name: 'rider-v1.pdf',
      versionNote: 'Restored version 1',
      versions: [{ v: 2 }, { v: 1 }],
    });
  });

  it('says so when that version is no longer kept', async () => {
    Object.assign(record(), {
      version: 2,
      versions: [{ v: 1, name: 'a.pdf', size: 1, contentType: 'application/pdf' }],
      pendingVersion: { v: 3, status: 'pending', restoredFrom: 1, name: 'a.pdf' },
    });
    await handler({
      'detail-type': 'file.restore',
      source: 'bmg.audit',
      detail: { fileId: FILE, library: true, v: 3 },
    });
    expect(record().pendingVersion).toMatchObject({
      status: 'rejected',
      rejectReason: 'That version is no longer kept',
    });
  });
});
