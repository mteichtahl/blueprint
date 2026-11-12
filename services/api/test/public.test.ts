import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The public endpoints: newsletter sign-up and recovery codes (no sign-in). */

const items = new Map<string, Record<string, unknown>>();
const k = (key: { PK: string; SK: string }) => `${key.PK}|${key.SK}`;
const published: { type: string; detail: Record<string, unknown> }[] = [];
const cognitoCalls: { name: string; input: Record<string, unknown> }[] = [];
let users: Record<string, unknown>[] = [];
let mailchimpUp = true;
const added: string[] = [];

vi.mock('../src/lib.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib.ts')>();
  const db = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const i = cmd.input as {
        Key: { PK: string; SK: string };
        Item: Record<string, unknown> & { PK: string; SK: string };
        UpdateExpression: string;
        ConditionExpression?: string;
        ExpressionAttributeValues: Record<string, unknown>;
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
        case 'UpdateCommand': {
          const it = items.get(k(i.Key)) ?? { ...i.Key };
          const v = i.ExpressionAttributeValues;
          const e = i.UpdateExpression;
          if (e.startsWith('ADD n')) {
            it.n = Number(it.n ?? 0) + 1;
          } else if (e.includes('codes[')) {
            const idx = Number(/codes\[(\d+)\]/.exec(e)![1]);
            const codes = it.codes as (string | null)[];
            if (codes[idx] !== v[':was'])
              throw Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
            codes[idx] = null;
            it.usedAt = v[':at'];
            delete it.failures;
            delete it.failWindowStart;
          } else if (e.includes('failures = failures')) {
            it.failures = Number(it.failures) + 1;
          } else if (e.includes('failures = :one')) {
            it.failures = 1;
            it.failWindowStart = v[':now'];
          }
          items.set(k(i.Key), it);
          return { Attributes: { n: it.n } };
        }
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  return {
    ...real,
    db,
    env: (n: string) => n.toLowerCase(),
    publish: async (type: string, detail: Record<string, unknown>) => {
      published.push({ type, detail });
    },
  };
});

vi.mock('@aws-sdk/client-cognito-identity-provider', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-cognito-identity-provider')>();
  class CognitoIdentityProviderClient {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      cognitoCalls.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'ListUsersCommand') return { Users: users };
      return {};
    }
  }
  return { ...real, CognitoIdentityProviderClient };
});

vi.mock('../src/connectors/mailchimp.ts', () => ({
  mailchimp: async () => {
    if (!mailchimpUp) throw new Error('Connect Mailchimp in Connectors first');
    return { apiHost: 'h', token: 't', listId: 'L' };
  },
  addSubscriber: async (_: unknown, p: { email: string }) => {
    added.push(p.email);
    return 'pending';
  },
}));

const { handler } = await import('../src/handlers/public.ts');
const { hashCode, RECOVERY_SK } = await import('../src/recovery.ts');
const { NEWSLETTER_PK, signupSk } = await import('../src/newsletter.ts');

