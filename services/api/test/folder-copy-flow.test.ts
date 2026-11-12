import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Copy to… (rev 10) through the files API, against an in-memory DynamoDB and
 * S3: what a copy is called, who owns it, where it lands, what access it
 * takes, and that artist copies stay under the artist's key and context.
 */

const items = new Map<string, Record<string, unknown>>();
const key = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;

vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: async (_: unknown, p: { Key: string }) => ({
    url: 'https://quarantine.example',
    fields: { key: p.Key },
  }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => 'https://signed' }));

const copies: { Key: string; CopySource: string; SSEKMSEncryptionContext?: string }[] = [];
vi.mock('@aws-sdk/client-s3', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-s3')>();
  class S3Client {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      if (cmd.constructor.name === 'CopyObjectCommand') copies.push(cmd.input as never);
      return {};
    }
  }
  return { ...real, S3Client };
});
vi.mock('@bmg/crypto', async (orig) => {
  const real = await orig<typeof import('@bmg/crypto')>();
  class DataAccessSessions {
    async credentials() {
      return { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' };
    }
  }
  return { ...real, DataAccessSessions };
});

vi.mock('../src/files/people.ts', () => ({
  namesFor: async () => new Map(),
  people: async () => [],
}));

vi.mock('../src/lib.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib.ts')>();
  const db = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const i = cmd.input as {
        Key: { PK: string; SK: string };
        Item: Record<string, unknown> & { PK: string; SK: string };
        ExpressionAttributeValues: Record<string, unknown>;
      };
      switch (cmd.constructor.name) {
        case 'GetCommand': {
          const it = items.get(key(i.Key));
          return { Item: it ? structuredClone(it) : undefined };
        }
        case 'PutCommand':
          if (cmd.input.ConditionExpression && items.has(key(i.Item)))
            throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
          items.set(key(i.Item), structuredClone(i.Item));
          return {};
        case 'UpdateCommand': {
          // SET a = :x, b = :y  [REMOVE c, d]
          const it = items.get(key(i.Key));
          if (!it)
            throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
          const expr = String(cmd.input.UpdateExpression);
          const names = (cmd.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
          const [setPart, removePart] = expr.split(' REMOVE ');
          for (const a of setPart!.replace(/^SET /, '').split(',')) {
            const [l, r] = a.split('=').map((x) => x.trim());
            it[names[l!] ?? l!] = i.ExpressionAttributeValues[r!];
          }
          for (const r of (removePart ?? '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean))
            delete it[r];
          items.set(key(i.Key), it);
          return {};
        }
        case 'DeleteCommand':
          items.delete(key(i.Key));
          return {};
        case 'QueryCommand': {
          const pk = i.ExpressionAttributeValues[':pk'] as string;
          const prefix = (i.ExpressionAttributeValues[':f'] ??
            i.ExpressionAttributeValues[':p']) as string;
          return {
            Items: [...items.values()]
              .map((x) => structuredClone(x))
              .filter((x) => x.PK === pk && String(x.SK).startsWith(prefix)),
          };
        }
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  return {
    ...real,
    db,
    env: (n: string) => n.toLowerCase(),
    audit: async () => {},
    principalFor: async (ctx: { sub: string; role: string; artistId?: string }) => ({
      ...ctx,
      ...(ctx.role === 'bmg-staff' ? { assignedArtistIds: [ARTIST] } : {}),
      mfaSatisfied: true,
      secondsSinceAuth: 10,
    }),
  };
});

const { handler } = await import('../src/handlers/files.ts');
const { MAX_COPY_FILES } = await import('../src/files/folders.ts');

const ARTIST = 'art_aaaaaaaaaaaa';
const admin = { sub: '44444444-4444-4444-4444-444444444444', role: 'bmg-admin' };
const artist = { sub: '11111111-1111-1111-1111-111111111111', role: 'artist', artistId: ARTIST };

async function req(
  who: Record<string, string>,
  method: string,
  resource: string,
  params: Record<string, string>,
  body?: unknown,
  query?: Record<string, string>,
) {
  const res = await handler({
    httpMethod: method,
    resource,
    pathParameters: params,
    queryStringParameters: query ?? null,
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: { ...who, sessionId: 's' } },
  } as unknown as APIGatewayProxyEvent);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}

function seedFile(
  pk: string,
  scope: 'library' | 'artist',
  fileId: string,
  by: { sub: string; role: string },
) {
  items.set(`${pk}|FILE#${fileId}`, {
    PK: pk,
    SK: `FILE#${fileId}`,
    fileId,
    scope,
    ...(scope === 'artist' ? { artistId: ARTIST, visibility: 'normal' } : { sharing: 'bmg-only' }),
    name: 'rider.pdf',
    size: 10,
    contentType: 'application/pdf',
    status: 'available',
    uploadedBy: by.sub,
    uploaderRole: by.role,
    createdAt: '2026-11-10T00:00:00Z',
  });
}

beforeEach(() => {
  items.clear();
  copies.length = 0;
});

const lib = (who: Record<string, string>, method: string, proxy: string, body?: unknown) =>
  req(who, method, '/library/{proxy+}', { proxy }, body);
const filesIn = (pk: string) =>
  [...items.values()].filter((x) => x.PK === pk && String(x.SK).startsWith('FILE#'));

describe('Copy to… (rev 10)', () => {
  it('copies a library document into a folder: yours, taking the folder’s access', async () => {
    seedFile('ORG#library', 'library', 'file000000001', admin);
    const made = await lib(admin, 'POST', 'folders', { name: 'Contracts' });
    const to = made.body.folderId as string;
    const res = await lib(admin, 'POST', 'folders/copy', {
      items: [{ kind: 'file', id: 'file000000001' }],
      to,
    });
    expect(res).toMatchObject({ status: 201, body: { files: 1, folders: 0, skipped: 0 } });
    const copy = filesIn('ORG#library').find((f) => f.fileId !== 'file000000001')!;
    expect(copy).toMatchObject({
      folderId: to,
      status: 'available',
      ownerId: admin.sub,
      editAccess: 'everyone',
      name: 'rider.pdf',
    });
    expect(copy.sharing).toBeUndefined();
    expect(copy.title).toBeUndefined();
    expect(copies).toEqual([
      expect.objectContaining({
        Key: `library/${copy.fileId}`,
        CopySource: 'library_bucket/library/file000000001',
      }),
    ]);
  });

  it('a copy in the same place is “Copy of …”, and at the top of the library it’s Blueprint only', async () => {
    seedFile('ORG#library', 'library', 'file000000001', admin);
    Object.assign(items.get('ORG#library|FILE#file000000001')!, { sharing: 'all-artists' });
    const res = await lib(admin, 'POST', 'folders/copy', {
      items: [{ kind: 'file', id: 'file000000001' }],
      to: null,
    });
    expect(res.status).toBe(201);
    const copy = filesIn('ORG#library').find((f) => f.fileId !== 'file000000001')!;
    expect(copy).toMatchObject({ title: 'Copy of rider.pdf', sharing: 'bmg-only' });
  });

  it('copies a folder with what’s inside, naming it “Copy of …” beside the original', async () => {
    const top = (await lib(admin, 'POST', 'folders', { name: 'Tour' })).body.folderId as string;
    const inner = (await lib(admin, 'POST', 'folders', { name: 'Riders', parentId: top })).body
      .folderId as string;
    seedFile('ORG#library', 'library', 'file000000001', admin);
    Object.assign(items.get('ORG#library|FILE#file000000001')!, { folderId: inner });
    const res = await lib(admin, 'POST', 'folders/copy', {
      items: [{ kind: 'folder', id: top }],
      to: null,
    });
    expect(res.body).toMatchObject({ files: 1, folders: 2, skipped: 0 });
    const folders = [...items.values()].filter((x) => String(x.SK).startsWith('FOLDER#'));
    const copyTop = folders.find((f) => f.name === 'Copy of Tour')!;
    const copyInner = folders.find((f) => f.name === 'Riders' && f.folderId !== inner)!;
    expect(copyTop.parentId).toBeNull();
    expect(copyInner.parentId).toBe(copyTop.folderId);
    expect(res.body.firstFolderId).toBe(copyTop.folderId);
    const copied = filesIn('ORG#library').find((f) => f.fileId !== 'file000000001')!;
    expect(copied.folderId).toBe(copyInner.folderId);
  });

  it('refuses a folder copied into itself, and too many files at once', async () => {
    const top = (await lib(admin, 'POST', 'folders', { name: 'Tour' })).body.folderId as string;
    const inner = (await lib(admin, 'POST', 'folders', { name: 'Riders', parentId: top })).body
      .folderId as string;
    const into = await lib(admin, 'POST', 'folders/copy', {
      items: [{ kind: 'folder', id: top }],
      to: inner,
    });
    expect(into.status).toBe(409);
    for (let i = 0; i <= MAX_COPY_FILES; i++) {
      seedFile('ORG#library', 'library', `file${String(i).padStart(9, '0')}`, admin);
      Object.assign(items.get(`ORG#library|FILE#file${String(i).padStart(9, '0')}`)!, {
        folderId: top,
      });
    }
    const many = await lib(admin, 'POST', 'folders/copy', {
      items: [{ kind: 'folder', id: top }],
      to: null,
    });
    expect(many.status).toBe(413);
    // Nothing was half-copied.
    expect(copies).toEqual([]);
  });

  it('an artist’s private file copies as private, under their key and the private context', async () => {
    seedFile(`ARTIST#${ARTIST}`, 'artist', 'file000000002', artist);
    Object.assign(items.get(`ARTIST#${ARTIST}|FILE#file000000002`)!, {
      visibility: 'private',
      thumb: { status: 'available', size: 5, contentType: 'image/webp' },
    });
    const res = await req(
      artist,
      'POST',
      '/artists/{artistId}/folders/{proxy+}',
      { artistId: ARTIST, proxy: 'copy' },
      { items: [{ kind: 'file', id: 'file000000002' }], to: null },
    );
    expect(res.status).toBe(201);
    const copy = filesIn(`ARTIST#${ARTIST}`).find((f) => f.fileId !== 'file000000002')!;
    expect(copy).toMatchObject({
      visibility: 'private',
      editAccess: 'owner',
      title: 'Copy of rider.pdf',
      thumb: { status: 'available', v: 1 },
    });
    expect(copies).toHaveLength(2);
    const ctx = JSON.parse(Buffer.from(copies[0]!.SSEKMSEncryptionContext!, 'base64').toString());
    expect(JSON.stringify(ctx)).toContain('private');
    expect(copies[0]!.Key).toBe(`artists/${ARTIST}/files/${copy.fileId}`);
  });
});
