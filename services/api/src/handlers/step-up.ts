import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Secret, TOTP } from 'otpauth';
import { z } from 'zod';
import { audit, authContext, db, env, handle, HttpError, json, parseBody } from '../lib.ts';
import {
  afterFailure,
  federatedEnrolAllowed,
  freshStep,
  MAX_STEP_UP_FAILURES,
  STEP_UP_LIFETIME_SECONDS,
  totpLocked,
  totpStep,
  type TotpRecord,
} from '../session.ts';

const kms = new KMSClient({});
const cognito = new CognitoIdentityProviderClient({});

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

/** The Cognito status of the person's own account (social sign-ins are linked to it). */
async function nativeUserStatus(sub: string): Promise<string | undefined> {
  const res = await cognito.send(
    new ListUsersCommand({
      UserPoolId: env('USER_POOL_ID'),
      Filter: `sub = "${sub.replace(/["\\]/g, '')}"`,
      Limit: 1,
    }),
  );
  return res.Users?.[0]?.UserStatus;
}

export const ENROL_FROM_OWN_SIGN_IN =
  'Your account has its own sign-in, so add the authenticator from there: sign in with your email and password (or passkey), then use your social account.';

/**
 * The app's own authenticator (design 6.2), because Cognito applies no MFA to
 * Google, Apple or Facebook users.
 *   POST /step-up/totp/setup  → otpauth:// URI (only until one is confirmed)
 *   POST /step-up/totp/verify → confirms it; on a social sign-in, also marks
 *                               this session verified
 *
 * Security review M2: a social sign-in may only add the first authenticator
 * for an account that has never signed in another way; everyone else adds it
 * from a password or passkey sign-in (Cognito MFA already passed). Wrong codes
 * are counted per person, not only per session, and each code works once.
 */
export const handler = handle(async (event) => {
  const ctx = authContext(event);
  const federated = ctx.mfaLevel === 'federated';
  const userKey = { PK: `USER#${ctx.sub}`, SK: 'TOTP' };
  const sessionKey = { PK: `SESSION#${ctx.sessionId}` };
  const now = Math.floor(Date.now() / 1000);

  if (event.path.endsWith('/setup')) {
    const existing = await db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: userKey }));
    if (existing.Item?.confirmed) {
      throw new HttpError(409, 'An authenticator is already set up; verify with it instead');
    }
    if (federated && !federatedEnrolAllowed(await nativeUserStatus(ctx.sub))) {
      await audit(event, 'auth.stepUpSetup', 'denied', { reason: 'own-sign-in' });
      throw new HttpError(403, ENROL_FROM_OWN_SIGN_IN);
    }
    const secret = new Secret({ size: 20 }).base32;
    await db.send(
      new PutCommand({
        TableName: env('MAIN_TABLE'),
        Item: { ...userKey, sealedSecret: await sealSecret(ctx.sub, secret), confirmed: false },
      }),
    );
    await audit(event, 'auth.stepUpSetup', 'success', { from: ctx.mfaLevel });
    return json(200, { otpauthUri: totpFor(secret).toString() });
  }

  const { code } = parseBody(event, VerifyBody);
  if (federated) {
    const session = await db.send(
      new GetCommand({ TableName: env('SESSIONS_TABLE'), Key: sessionKey }),
    );
    if ((session.Item?.failures ?? 0) >= MAX_STEP_UP_FAILURES) {
      await audit(event, 'auth.stepUp', 'denied', { reason: 'locked' });
      throw new HttpError(429, 'Too many attempts. Sign out and sign in again.');
    }
  }
  const stored = (await db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: userKey })))
    .Item as TotpRecord | undefined;
  if (!stored?.sealedSecret) throw new HttpError(404, 'Set up an authenticator first');
  if (totpLocked(stored, now)) {
    await audit(event, 'auth.stepUp', 'denied', { reason: 'locked-person' });
    throw new HttpError(429, 'Too many wrong codes. Try again in an hour.');
  }

  const secret = await openSecret(ctx.sub, stored.sealedSecret);
  const delta = totpFor(secret).validate({ token: code, window: 1 });
  const step = delta === null ? undefined : totpStep(now, delta);
  if (step === undefined || !freshStep(stored.lastStep, step)) {
    const next = afterFailure(stored, now);
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: userKey,
        UpdateExpression: 'SET failures = :f, failWindowStart = :w',
        ExpressionAttributeValues: { ':f': next.failures, ':w': next.failWindowStart },
      }),
    );
    if (federated) {
      await db.send(
        new UpdateCommand({
          TableName: env('SESSIONS_TABLE'),
          Key: sessionKey,
          UpdateExpression: 'ADD failures :one SET expiresAt = if_not_exists(expiresAt, :exp)',
          ExpressionAttributeValues: { ':one': 1, ':exp': now + STEP_UP_LIFETIME_SECONDS },
        }),
      );
    }
    await audit(event, 'auth.stepUp', 'failed', {
      reason: step === undefined ? 'wrong' : 'reused',
    });
    throw new HttpError(403, 'That code is not valid');
  }

  // Use the code up (and confirm the authenticator) in one write; a code sent
  // twice at once only wins once.
  try {
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: userKey,
        UpdateExpression: 'SET lastStep = :s, confirmed = :t REMOVE failures, failWindowStart',
        ConditionExpression: 'attribute_not_exists(lastStep) OR lastStep < :s',
        ExpressionAttributeValues: { ':s': step, ':t': true },
      }),
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      await audit(event, 'auth.stepUp', 'failed', { reason: 'reused' });
      throw new HttpError(403, 'That code is not valid');
    }
    throw err;
  }
  if (!stored.confirmed)
    await audit(event, 'auth.stepUpEnrolled', 'success', { from: ctx.mfaLevel });

  // A password or passkey sign-in already passed Cognito MFA: nothing to mark.
  if (!federated) return json(200, { verified: true, enrolled: true });

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
