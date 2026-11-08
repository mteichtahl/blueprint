import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Secret, TOTP } from 'otpauth';
import { z } from 'zod';
import { audit, authContext, db, env, handle, HttpError, json, parseBody } from '../lib.ts';
import { MAX_STEP_UP_FAILURES, STEP_UP_LIFETIME_SECONDS } from '../session.ts';

const kms = new KMSClient({});

function totpFor(secretBase32: string): TOTP {
  return new TOTP({
    issuer: 'Blueprint Music Group',
    label: 'BMG',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** The TOTP secret is encrypted with the platform key, bound to the user (design 6.2 step 3). */
async function sealSecret(sub: string, secret: string): Promise<string> {
  const res = await kms.send(
    new EncryptCommand({
      KeyId: env('PLATFORM_KEY_ARN'),
      Plaintext: Buffer.from(secret),
      EncryptionContext: { purpose: 'totp', sub },
    }),
  );
  return Buffer.from(res.CiphertextBlob!).toString('base64');
}

async function openSecret(sub: string, sealed: string): Promise<string> {
  const res = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(sealed, 'base64'),
      EncryptionContext: { purpose: 'totp', sub },
    }),
  );
  return Buffer.from(res.Plaintext!).toString();
}

const VerifyBody = z.object({ code: z.string().regex(/^\d{6}$/, 'code must be 6 digits') });

/**
 * App-level step-up for social sign-ins (design 6.2), because Cognito applies
 * no MFA to Google, Apple or Facebook users.
 *   POST /step-up/totp/setup  → otpauth:// URI (only until a TOTP is confirmed)
 *   POST /step-up/totp/verify → marks this sign-in session verified
 */
export const handler = handle(async (event) => {
  const ctx = authContext(event);
  if (ctx.mfaLevel !== 'federated') {
    throw new HttpError(409, 'This sign-in already uses Cognito two-step verification');
  }
  const userKey = { PK: `USER#${ctx.sub}`, SK: 'TOTP' };
  const sessionKey = { PK: `SESSION#${ctx.sessionId}` };
  const now = Math.floor(Date.now() / 1000);

  if (event.path.endsWith('/setup')) {
    const existing = await db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: userKey }));
    if (existing.Item?.confirmed) {
      throw new HttpError(409, 'An authenticator is already set up; verify with it instead');
    }
    const secret = new Secret({ size: 20 }).base32;
    await db.send(
      new PutCommand({
        TableName: env('MAIN_TABLE'),
        Item: { ...userKey, sealedSecret: await sealSecret(ctx.sub, secret), confirmed: false },
      }),
    );
    await audit(event, 'auth.stepUpSetup', 'success');
    return json(200, { otpauthUri: totpFor(secret).toString() });
  }

  const { code } = parseBody(event, VerifyBody);
  const session = await db.send(
    new GetCommand({ TableName: env('SESSIONS_TABLE'), Key: sessionKey }),
  );
  if ((session.Item?.failures ?? 0) >= MAX_STEP_UP_FAILURES) {
    await audit(event, 'auth.stepUp', 'denied', { reason: 'locked' });
    throw new HttpError(429, 'Too many attempts. Sign out and sign in again.');
  }
  const stored = await db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: userKey }));
  if (!stored.Item?.sealedSecret) throw new HttpError(404, 'Set up an authenticator first');

  const secret = await openSecret(ctx.sub, stored.Item.sealedSecret as string);
  const ok = totpFor(secret).validate({ token: code, window: 1 }) !== null;
  if (!ok) {
    await db.send(
      new UpdateCommand({
        TableName: env('SESSIONS_TABLE'),
        Key: sessionKey,
        UpdateExpression: 'ADD failures :one SET expiresAt = if_not_exists(expiresAt, :exp)',
        ExpressionAttributeValues: { ':one': 1, ':exp': now + STEP_UP_LIFETIME_SECONDS },
      }),
    );
    await audit(event, 'auth.stepUp', 'failed');
    throw new HttpError(403, 'That code is not valid');
  }

  if (!stored.Item.confirmed) {
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: userKey,
        UpdateExpression: 'SET confirmed = :t',
        ExpressionAttributeValues: { ':t': true },
      }),
    );
  }
  await db.send(
    new PutCommand({
      TableName: env('SESSIONS_TABLE'),
      Item: {
        ...sessionKey,
        sub: ctx.sub,
        verified: true,
        verifiedAt: now,
        expiresAt: now + STEP_UP_LIFETIME_SECONDS,
        failures: 0,
      },
    }),
  );
  await audit(event, 'auth.stepUp', 'success');
  return json(200, { verified: true, expiresAt: now + STEP_UP_LIFETIME_SECONDS });
});
