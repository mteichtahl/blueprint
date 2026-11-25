import { Secret, TOTP } from 'otpauth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  afterFailure,
  federatedEnrolAllowed,
  freshStep,
  totpLocked,
  totpStep,
} from '../src/session.ts';

/**
 * The app authenticator (design 6.2) after security review M2: a social
 * sign-in can't enrol one for an account with its own sign-in, wrong codes are
 * counted per person, and each code works once.
 */

const now = 1_800_000_000;

describe('authenticator rules', () => {
  it('lets a social sign-in enrol only an account that never signed in another way', () => {
    expect(federatedEnrolAllowed('FORCE_CHANGE_PASSWORD')).toBe(true);
    expect(federatedEnrolAllowed('CONFIRMED')).toBe(false);
    expect(federatedEnrolAllowed('RESET_REQUIRED')).toBe(false);
    expect(federatedEnrolAllowed(undefined)).toBe(false);
  });

  it('locks a person after 5 wrong codes in an hour, whatever the session', () => {
    let rec = afterFailure(undefined, now);
    for (let i = 0; i < 4; i++) rec = afterFailure(rec, now + i);
    expect(rec.failures).toBe(5);
    expect(totpLocked(rec, now + 10)).toBe(true);
    expect(totpLocked(rec, now + 3600)).toBe(false);
    expect(afterFailure(rec, now + 3600)).toEqual({ failures: 1, failWindowStart: now + 3600 });
  });

  it('accepts each time step once', () => {
    const step = totpStep(now, 0);
    expect(totpStep(now, -1)).toBe(step - 1);
    expect(freshStep(undefined, step)).toBe(true);
    expect(freshStep(step, step)).toBe(false);
    expect(freshStep(step, step - 1)).toBe(false);
    expect(freshStep(step - 1, step)).toBe(true);
  });
});

// ── The handler, with DynamoDB, KMS and Cognito faked ──────────────────────

const items = new Map<string, Record<string, unknown>>();
const key = (k: { PK: string; SK?: string }) => `${k.PK}|${k.SK ?? ''}`;
const audits: { action: string; outcome: string; fields: Record<string, unknown> }[] = [];
let nativeStatus = 'CONFIRMED';

vi.mock('../src/lib.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib.ts')>();
  const db = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const i = cmd.input as {
        Key: { PK: string; SK?: string };
        Item: Record<string, unknown> & { PK: string; SK?: string };
        UpdateExpression: string;
        ConditionExpression?: string;
        ExpressionAttributeValues: Record<string, unknown>;
      };
      switch (cmd.constructor.name) {
        case 'GetCommand':
          return { Item: structuredClone(items.get(key(i.Key))) };
        case 'PutCommand':
          items.set(key(i.Item), structuredClone(i.Item));
          return {};
        case 'UpdateCommand': {
          const it = items.get(key(i.Key)) ?? { ...i.Key };
          const v = i.ExpressionAttributeValues;
          const e = i.UpdateExpression;
          if (e.startsWith('SET failures')) {
            it.failures = v[':f'];
            it.failWindowStart = v[':w'];
          } else if (e.startsWith('ADD failures')) {
            it.failures = Number(it.failures ?? 0) + 1;
          } else if (e.startsWith('SET lastStep')) {
            if (it.lastStep !== undefined && Number(it.lastStep) >= Number(v[':s'])) {
              throw Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
            }
            it.lastStep = v[':s'];
            it.confirmed = true;
            delete it.failures;
            delete it.failWindowStart;
          }
          items.set(key(i.Key), it);
          return {};
        }
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  return {
    ...real,
    db,
    env: (n: string) => n.toLowerCase(),
    audit: async (
      _e: unknown,
      action: string,
      outcome: string,
      fields: Record<string, unknown> = {},
    ) => {
      audits.push({ action, outcome, fields });
    },
  };
});

vi.mock('@aws-sdk/client-kms', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-kms')>();
  class KMSClient {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      if (cmd.constructor.name === 'EncryptCommand') return { CiphertextBlob: cmd.input.Plaintext };
      return { Plaintext: cmd.input.CiphertextBlob };
    }
  }
  return { ...real, KMSClient };
});

