import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Consultation requests (rev 21) through the handler, against an in-memory
 * table: the public form keeps details sealed and tells the team by name
 * only; the team's routes are Blueprint-only; status changes follow the
 * rules, can't race, and closing or converting starts the deletion clock on
 * everything that belongs to the request.
 */

type Item = Record<string, unknown> & { PK: string; SK: string };
const items = new Map<string, Item>();
const k = (key: { PK: string; SK: string }) => `${key.PK}|${key.SK}`;
const published: { type: string; detail: Record<string, unknown> }[] = [];
const audits: { action: string; outcome: string }[] = [];
const mails: Record<string, unknown>[] = [];

function condFails() {
  return Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
}

/** Just enough of DynamoDB's update expressions for the handler. */
function update(input: {
  Key: { PK: string; SK: string };
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const n = (s: string) => names[s] ?? s;
  const it: Record<string, unknown> = structuredClone(items.get(k(input.Key)) ?? { ...input.Key });
  if (input.ConditionExpression) {
    for (const part of input.ConditionExpression.split(' AND ')) {
      const [a, b] = part.split(' = ').map((x) => x.trim());
      if (it[n(a!)] !== values[b!]) throw condFails();
    }
  }
  const expr = input.UpdateExpression;
  const add = /^ADD (\w+) (:\w+)/.exec(expr);
  if (add) it[add[1]!] = Number(it[add[1]!] ?? 0) + Number(values[add[2]!]);
  const set = /SET (.*?)(?: REMOVE |$)/.exec(expr)?.[1];
  for (const clause of set ? set.split(/,\s*(?![^()]*\))/) : []) {
    const [lhs, rhs] = clause.split(' = ').map((x) => x.trim());
    const ine = /^if_not_exists\((\w+), (:\w+)\) \+ (:\w+)$/.exec(rhs!);
    const plus = /^([#\w]+) \+ (:\w+)$/.exec(rhs!);
    it[n(lhs!)] = ine
      ? Number(it[ine[1]!] ?? values[ine[2]!]) + Number(values[ine[3]!])
      : plus
        ? Number(it[n(plus[1]!)]) + Number(values[plus[2]!])
        : values[rhs!];
  }
  const remove = /REMOVE (.*)$/.exec(expr)?.[1];
  for (const r of remove ? remove.split(/,\s*/) : []) delete it[n(r.trim())];
  items.set(k(input.Key), it as Item);
  return { Attributes: it };
}

vi.mock('../src/lib.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib.ts')>();
  const db = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const i = cmd.input as never as {
        Key: { PK: string; SK: string };
        Item: Item;
        KeyConditionExpression: string;
        FilterExpression?: string;
        ExpressionAttributeValues: Record<string, string>;
      };
      switch (cmd.constructor.name) {
        case 'GetCommand':
          return { Item: items.has(k(i.Key)) ? structuredClone(items.get(k(i.Key))) : undefined };
        case 'PutCommand':
          items.set(k(i.Item), structuredClone(i.Item));
          return {};
        case 'DeleteCommand':
          items.delete(k(i.Key));
          return {};
        case 'UpdateCommand':
          return update(cmd.input as never);
        case 'QueryCommand': {
          const v = i.ExpressionAttributeValues;
          const out = [...items.values()]
            .filter((x) => x.PK === v[':pk'] && x.SK.startsWith(v[':p']!))
            .filter((x) => !i.FilterExpression || x.type === v[':type'])
            .sort((a, b) => a.SK.localeCompare(b.SK));
          return { Items: structuredClone(out) };
        }
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  return {
    ...real,
    db,
    env: (name: string) => (name === 'BMG_ENV' ? 'staging' : name.toLowerCase()),
    publish: async (type: string, detail: Record<string, unknown>) => {
      published.push({ type, detail });
    },
    audit: async (_e: unknown, action: string, outcome: string) => {
      audits.push({ action, outcome });
    },
    // The real one reads staff assignments from the table; enquiries don't use them.
    principalFor: async (c: import('../src/lib.ts').AuthContext) => ({
      sub: c.sub,
      role: c.role,
      ...(c.artistId ? { artistId: c.artistId } : {}),
      mfaSatisfied: c.mfaSatisfied,
      secondsSinceAuth: Math.max(0, Math.floor(Date.now() / 1000) - c.authTime),
    }),
  };
});

// Sealing: a stand-in that is obviously not plaintext, and checks it opens for the same request.
vi.mock('../src/enquiries/seal.ts', () => ({
  seal: async (id: string, part: string, value: unknown) =>
    new Uint8Array(
      Buffer.from(`SEALED|${id}|${part}|${Buffer.from(JSON.stringify(value)).toString('base64')}`),
    ),
  open: async (id: string, part: string, sealed: Uint8Array) => {
    const [tag, sid, spart, body] = Buffer.from(sealed).toString().split('|');
    if (tag !== 'SEALED' || sid !== id || spart !== part) throw new Error('wrong context');
    return JSON.parse(Buffer.from(body!, 'base64').toString());
  },
}));

vi.mock('../src/files/people.ts', () => ({
  namesFor: async (subs: string[]) =>
    new Map(
      subs
        .filter((s) => ['kyra', 'sam'].includes(s))
        .map((s) => [s, { sub: s, displayName: s === 'kyra' ? 'Kyra' : 'Sam' }]),
    ),
}));

vi.mock('@aws-sdk/client-sqs', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-sqs')>();
  class SQSClient {
    async send(cmd: { input: { MessageBody: string } }) {
      mails.push(JSON.parse(cmd.input.MessageBody));
      return {};
    }
  }
  return { ...real, SQSClient };
});

