import { randomInt } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  byStatusThenNewest,
  hasSignedIn,
  invitationActions,
  invitationStatus,
  refusal,
  type CognitoState,
  type InviteItem,
} from '../invitations/model.ts';
import { authorize } from '@bmg/authz';
import { isArtistId, newArtistId } from '@bmg/crypto';
import { appOrigin, inviteEmail, sendMail } from '@bmg/email';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { accessRoutes } from './access.ts';
import { newSet, RECOVERY_SK, type RecoveryRecord } from '../recovery.ts';
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
 * Recovery codes (sign-in), for whoever is signed in:
 *   GET  /access/recovery-codes  how many are left, and when they were made
 *   POST /access/recovery-codes  ten new codes, shown once (the old ones stop
 *                                working); needs a sign-in in the last 5 minutes
 */
async function recoveryCodes(event: APIGatewayProxyEvent) {
  const principal = await principalFor(authContext(event));
  if (!principal.mfaSatisfied) throw new HttpError(403, 'two-step verification required');
  const key = { PK: `USER#${principal.sub}`, SK: RECOVERY_SK };
  if (event.httpMethod === 'GET') {
    const rec = (await db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: key }))).Item as
      RecoveryRecord | undefined;
    return json(200, {
      left: rec ? rec.codes.filter(Boolean).length : 0,
      createdAt: rec?.createdAt ?? null,
      usedAt: rec?.usedAt ?? null,
    });
  }
  if (event.httpMethod !== 'POST') throw new HttpError(404, 'Not found');
  if (principal.secondsSinceAuth > 300) {
    throw new HttpError(403, 'Making recovery codes needs a fresh step-up');
  }
  const { shown, record } = newSet(new Date());
  await db.send(
    new PutCommand({
      TableName: env('MAIN_TABLE'),
      Item: { ...key, type: 'recovery', ...record },
    }),
  );
  await audit(event, 'auth.recoveryCodes', 'success', { count: shown.length });
  return json(201, { codes: shown, createdAt: record.createdAt });
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
  if (event.resource === '/access/{proxy+}') {
    // Artist invitations (onboarding) share the access proxy: no new API routes.
    if ((event.pathParameters?.proxy ?? '').startsWith('invitations')) return invitations(event);
    // Recovery codes (sign-in) share it too: everyone's own, after a fresh sign-in.
    if ((event.pathParameters?.proxy ?? '').startsWith('recovery-codes')) {
      return recoveryCodes(event);
    }
    return accessRoutes(event, temporaryPassword);
  }
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
  return resendInvite(event, event.pathParameters?.artistId);
}

/**
 * Sends the invitation again with a new temporary password and a fresh 7 days.
 * Works for pending, expired and revoked invitations (a revoked one is turned
 * back on); refused once the artist has signed in.
 */
async function resendInvite(event: APIGatewayProxyEvent, artistId: string | undefined) {
  if (!isArtistId(artistId)) throw new HttpError(404, 'No such artist');
  const table = env('MAIN_TABLE');
  const contact = (await db.send(new GetCommand({ TableName: table, Key: contactKey(artistId) })))
    .Item as { email?: string; displayName?: string } | undefined;
  if (!contact?.email) throw new HttpError(404, 'No invitation on record for this artist');
  const email = contact.email;

  const user = await cognito.send(
    new AdminGetUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }),
  );
  if (hasSignedIn({ userStatus: user.UserStatus })) {
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
        UpdateExpression:
          'SET expiresAt = :exp, #s = :pending, lastSentAt = :sent REMOVE revokedAt, revokedBy',
        ConditionExpression: '#s IN (:pending, :revoked) AND artistId = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':exp': now + INVITE_DAYS * 86400,
          ':pending': 'pending',
          ':revoked': 'revoked',
          ':sent': new Date().toISOString(),
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
  // A revoked invitation turned its login off: turn it back on.
  if (user.Enabled === false) {
    await cognito.send(
      new AdminEnableUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }),
    );
  }
  await setRosterStatus(artistId, 'invited');
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

/** The roster entry's status (shown on Artists & access): invited, active or revoked. */
async function setRosterStatus(artistId: string, status: 'invited' | 'active' | 'revoked') {
  await db
    .send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: { PK: `ARTIST#${artistId}`, SK: 'PROFILE' },
        UpdateExpression: 'SET #s = :s',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
      }),
    )
    .catch((err: Error) => {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    });
}

