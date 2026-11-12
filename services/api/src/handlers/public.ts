import { createHash } from 'node:crypto';
import {
  AdminSetUserMFAPreferenceCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { addSubscriber, mailchimp } from '../connectors/mailchimp.ts';
import { db, env, publish } from '../lib.ts';
import {
  NEWSLETTER_PK,
  SIGNUP_AGAIN_AFTER_SECONDS,
  SIGNUPS_PER_IP_PER_HOUR,
  SignupBody,
  signupSk,
  type Signup,
} from '../newsletter.ts';
import {
  locked,
  matchCode,
  RECOVERY_REFUSED,
  RECOVERY_SK,
  RecoveryBody,
  type RecoveryRecord,
} from '../recovery.ts';

/**
 * The app's public endpoints, served on the app's own origin under
 * /public/* (CloudFront → this function's URL, signed with origin access
 * control, so nothing else can call it):
 *
 *   POST /public/newsletter  the newsletter sign-up page
 *   POST /public/recovery    a recovery code instead of the authenticator
 *
 * No sign-in, so every answer is the same whether or not an account or
 * address exists, and both are rate limited.
 */

const cognito = new CognitoIdentityProviderClient({});
const table = () => env('MAIN_TABLE');

interface UrlEvent {
  rawPath: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext: { http: { method: string; sourceIp?: string } };
}
interface UrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const reply = (statusCode: number, body: unknown): UrlResult => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});
const problem = (status: number, detail: string) => reply(status, { title: detail, detail });

function parse<T extends z.ZodType>(e: UrlEvent, schema: T): z.infer<T> | string {
  let raw: unknown;
  try {
    const text = e.isBase64Encoded ? Buffer.from(e.body ?? '', 'base64').toString() : e.body;
    raw = JSON.parse(text || '{}');
  } catch {
    return 'That wasn’t valid.';
  }
  const r = schema.safeParse(raw);
  return r.success ? r.data : (r.error.issues[0]?.message ?? 'That wasn’t valid.');
}

/** CloudFront passes the viewer's address on; only a hash of it is kept (with a TTL). */
function clientIp(e: UrlEvent): string {
  return (
    e.headers?.['cloudfront-viewer-address']?.replace(/:\d+$/, '') ??
    e.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ??
    e.requestContext.http.sourceIp ??
    'unknown'
  );
}

/** Counts a request from this network this hour; false past the limit. */
async function underLimit(kind: string, ip: string, limit: number): Promise<boolean> {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = createHash('sha256').update(`${kind}:${ip}:${hour}`).digest('hex');
  const res = await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: `RATE#${kind}`, SK: key },
      UpdateExpression: 'ADD n :one SET #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': (hour + 2) * 3600 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(res.Attributes?.n ?? 0) <= limit;
}

// ── Newsletter sign-up ──────────────────────────────────────────────────────
async function newsletter(e: UrlEvent): Promise<UrlResult> {
  const body = parse(e, SignupBody);
  if (typeof body === 'string') return problem(400, body);
  if (!(await underLimit('newsletter', clientIp(e), SIGNUPS_PER_IP_PER_HOUR))) {
    return problem(429, 'Too many sign-ups from here. Try again in an hour.');
  }
  const email = body.email.trim().toLowerCase();
  const key = { PK: NEWSLETTER_PK, SK: signupSk(email) };
  const was = (await db.send(new GetCommand({ TableName: table(), Key: key }))).Item as
    Signup | undefined;
  const ok = reply(200, { ok: true });
  // Signed up a moment ago: say yes again, but don't send another email.
  if (was && Date.now() - Date.parse(was.createdAt) < SIGNUP_AGAIN_AFTER_SECONDS * 1000) return ok;
  const item: Signup = {
    email,
    ...(body.firstName ? { firstName: body.firstName } : {}),
    createdAt: new Date().toISOString(),
    status: 'waiting',
  };
  // Straight into Mailchimp when it's connected (it sends the confirm-your-
  // address email); otherwise the hourly sync adds them once it is.
  try {
    const mc = await mailchimp();
    item.mailchimpStatus = await addSubscriber(mc, {
      email,
      ...(body.firstName ? { firstName: body.firstName } : {}),
    });
    item.status = 'added';
    item.addedAt = new Date().toISOString();
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'newsletter: kept for the hourly sync',
        error: (err as Error).message,
      }),
    );
  }
  await db.send(new PutCommand({ TableName: table(), Item: { ...key, type: 'signup', ...item } }));
  return ok;
}