vi.mock('@aws-sdk/client-cognito-identity-provider', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-cognito-identity-provider')>();
  class CognitoIdentityProviderClient {
    async send() {
      return { Users: [{ Username: 'u', UserStatus: nativeStatus }] };
    }
  }
  return { ...real, CognitoIdentityProviderClient };
});

const { handler } = await import('../src/handlers/step-up.ts');

const SUB = '11111111-2222-3333-4444-555555555555';
function call(path: 'setup' | 'verify', mfaLevel: 'federated' | 'cognito', body = {}) {
  return handler({
    path: `/step-up/totp/${path}`,
    body: JSON.stringify(body),
    requestContext: {
      requestId: 'r',
      authorizer: {
        sub: SUB,
        role: 'artist',
        artistId: 'art_abcdefghij',
        mfaLevel,
        mfaSatisfied: String(mfaLevel === 'cognito'),
        authTime: String(now),
        sessionId: `sess-${mfaLevel}`,
      },
    },
  } as never);
}
const status = async (p: ReturnType<typeof call>) => (await p).statusCode;
const codeFor = (uri: string, at = Date.now()) =>
  new TOTP({ secret: Secret.fromBase32(new URL(uri).searchParams.get('secret')!) }).generate({
    timestamp: at,
  });

describe('step-up handler', () => {
  beforeEach(() => {
    items.clear();
    audits.length = 0;
    nativeStatus = 'CONFIRMED';
  });

  it('refuses enrolment from a social sign-in when the account has its own sign-in', async () => {
    expect(await status(call('setup', 'federated'))).toBe(403);
    expect(items.size).toBe(0);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'auth.stepUpSetup', outcome: 'denied' }),
    );
  });

  it('lets a social-only invited artist enrol and verify', async () => {
    nativeStatus = 'FORCE_CHANGE_PASSWORD';
    const setup = await call('setup', 'federated');
    expect(setup.statusCode).toBe(200);
    const { otpauthUri } = JSON.parse(setup.body);
    expect(await status(call('verify', 'federated', { code: codeFor(otpauthUri) }))).toBe(200);
    expect(items.get(`SESSION#sess-federated|`)?.verified).toBe(true);
  });

  it('lets a password sign-in enrol, then a social sign-in verify with it', async () => {
    const setup = await call('setup', 'cognito');
    expect(setup.statusCode).toBe(200);
    const { otpauthUri } = JSON.parse(setup.body);
    const res = await call('verify', 'cognito', { code: codeFor(otpauthUri) });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ verified: true, enrolled: true });
    expect(items.get(`USER#${SUB}|TOTP`)?.confirmed).toBe(true);
    // Already confirmed: no second setup, from anywhere.
    expect(await status(call('setup', 'cognito'))).toBe(409);
    // The social sign-in verifies with a newer code.
    const later = codeFor(otpauthUri, Date.now() + 30_000);
    expect(await status(call('verify', 'federated', { code: later }))).toBe(200);
  });

  it('refuses a code that was already used', async () => {
    nativeStatus = 'FORCE_CHANGE_PASSWORD';
    const { otpauthUri } = JSON.parse((await call('setup', 'federated')).body);
    const code = codeFor(otpauthUri);
    expect(await status(call('verify', 'federated', { code }))).toBe(200);
    expect(await status(call('verify', 'federated', { code }))).toBe(403);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'auth.stepUp', fields: { reason: 'reused' } }),
    );
  });

  it('locks the person, not just the session, after 5 wrong codes', async () => {
    nativeStatus = 'FORCE_CHANGE_PASSWORD';
    const { otpauthUri } = JSON.parse((await call('setup', 'federated')).body);
    const right = codeFor(otpauthUri);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      // A fresh sign-in session each time: the old per-session limit reset here.
      items.delete('SESSION#sess-federated|');
      expect(await status(call('verify', 'federated', { code: wrong }))).toBe(403);
    }
    items.delete('SESSION#sess-federated|');
    expect(await status(call('verify', 'federated', { code: right }))).toBe(429);
  });
});