const post = async (path: string, body: unknown, ip = '203.0.113.9') => {
  const r = await handler({
    rawPath: path,
    body: JSON.stringify(body),
    headers: { 'cloudfront-viewer-address': `${ip}:443` },
    requestContext: { http: { method: 'POST' } },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
};

beforeEach(() => {
  items.clear();
  published.length = 0;
  cognitoCalls.length = 0;
  added.length = 0;
  users = [];
  mailchimpUp = true;
});

describe('newsletter sign-up', () => {
  it('adds the address to Mailchimp as pending and keeps a record', async () => {
    const r = await post('/public/newsletter', {
      email: 'Jo@Example.com',
      firstName: 'Jo',
      consent: true,
    });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(added).toEqual(['jo@example.com']);
    expect(items.get(`${NEWSLETTER_PK}|${signupSk('jo@example.com')}`)).toMatchObject({
      status: 'added',
      mailchimpStatus: 'pending',
      firstName: 'Jo',
    });
  });

  it('keeps them for the hourly sync while Mailchimp isn’t connected', async () => {
    mailchimpUp = false;
    expect((await post('/public/newsletter', { email: 'a@b.co', consent: true })).status).toBe(200);
    expect(items.get(`${NEWSLETTER_PK}|${signupSk('a@b.co')}`)).toMatchObject({
      status: 'waiting',
    });
  });

  it('needs the tick, refuses bots, and doesn’t email the same address twice in a row', async () => {
    expect((await post('/public/newsletter', { email: 'a@b.co', consent: false })).status).toBe(
      400,
    );
    expect(
      (await post('/public/newsletter', { email: 'a@b.co', consent: true, website: 'x' })).status,
    ).toBe(400);
    await post('/public/newsletter', { email: 'a@b.co', consent: true });
    await post('/public/newsletter', { email: 'A@b.co', consent: true });
    expect(added).toEqual(['a@b.co']);
  });

  it('limits how many sign-ups come from one network in an hour', async () => {
    for (let i = 0; i < 10; i++) {
      expect(
        (await post('/public/newsletter', { email: `p${i}@b.co`, consent: true })).status,
      ).toBe(200);
    }
    expect((await post('/public/newsletter', { email: 'p11@b.co', consent: true })).status).toBe(
      429,
    );
    expect(
      (await post('/public/newsletter', { email: 'p12@b.co', consent: true }, '198.51.100.1'))
        .status,
    ).toBe(200);
  });
});

describe('recovery codes', () => {
  const SUB = '11111111-1111-1111-1111-111111111111';
  const seed = () => {
    users = [
      {
        Username: 'kyra-username',
        Enabled: true,
        UserStatus: 'CONFIRMED',
        Attributes: [{ Name: 'sub', Value: SUB }],
      },
    ];
    items.set(`USER#${SUB}|${RECOVERY_SK}`, {
      PK: `USER#${SUB}`,
      SK: RECOVERY_SK,
      codes: [hashCode('ABCDE-FGHJK'), hashCode('MNPQR-STUVW')],
      createdAt: '2026-11-01T00:00:00Z',
    });
    items.set(`USER#${SUB}|TOTP`, { PK: `USER#${SUB}`, SK: 'TOTP', sealed: 'x' });
  };

  it('a right code turns the authenticator off, is used up, and tells the person', async () => {
    seed();
    const r = await post('/public/recovery', { email: 'kyra@example.com', code: 'abcde fghjk' });
    expect(r.status).toBe(200);
    const mfa = cognitoCalls.find((c) => c.name === 'AdminSetUserMFAPreferenceCommand')!;
    expect(mfa.input).toMatchObject({
      Username: 'kyra-username',
      SoftwareTokenMfaSettings: { Enabled: false },
    });
    expect(items.has(`USER#${SUB}|TOTP`)).toBe(false);
    expect(published).toEqual([{ type: 'account.recovered', detail: { sub: SUB, left: 1 } }]);
    // The same code doesn't work twice.
    expect(
      (await post('/public/recovery', { email: 'kyra@example.com', code: 'ABCDE-FGHJK' })).status,
    ).toBe(400);
  });

  it('answers the same for a wrong code, an unknown email and a locked account', async () => {
    seed();
    const wrong = await post('/public/recovery', {
      email: 'kyra@example.com',
      code: 'ABCDE-FGHJX',
    });
    users = [];
    const unknown = await post('/public/recovery', {
      email: 'no@example.com',
      code: 'ABCDE-FGHJK',
    });
    expect(wrong).toEqual(unknown);
    expect(wrong.status).toBe(400);
    seed();
    for (let i = 0; i < 5; i++) {
      await post('/public/recovery', { email: 'kyra@example.com', code: 'ABCDE-FGHJX' });
    }
    // Locked: even the right code is refused for the hour.
    const locked = await post('/public/recovery', {
      email: 'kyra@example.com',
      code: 'ABCDE-FGHJK',
    });
    expect(locked).toEqual(wrong);
    expect(cognitoCalls.some((c) => c.name === 'AdminSetUserMFAPreferenceCommand')).toBe(false);
  });

  it('is only for accounts with their own password', async () => {
    seed();
    users = [{ ...users[0]!, UserStatus: 'EXTERNAL_PROVIDER' }];
    expect(
      (await post('/public/recovery', { email: 'kyra@example.com', code: 'ABCDE-FGHJK' })).status,
    ).toBe(400);
  });
});

describe('anything else', () => {
  it('is not found', async () => {
    const r = await handler({
      rawPath: '/public/other',
      requestContext: { http: { method: 'GET' } },
    });
    expect(r.statusCode).toBe(404);
  });
});