process.env.MAIL_QUEUE_URL = 'https://sqs.example/mail';
const { handler } = await import('../src/handlers/enquiries.ts');

const ctx = (sub: string, role: string, authTime = Math.floor(Date.now() / 1000)) => ({
  sub,
  role,
  sessionId: 's1',
  mfaLevel: 'cognito',
  mfaSatisfied: 'true',
  authTime: String(authTime),
  ...(role === 'artist' ? { artistId: 'art_abcdefghij' } : {}),
});

function event(
  method: string,
  path: string,
  body?: unknown,
  who?: ReturnType<typeof ctx>,
  ip = '203.0.113.9',
): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
    headers: { 'CloudFront-Viewer-Address': `${ip}:443` },
    queryStringParameters: null,
    requestContext: { requestId: 'r', ...(who ? { authorizer: who } : {}) },
  } as never;
}

const call = async (e: APIGatewayProxyEvent) => {
  const r = await handler(e);
  return { status: r!.statusCode, body: JSON.parse(r!.body) as Record<string, unknown> };
};

const form = {
  name: 'Mia Torres',
  email: 'mia@example.com',
  country: 'AU',
  phone: '+61412345678',
  aboutMe: 'Singer-songwriter in Brunswick.',
  howCanWeHelp: 'Planning my first EP.',
  elapsedMs: 40_000,
};
const kyra = ctx('kyra', 'bmg-admin');
const sam = ctx('sam', 'bmg-staff');

const send = async (body: Record<string, unknown> = form, ip?: string) =>
  call(event('POST', '/public/enquiries', body, undefined, ip));
const onlyId = () => {
  const e = [...items.values()].find((x) => x.type === 'enquiry');
  return e!.enquiryId as string;
};
const actOn = (id: string, body: unknown, who = sam) =>
  call(event('POST', `/enquiries/${id}/actions`, body, who));

beforeEach(() => {
  items.clear();
  published.length = 0;
  audits.length = 0;
  mails.length = 0;
  items.set('ARTIST#art_abcdefghij|PROFILE', {
    PK: 'ARTIST#art_abcdefghij',
    SK: 'PROFILE',
    displayName: 'Mia Torres',
  });
});

