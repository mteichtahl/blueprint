import { randomInt } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authorize } from '@bmg/authz';
import { isArtistId, newArtistId } from '@bmg/crypto';
import { appOrigin, inviteEmail, sendMail } from '@bmg/email';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { accessRoutes } from './access.ts';
import { z } from 'zod';
import {
  audit,
  authContext,
  db,
  env,
  handle,
  HttpError,
  json,
  parseBody,
  principalFor,
} from '../lib.ts';

const cognito = new CognitoIdentityProviderClient({});
const sfn = new SFNClient({});

const InviteBody = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(120),
});

const INVITE_DAYS = 7;

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
/** Cognito-allowed symbols that read clearly in an email and need no HTML escaping. */
const SYMBOLS = '!@#%*-_+=?';

/**
 * A temporary password that meets the pool policy (12+ characters with
 * lower, upper, digit and symbol): 16 characters from a CSPRNG, without
 * look-alike characters. The artist replaces it at first sign-in.
 */
export function temporaryPassword(length = 16): string {
  const pick = (set: string) => set[randomInt(set.length)]!;
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

const contactKey = (artistId: string) => ({ PK: `ARTIST#${artistId}`, SK: 'CONTACT' });

/** Sends the branded invitation (design F1: Gmail SMTP as the configured sender). */
async function sendInvite(email: string, displayName: string, password: string) {
  await sendMail(
    email,
    inviteEmail(
      { appOrigin: await appOrigin() },
      { displayName, email, temporaryPassword: password, expiresInDays: INVITE_DAYS },
    ),
  );
}

async function requireAdmin(event: APIGatewayProxyEvent, action: string) {
  const principal = await principalFor(authContext(event));
  const decision = authorize(principal, 'admin', { kind: 'org-admin' });
  if (!decision.allow) {
    await audit(event, action, 'denied', { reason: decision.reason });
    throw new HttpError(403, decision.reason);
  }
  return principal;
}

/**
 * POST /artists: a BMG admin invites an artist (design F1). Needs a fresh
 * step-up. Creates the invite, starts onboarding (the artist's own KMS key),
 * creates the Cognito user with an immutable artistId in the artist group,
 * and sends a BMG-branded invitation with a temporary password.
 *
 * POST /artists/{artistId}/invite/resend: sets a new temporary password and
 * sends the invitation again, while the artist hasn't signed in yet.
 */
export const handler = handle(async (event) => {
  if (event.resource === '/access/{proxy+}') return accessRoutes(event, temporaryPassword);
  if (event.resource === '/artists/{artistId}/invite/resend') return resend(event);

  const ctx = authContext(event);
  await requireAdmin(event, 'artist.invite');

  const body = parseBody(event, InviteBody);
  const email = body.email.trim().toLowerCase();
  const artistId = newArtistId();
  const now = Math.floor(Date.now() / 1000);

  try {
    await db.send(
      new PutCommand({
        TableName: env('MAIN_TABLE'),
        Item: {
          PK: `INVITE#${email}`,
          SK: 'INVITE',
          type: 'invite',
          artistId,
          displayName: body.displayName,
          status: 'pending',
          invitedBy: ctx.sub,
          createdAt: new Date().toISOString(),
          expiresAt: now + INVITE_DAYS * 86400,
        },
        // A live invite for the same email isn't overwritten.
        ConditionExpression: 'attribute_not_exists(PK) OR #s <> :pending OR expiresAt < :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':pending': 'pending', ':now': now },
      }),
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'This email already has a pending invite');
    }
    throw err;
  }

  // Roster entry (GSI1 sorts the roster by name). No email here: it stays in Cognito and the invite.
  await db.send(
    new PutCommand({
      TableName: env('MAIN_TABLE'),
      Item: {
        PK: `ARTIST#${artistId}`,
        SK: 'PROFILE',
        type: 'artistProfile',
        artistId,
        displayName: body.displayName,
        status: 'invited',
        invitedBy: ctx.sub,
        createdAt: new Date().toISOString(),
        GSI1PK: 'ARTISTS',
        GSI1SK: `${body.displayName.toLowerCase()}#${artistId}`,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  // Where notifications find the artist's email. On no index.
  await db.send(
    new PutCommand({
      TableName: env('MAIN_TABLE'),
      Item: {
        ...contactKey(artistId),
        type: 'artistContact',
        artistId,
        email,
        displayName: body.displayName,
        updatedAt: new Date().toISOString(),
      },
    }),
  );

  // Executions are named by artistId, so a retry can never create a second key.
  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: env('ONBOARDING_STATE_MACHINE_ARN'),
      name: artistId,
      input: JSON.stringify({ artistId }),
    }),
  );

  const password = temporaryPassword();
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: env('USER_POOL_ID'),
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'custom:artistId', Value: artistId },
        ],
        TemporaryPassword: password,
        // Cognito's own email is replaced by the branded invitation below.
        MessageAction: 'SUPPRESS',
      }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      throw new HttpError(409, 'A user with this email already exists');
    }
    throw err;
  }
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: env('USER_POOL_ID'),
      Username: email,
      GroupName: 'artist',
    }),
  );

  let emailSent = true;
  try {
    await sendInvite(email, body.displayName, password);
  } catch (err) {
    emailSent = false;
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'artist.inviteEmailFailed',
        name: (err as Error).name,
      }),
    );
  }
  await audit(event, 'artist.invite', 'success', { artistId, emailSent });
  if (!emailSent) {
    // The account exists; the admin can resend once email works again.
    throw new HttpError(
      502,
      `The artist was created, but the invitation email couldn't be sent. Resend it from Artists & access (artist ${artistId}).`,
    );
  }
  return json(201, { artistId, status: 'invited', expiresInDays: INVITE_DAYS });
});