// ── Recovery codes ──────────────────────────────────────────────────────────
async function userByEmail(email: string): Promise<{ sub: string; username: string } | undefined> {
  const res = await cognito.send(
    new ListUsersCommand({
      UserPoolId: env('USER_POOL_ID'),
      Filter: `email = "${email.replace(/["\\]/g, '')}"`,
      Limit: 2,
    }),
  );
  // Only an enabled account with its own password (not a social sign-in user).
  const u = (res.Users ?? []).find(
    (x) =>
      x.Enabled && x.UserStatus !== 'EXTERNAL_PROVIDER' && x.UserStatus !== 'FORCE_CHANGE_PASSWORD',
  );
  const sub = u?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  return sub && u?.Username ? { sub, username: u.Username } : undefined;
}

async function recovery(e: UrlEvent): Promise<UrlResult> {
  const body = parse(e, RecoveryBody);
  if (typeof body === 'string') return problem(400, body);
  if (!(await underLimit('recovery', clientIp(e), 20))) {
    return problem(429, 'Too many tries from here. Try again in an hour.');
  }
  const refused = problem(400, RECOVERY_REFUSED);
  const user = await userByEmail(body.email.trim().toLowerCase());
  if (!user) return refused;
  const { sub } = user;
  const key = { PK: `USER#${sub}`, SK: RECOVERY_SK };
  const rec = (await db.send(new GetCommand({ TableName: table(), Key: key }))).Item as
    (RecoveryRecord & { PK: string }) | undefined;
  const nowS = Math.floor(Date.now() / 1000);
  if (!rec || locked(rec, nowS)) return refused;
  const i = matchCode(body.code, rec.codes);
  if (i < 0) {
    const fresh = !rec.failWindowStart || nowS - rec.failWindowStart >= 3600;
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: key,
        UpdateExpression: fresh
          ? 'SET failures = :one, failWindowStart = :now'
          : 'SET failures = failures + :one',
        ExpressionAttributeValues: fresh ? { ':one': 1, ':now': nowS } : { ':one': 1 },
      }),
    );
    return refused;
  }
  // Used once: strike it out, only if it's still there (two tries at once can't both win).
  try {
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: key,
        UpdateExpression: `SET codes[${i}] = :null, usedAt = :at REMOVE failures, failWindowStart`,
        ConditionExpression: `codes[${i}] = :was`,
        ExpressionAttributeValues: {
          ':null': null,
          ':at': new Date().toISOString(),
          ':was': rec.codes[i],
        },
      }),
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return refused;
    throw err;
  }
  // The authenticator (and text codes) go; the next sign-in, with the
  // password, sets up a new authenticator. A social sign-in's step-up
  // authenticator goes too.
  const username = user.username;
  await cognito.send(
    new AdminSetUserMFAPreferenceCommand({
      UserPoolId: env('USER_POOL_ID'),
      Username: username,
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
      SMSMfaSettings: { Enabled: false, PreferredMfa: false },
    }),
  );
  await db.send(new DeleteCommand({ TableName: table(), Key: { PK: `USER#${sub}`, SK: 'TOTP' } }));
  await publish('account.recovered', {
    sub,
    left: rec.codes.filter((c, j) => c && j !== i).length,
  });
  console.log(JSON.stringify({ msg: 'recovery code used', sub }));
  return reply(200, { ok: true });
}

export async function handler(e: UrlEvent): Promise<UrlResult> {
  try {
    const route = `${e.requestContext.http.method} ${e.rawPath.replace(/\/+$/, '')}`;
    if (route === 'POST /public/newsletter') return await newsletter(e);
    if (route === 'POST /public/recovery') return await recovery(e);
    return problem(404, 'Not found');
  } catch (err) {
    console.error(JSON.stringify({ msg: 'public endpoint failed', error: (err as Error).name }));
    return problem(500, 'Something went wrong. Try again in a minute.');
  }
}