describe('the public form', () => {
  it('keeps the request sealed, tells the team by name only, and thanks the person', async () => {
    expect(await send()).toEqual({ status: 200, body: { ok: true, firstName: 'Mia' } });
    const e = [...items.values()].find((x) => x.type === 'enquiry')!;
    expect(e).toMatchObject({ status: 'open', country: 'AU', version: 1 });
    // Nothing that identifies the person sits in the clear.
    const clear = JSON.stringify({ ...e, sealed: undefined });
    for (const word of ['Mia', 'mia@example.com', '412345678', 'Brunswick', 'EP'])
      expect(clear).not.toContain(word);
    expect(published).toEqual([
      {
        type: 'enquiry.received',
        detail: { enquiryId: e.enquiryId, name: 'Mia Torres', countryName: 'Australia' },
      },
    ]);
    expect(JSON.stringify(published)).not.toContain('Brunswick');
    expect(mails).toEqual([{ to: 'mia@example.com', enquiryAck: { firstName: 'Mia' } }]);
  });

  it('answers bots as if it worked, and keeps nothing', async () => {
    expect((await send({ ...form, website: 'spam.example' })).status).toBe(200);
    expect((await send({ ...form, elapsedMs: 800 })).status).toBe(200);
    expect([...items.values()].filter((x) => x.type === 'enquiry')).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('refuses a country that isn’t one', async () => {
    expect(await send({ ...form, country: 'ZZ' })).toMatchObject({ status: 400 });
  });

  it('limits sends from one network', async () => {
    for (let i = 0; i < 5; i++)
      expect((await send({ ...form, email: `p${i}@example.com` }, '198.51.100.7')).status).toBe(
        200,
      );
    expect((await send({ ...form, email: 'p6@example.com' }, '198.51.100.7')).status).toBe(429);
  });

  it('adds a second send from the same address to the first request', async () => {
    await send();
    await send({ ...form, email: 'MIA@example.com', howCanWeHelp: 'Also a tour.' });
    const enquiries = [...items.values()].filter((x) => x.type === 'enquiry');
    expect(enquiries).toHaveLength(1);
    expect(enquiries[0]).toMatchObject({ resends: 1 });
    expect(published.map((p) => p.type)).toEqual(['enquiry.received']);
    const d = await call(event('GET', `/enquiries/${onlyId()}`, undefined, sam));
    const notes = d.body.notes as { byName: string; text: string }[];
    expect(notes[0]).toMatchObject({ byName: 'Mia Torres' });
    expect(notes[0]!.text).toContain('Also a tour.');
  });

  it('tells only test accounts about a test address, and sends it no email', async () => {
    await send({ ...form, email: 'qa+bmg-e2e-admin@example.com' });
    expect(published[0]!.detail).toMatchObject({ test: true });
    expect(mails).toHaveLength(0);
  });
});

describe('the team’s routes', () => {
  it('are Blueprint only', async () => {
    await send();
    const artist = ctx('a1', 'artist');
    expect((await call(event('GET', '/enquiries', undefined, artist))).status).toBe(403);
    expect((await call(event('GET', `/enquiries/${onlyId()}`, undefined, artist))).status).toBe(
      403,
    );
    expect(audits).toContainEqual({ action: 'enquiry.read', outcome: 'denied' });
  });

  it('list every request with its details opened, and count without opening', async () => {
    await send();
    const list = await call(event('GET', '/enquiries', undefined, sam));
    expect(list.body.enquiries).toEqual([
      expect.objectContaining({ name: 'Mia Torres', email: 'mia@example.com', status: 'open' }),
    ]);
    const summary = await call({
      ...event('GET', '/enquiries', undefined, sam),
      queryStringParameters: { summary: '1' },
    });
    expect(summary.body).toMatchObject({ open: 1, inProgress: 0, mine: 0 });
    expect(JSON.stringify(summary.body)).not.toContain('Mia');
  });

  it('picks up, says who was first, and converts only to a real artist', async () => {
    await send();
    const id = onlyId();
    const mine = await actOn(id, { kind: 'pick-up' });
    expect(mine.body).toMatchObject({ status: 'in-progress', ownerSub: 'sam', ownerName: 'Sam' });
    expect(published.at(-1)).toMatchObject({
      type: 'enquiry.pickedUp',
      detail: { enquiryId: id, bySub: 'sam', byName: 'Sam', name: 'Mia Torres' },
    });
    expect(await actOn(id, { kind: 'pick-up' }, kyra)).toEqual({
      status: 409,
      body: expect.objectContaining({ detail: 'Sam picked this up a moment ago.' }),
    });
    expect((await actOn(id, { kind: 'convert', artistId: 'art_zzzzzzzzzz' })).body.detail).toMatch(
      /isn’t in the app/,
    );
    const done = await actOn(id, { kind: 'convert', artistId: 'art_abcdefghij' });
    expect(done.body).toMatchObject({ status: 'converted', artistId: 'art_abcdefghij' });
    // Converted: the request and everything with it now expire together.
    const ttls = [...items.values()].filter((x) => x.SK.startsWith(`ENQ#${id}`)).map((x) => x.ttl);
    expect(new Set(ttls).size).toBe(1);
    expect(ttls[0]).toBeGreaterThan(Date.now() / 1000 + 700 * 24 * 3600);
  });

  it('a change made from a stale copy is read again rather than lost', async () => {
    await send();
    const id = onlyId();
    // Someone else's change bumps the version between the read and the write.
    const key = `ORG#enquiries|ENQ#${id}`;
    const was = items.get(key)!;
    items.set(key, { ...was, version: 7 });
    expect((await actOn(id, { kind: 'pick-up' })).body).toMatchObject({ status: 'in-progress' });
  });

  it('take over tells the person who had it; reopen clears the clock', async () => {
    await send();
    const id = onlyId();
    await actOn(id, { kind: 'pick-up' });
    expect((await actOn(id, { kind: 'take-over' }, sam)).status).toBe(403);
    await actOn(id, { kind: 'take-over' }, kyra);
    expect(published.at(-1)).toMatchObject({
      type: 'enquiry.takenOver',
      detail: { fromSub: 'sam', bySub: 'kyra' },
    });
    await actOn(id, { kind: 'close', reason: 'no-reply' }, kyra);
    expect(items.get(`ORG#enquiries|ENQ#${id}`)!.ttl).toBeGreaterThan(0);
    const back = await actOn(id, { kind: 'reopen' }, sam);
    expect(back.body).toMatchObject({ status: 'in-progress', ownerSub: 'sam' });
    expect(
      [...items.values()].filter((x) => x.SK.startsWith(`ENQ#${id}`) && x.ttl !== undefined),
    ).toHaveLength(0);
    const kinds = (back.body.activity as { kind: string }[]).map((a) => a.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['received', 'pickedUp', 'takenOver', 'closed', 'reopened']),
    );
  });

  it('keeps notes sealed and shows them with who wrote them', async () => {
    await send();
    const id = onlyId();
    const r = await call(
      event('POST', `/enquiries/${id}/notes`, { text: 'Booked a call Thursday.' }, kyra),
    );
    expect(r.status).toBe(201);
    expect((r.body.notes as unknown[])[0]).toMatchObject({
      byName: 'Kyra',
      text: 'Booked a call Thursday.',
    });
    const stored = [...items.values()].find((x) => x.type === 'enquiryNote')!;
    expect(JSON.stringify({ ...stored, sealed: undefined })).not.toContain('Thursday');
  });

  it('edits contact details, never the answers', async () => {
    await send();
    const id = onlyId();
    const r = await call(
      event('PATCH', `/enquiries/${id}`, { name: 'Mia T', phone: null, aboutMe: 'x' }, sam),
    );
    expect(r.body).toMatchObject({ name: 'Mia T', aboutMe: 'Singer-songwriter in Brunswick.' });
    expect(r.body).not.toHaveProperty('phone');
  });

  it('lets only an admin with a fresh sign-in delete, and deletes everything with it', async () => {
    await send();
    const id = onlyId();
    await call(event('POST', `/enquiries/${id}/notes`, { text: 'n' }, kyra));
    expect((await call(event('DELETE', `/enquiries/${id}`, undefined, sam))).status).toBe(403);
    const stale = ctx('kyra', 'bmg-admin', Math.floor(Date.now() / 1000) - 3600);
    expect((await call(event('DELETE', `/enquiries/${id}`, undefined, stale))).body.detail).toMatch(
      /fresh step-up/,
    );
    expect((await call(event('DELETE', `/enquiries/${id}`, undefined, kyra))).status).toBe(200);
    expect([...items.keys()].filter((x) => x.includes(`ENQ#${id}`))).toHaveLength(0);
  });
});