async function resend(event: APIGatewayProxyEvent) {
  await requireAdmin(event, 'artist.inviteResend');
  const artistId = event.pathParameters?.artistId;
  if (!isArtistId(artistId)) throw new HttpError(404, 'No such artist');
  const table = env('MAIN_TABLE');
  const contact = (await db.send(new GetCommand({ TableName: table, Key: contactKey(artistId) })))
    .Item as { email?: string; displayName?: string } | undefined;
  if (!contact?.email) throw new HttpError(404, 'No invitation on record for this artist');
  const email = contact.email;

  const user = await cognito.send(
    new AdminGetUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }),
  );
  if (user.UserStatus !== 'FORCE_CHANGE_PASSWORD') {
    throw new HttpError(409, 'This artist has already signed in');
  }
  const profile = (
    await db.send(
      new GetCommand({ TableName: table, Key: { PK: `ARTIST#${artistId}`, SK: 'PROFILE' } }),
    )
  ).Item as { displayName?: string } | undefined;
  const displayName = profile?.displayName ?? contact.displayName ?? 'there';

  const now = Math.floor(Date.now() / 1000);
  // A fresh 7 days, for social sign-in too (pre sign-up checks the invite).
  await db
    .send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `INVITE#${email}`, SK: 'INVITE' },
        UpdateExpression: 'SET expiresAt = :exp',
        ConditionExpression: '#s = :pending AND artistId = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':exp': now + INVITE_DAYS * 86400,
          ':pending': 'pending',
          ':a': artistId,
        },
      }),
    )
    .catch((err: Error) => {
      if (err.name === 'ConditionalCheckFailedException') {
        throw new HttpError(409, 'This invitation is no longer pending');
      }
      throw err;
    });
  const password = temporaryPassword();
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: env('USER_POOL_ID'),
      Username: email,
      Password: password,
      Permanent: false,
    }),
  );
  try {
    await sendInvite(email, displayName, password);
  } catch {
    await audit(event, 'artist.inviteResend', 'failed', { artistId });
    throw new HttpError(502, "The invitation email couldn't be sent. Try again shortly.");
  }
  await audit(event, 'artist.inviteResend', 'success', { artistId });
  return json(200, { artistId, status: 'invited', expiresInDays: INVITE_DAYS });
}
