import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Gig media through the files API, against an in-memory DynamoDB: who can
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
          // Only the counter's `ADD last :c SET type = :t` is used here.
          const it = items.get(key(i.Key)) ?? { ...i.Key };
          it.last = Number(it.last ?? 0) + Number(i.ExpressionAttributeValues[':c']);
          it.type = i.ExpressionAttributeValues[':t'];
          items.set(key(i.Key), it);
          return { Attributes: { last: it.last } };
        }
        case 'QueryCommand': {
          const pk = i.ExpressionAttributeValues[':pk'] as string;
          const prefix = (i.ExpressionAttributeValues[':f'] ??
            i.ExpressionAttributeValues[':p']) as string;
          return {
            Items: [...items.values()].filter(
              (x) => x.PK === pk && String(x.SK).startsWith(prefix),
            ),
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
const OTHER = 'art_bbbbbbbbbbbb';
const GIG = 'gabcdefgh0123456789';
const artist = { sub: '11111111-1111-1111-1111-111111111111', role: 'artist', artistId: ARTIST };
const other = { sub: '22222222-2222-2222-2222-222222222222', role: 'artist', artistId: OTHER };
const staff = { sub: '33333333-3333-3333-3333-333333333333', role: 'bmg-staff' };

function call(
  who: Record<string, string>,
  method: 'GET' | 'POST',
  body?: { files: unknown[] },
  gigId = GIG,
) {
  return handler({
    httpMethod: method,
    resource: '/artists/{artistId}/files',
    pathParameters: { artistId: ARTIST },
    queryStringParameters: method === 'GET' ? { gigId } : null,
    body: body === undefined ? null : JSON.stringify({ gigId, ...body }),
    requestContext: { authorizer: { ...who, sessionId: 's' } },
  } as unknown as APIGatewayProxyEvent);
}

const photo = (name = 'IMG_1.JPG') => ({ name, size: 1000, contentType: 'image/jpeg' });
const video = (name = 'clip.MOV') => ({ name, size: 5000, contentType: 'video/quicktime' });

function seedGig(shared = true, title = 'Northcote Social Club') {
  items.set(`ARTIST#${ARTIST}|GIG#${GIG}`, {
    PK: `ARTIST#${ARTIST}`,
    SK: `GIG#${GIG}`,
    gigId: GIG,
    artistId: ARTIST,
    title,
    date: '2026-12-11',
    status: 'confirmed',
    deal: 'tbc',
    checklist: [],
    plannedBy: 'artist',
    shared,
    createdBy: artist.sub,
    createdAt: '2026-11-01T00:00:00Z',
  });
}

beforeEach(() => {
  items.clear();
  seedGig();
});

const folders = () =>
  [...items.values()].filter((x) => String(x.SK).startsWith('FOLDER#')) as {
    folderId: string;
    name: string;
    parentId: string | null;
    ownerId: string;
    grants?: Record<string, string>;
  }[];
const pathOf = (folderId: string) => {
  const byId = new Map(folders().map((f) => [f.folderId, f]));
  const out: string[] = [];
  for (let f = byId.get(folderId); f; f = f.parentId ? byId.get(f.parentId) : undefined)
    out.unshift(f.name);
  return out.join('/');
};

describe('gig media folders (rev 10)', () => {
  it('files uploads in gigs/<year>/<month>/<day>, making the folders once', async () => {
    const a = JSON.parse((await call(artist, 'POST', { files: [photo()] })).body);
    expect(pathOf(a.folderId)).toBe('gigs/2026/12/11');
    expect(a.files[0].file.folderId).toBe(a.folderId);
    expect(folders()).toHaveLength(4);
    expect(folders().every((f) => f.ownerId === artist.sub)).toBe(true);
    const b = JSON.parse((await call(artist, 'POST', { files: [video()] })).body);
    expect(b.folderId).toBe(a.folderId);
    expect(folders()).toHaveLength(4);
    expect(JSON.parse((await call(artist, 'GET')).body).folderId).toBe(a.folderId);
  });

  it('uses folders the artist already made, whatever their case', async () => {
    const mk = (folderId: string, name: string, parentId: string | null) =>
      items.set(`ARTIST#${ARTIST}|FOLDER#${folderId}`, {
        PK: `ARTIST#${ARTIST}`,
        SK: `FOLDER#${folderId}`,
        folderId,
        name,
        parentId,
        ownerId: artist.sub,
        ownerRole: 'artist',
        createdAt: '',
        createdBy: artist.sub,
      });
    mk('ffffffffff01', 'Gigs', null);
    mk('ffffffffff02', '2026', 'ffffffffff01');
    const a = JSON.parse((await call(artist, 'POST', { files: [photo()] })).body);
    expect(pathOf(a.folderId)).toBe('Gigs/2026/12/11');
    expect(folders()).toHaveLength(4);
  });

  it('carries on when the fixed folder id is held by a folder since renamed', async () => {
    await call(artist, 'POST', { files: [photo()] });
    const top = folders().find((f) => f.parentId === null)!;
    items.get(`ARTIST#${ARTIST}|FOLDER#${top.folderId}`)!.name = 'Old gigs';
    const b = JSON.parse((await call(artist, 'POST', { files: [photo()] })).body);
    expect(pathOf(b.folderId)).toBe('gigs/2026/12/11');
    expect(b.files[0].file.name).toBe('Northcote Social Club_img_00002.jpg');
  });

  it('lets Blueprint add by default, until the artist sets the team to Can view', async () => {
    await call(artist, 'POST', { files: [photo()] });
    const seen = JSON.parse((await call(staff, 'GET')).body);
    expect(seen.files).toHaveLength(1);
    expect(seen.canAdd).toBe(true);
    expect((await call(staff, 'POST', { files: [photo()] })).statusCode).toBe(201);
    // The artist sets the Blueprint team to Can view on "gigs": it cascades to every day.
    const top = folders().find((f) => f.parentId === null)!;
    items.get(`ARTIST#${ARTIST}|FOLDER#${top.folderId}`)!.grants = { 'g:team': 'view' };
    expect(JSON.parse((await call(staff, 'GET')).body).canAdd).toBe(false);
    expect((await call(staff, 'POST', { files: [photo()] })).statusCode).toBe(403);
    // A deeper setting wins: Can edit on just this day lets the team add again.
    const day = JSON.parse((await call(artist, 'GET')).body).folderId as string;
    items.get(`ARTIST#${ARTIST}|FOLDER#${day}`)!.grants = { 'g:team': 'edit' };
    const res = await call(staff, 'POST', { files: [photo()] });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).files[0].file.name).toBe('Northcote Social Club_img_00003.jpg');
  });

  it('hides a day the artist closed to Blueprint, and keeps its files out of the list', async () => {
    const a = JSON.parse((await call(artist, 'POST', { files: [photo()] })).body);
    items.get(`ARTIST#${ARTIST}|FOLDER#${a.folderId}`)!.grants = { 'g:team': 'none' };
    const seen = JSON.parse((await call(staff, 'GET')).body);
    expect(seen.files).toHaveLength(0);
    expect(seen.canAdd).toBe(false);
    expect(JSON.parse((await call(artist, 'GET')).body).files).toHaveLength(1);
  });
});

