import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Moving files into folders through the files API, against an in-memory DynamoDB: who can
 * open a gig's media, how files are named, and that numbers carry on across
 * uploads without clashing.
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

beforeEach(() => items.clear());

describe('moving a document into a folder', () => {
  it('library: the file shows in the folder afterwards', async () => {
    seedFile('ORG#library', 'library', 'file000000001', admin);
    const made = await req(
      admin,
      'POST',
      '/library/{proxy+}',
      { proxy: 'folders' },
      { name: 'Contracts' },
    );
    expect(made.status).toBe(201);
    const to = made.body.folderId;
    const moved = await req(
      admin,
      'POST',
      '/library/{proxy+}',
      { proxy: 'folders/move' },
      {
        items: [{ kind: 'file', id: 'file000000001' }],
        to,
      },
    );
    expect(moved.status).toBe(200);
    const list = await req(admin, 'GET', '/library/{proxy+}', { proxy: 'files' });
    expect(list.body.files[0].folderId).toBe(to);
  });

  it('artist Library: the file shows in the folder afterwards', async () => {
    seedFile(`ARTIST#${ARTIST}`, 'artist', 'file000000002', artist);
    const made = await req(
      artist,
      'POST',
      '/artists/{artistId}/folders',
      { artistId: ARTIST },
      { name: 'Demos' },
    );
    expect(made.status).toBe(201);
    const to = made.body.folderId;
    const moved = await req(
      artist,
      'POST',
      '/artists/{artistId}/folders/{proxy+}',
      { artistId: ARTIST, proxy: 'move' },
      {
        items: [{ kind: 'file', id: 'file000000002' }],
        to,
      },
    );
    expect(moved.status).toBe(200);
    const list = await req(artist, 'GET', '/artists/{artistId}/files', { artistId: ARTIST });
    expect(list.body.files[0].folderId).toBe(to);
  });
});