/** Every user in the artist group, by email. */
async function artistUsers(): Promise<Map<string, CognitoState>> {
  const out = new Map<string, CognitoState>();
  let NextToken: string | undefined;
  do {
    const page = await cognito.send(
      new ListUsersInGroupCommand({
        UserPoolId: env('USER_POOL_ID'),
        GroupName: 'artist',
        NextToken,
        Limit: 60,
      }),
    );
    for (const u of page.Users ?? []) {
      const email = u.Attributes?.find((a) => a.Name === 'email')?.Value?.toLowerCase();
      if (!email) continue;
      out.set(email, {
        ...(u.UserStatus ? { userStatus: u.UserStatus } : {}),
        enabled: u.Enabled !== false,
        ...(u.UserLastModifiedDate ? { lastModified: u.UserLastModifiedDate.toISOString() } : {}),
      });
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}

/**
 * Artist invitations (Invite artist page), all admin-only:
 *
 *   GET  /access/invitations                    every artist invitation and where it stands
 *   POST /access/invitations/{artistId}/resend  new temporary password, fresh 7 days
 *   POST /access/invitations/{artistId}/revoke  turn the invitation (and its login) off
 *
 * Accepted means the artist has signed in for the first time.
 */
async function invitations(event: APIGatewayProxyEvent) {
  const principal = await principalFor(authContext(event));
  if (!principal.mfaSatisfied) throw new HttpError(403, 'two-step verification required');
  const path = (event.pathParameters?.proxy ?? '').replace(/\/+$/, '');
  const method = event.httpMethod;
  const table = env('MAIN_TABLE');
  const nowS = Math.floor(Date.now() / 1000);

  if (path === 'invitations' && method === 'GET') {
    await requireAdmin(event, 'artist.invitations');
    const roster: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: table,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': 'ARTISTS' },
          ExclusiveStartKey,
        }),
      );
      roster.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const ids = roster.map((r) => String(r.artistId)).filter(isArtistId);
    const contacts = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const res = await db.send(
        new BatchGetCommand({
          RequestItems: { [table]: { Keys: ids.slice(i, i + 100).map(contactKey) } },
        }),
      );
      for (const c of res.Responses?.[table] ?? []) {
        if (c.email) contacts.set(String(c.artistId), String(c.email).toLowerCase());
      }
    }
    const emails = [...new Set(contacts.values())];
    const invites = new Map<string, InviteItem>();
    for (let i = 0; i < emails.length; i += 100) {
      const res = await db.send(
        new BatchGetCommand({
          RequestItems: {
            [table]: {
              Keys: emails.slice(i, i + 100).map((e) => ({ PK: `INVITE#${e}`, SK: 'INVITE' })),
            },
          },
        }),
      );
      for (const inv of res.Responses?.[table] ?? []) {
        invites.set(String(inv.PK).slice('INVITE#'.length), inv as InviteItem);
      }
    }
    const users = await artistUsers();
    const list = [];
    for (const r of roster) {
      const artistId = String(r.artistId);
      const email = contacts.get(artistId);
      const invite = email ? invites.get(email) : undefined;
      const cog = email ? users.get(email) : undefined;
      const status = invitationStatus(invite, cog, nowS);
      // First sign-in seen: record it once, so it holds even if Cognito changes later.
      if (status === 'accepted' && invite && invite.status !== 'accepted' && email) {
        const acceptedAt = cog?.lastModified ?? new Date().toISOString();
        await db
          .send(
            new UpdateCommand({
              TableName: table,
              Key: { PK: `INVITE#${email}`, SK: 'INVITE' },
              UpdateExpression: 'SET #s = :a, acceptedAt = :at',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':a': 'accepted', ':at': acceptedAt },
            }),
          )
          .catch(() => undefined);
        invite.acceptedAt = acceptedAt;
        if (r.status !== 'active') await setRosterStatus(artistId, 'active');
      }
      list.push({
        artistId,
        displayName: String(r.displayName ?? invite?.displayName ?? 'Artist'),
        email: email ?? null,
        status,
        invitedAt: invite?.createdAt ?? (r.createdAt as string | undefined) ?? null,
        lastSentAt: invite?.lastSentAt ?? invite?.createdAt ?? null,
        expiresAt: invite?.expiresAt ? new Date(invite.expiresAt * 1000).toISOString() : null,
        acceptedAt: invite?.acceptedAt ?? null,
        revokedAt: invite?.revokedAt ?? null,
        ...invitationActions(status),
      });
    }
    list.sort(byStatusThenNewest);
    return json(200, { invitations: list });
  }

  const one = /^invitations\/([^/]+)\/(resend|revoke)$/.exec(path);
  if (one && method === 'POST') {
    const [, artistId, action] = one as unknown as [string, string, 'resend' | 'revoke'];
    await requireAdmin(event, action === 'resend' ? 'artist.inviteResend' : 'artist.inviteRevoke');
    if (action === 'resend') return resendInvite(event, artistId);

    if (!isArtistId(artistId)) throw new HttpError(404, 'No such artist');
    const contact = (await db.send(new GetCommand({ TableName: table, Key: contactKey(artistId) })))
      .Item as { email?: string } | undefined;
    if (!contact?.email) throw new HttpError(404, 'No invitation on record for this artist');
    const email = contact.email.toLowerCase();
    const user = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }),
    );
    const invite = (
      await db.send(
        new GetCommand({ TableName: table, Key: { PK: `INVITE#${email}`, SK: 'INVITE' } }),
      )
    ).Item as InviteItem | undefined;
    const refused = refusal(
      'revoke',
      invitationStatus(invite, { userStatus: user.UserStatus }, nowS),
    );
    if (refused) throw new HttpError(409, refused);
    await db
      .send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: `INVITE#${email}`, SK: 'INVITE' },
          UpdateExpression: 'SET #s = :revoked, revokedAt = :at, revokedBy = :by',
          ConditionExpression: '#s = :pending AND artistId = :a',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':revoked': 'revoked',
            ':pending': 'pending',
            ':at': new Date().toISOString(),
            ':by': principal.sub,
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
    // The temporary password stops working, and any half-finished sign-in ends.
    await cognito.send(
      new AdminDisableUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }),
    );
    await cognito
      .send(new AdminUserGlobalSignOutCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }))
      .catch(() => undefined);
    await setRosterStatus(artistId, 'revoked');
    await audit(event, 'artist.inviteRevoke', 'success', { artistId });
    return json(200, { artistId, status: 'revoked' });
  }

  throw new HttpError(404, 'Not found');
}