describe('gig media upload', () => {
  it('names several files at once and continues numbering on the next upload', async () => {
    const first = await call(artist, 'POST', { files: [photo(), video(), photo('b.png')] });
    expect(first.statusCode).toBe(201);
    const a = JSON.parse(first.body);
    expect(a.folder).toBe('gigs › 2026 › 12 › 11');
    expect(a.files.map((f: { file: { name: string } }) => f.file.name)).toEqual([
      'Northcote Social Club_img_00001.jpg',
      'Northcote Social Club_video_00001.mov',
      'Northcote Social Club_img_00002.png',
    ]);
    // Each file has its own quarantine upload, as for any artist file.
    expect(a.files[0].upload.fields.key).toMatch(new RegExp(`^artists/${ARTIST}/[a-z0-9]+$`));

    const second = JSON.parse((await call(artist, 'POST', { files: [photo()] })).body);
    expect(second.files[0].file.name).toBe('Northcote Social Club_img_00003.jpg');

    const listed = JSON.parse((await call(artist, 'GET')).body);
    expect(listed.files.map((f: { name: string }) => f.name)).toEqual([
      'Northcote Social Club_img_00001.jpg',
      'Northcote Social Club_img_00002.png',
      'Northcote Social Club_img_00003.jpg',
      'Northcote Social Club_video_00001.mov',
    ]);
    expect(listed.files.every((f: { gigId: string }) => f.gigId === GIG)).toBe(true);
  });

  it('only lists files added to this gig', async () => {
    await call(artist, 'POST', { files: [photo()] });
    items.set(`ARTIST#${ARTIST}|FILE#zzzzzzzzzzzz`, {
      PK: `ARTIST#${ARTIST}`,
      SK: 'FILE#zzzzzzzzzzzz',
      fileId: 'zzzzzzzzzzzz',
      scope: 'artist',
      artistId: ARTIST,
      name: 'contract.pdf',
      size: 1,
      contentType: 'application/pdf',
      status: 'available',
      visibility: 'normal',
      uploadedBy: artist.sub,
      uploaderRole: 'artist',
      createdAt: '2026-11-01T00:00:00Z',
    });
    const listed = JSON.parse((await call(artist, 'GET')).body);
    expect(listed.files).toHaveLength(1);
  });

  it('refuses files that are not photos or videos', async () => {
    const res = await call(artist, 'POST', {
      files: [photo(), { name: 'a.pdf', size: 1, contentType: 'application/pdf' }],
    });
    expect(res.statusCode).toBe(400);
    expect([...items.keys()].some((k) => k.includes('FILE#'))).toBe(false);
  });

  it('keeps an unshared gig away from Blueprint and other artists', async () => {
    seedGig(false);
    expect((await call(staff, 'GET')).statusCode).toBe(404);
    expect((await call(staff, 'POST', { files: [photo()] })).statusCode).toBe(404);
    expect((await call(artist, 'POST', { files: [photo()] })).statusCode).toBe(201);
  });

  it('keeps another artist out of a gig', async () => {
    // Refused at the artist's workspace, before the gig is even looked up.
    expect((await call(other, 'GET')).statusCode).toBe(403);
    expect((await call(other, 'POST', { files: [photo()] })).statusCode).toBe(403);
  });

  it('says there is no such gig for an unknown one', async () => {
    expect((await call(artist, 'GET', undefined, 'nnnnnnnnnnnnnnnn')).statusCode).toBe(404);
  });
});
