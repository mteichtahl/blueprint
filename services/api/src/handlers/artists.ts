import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { authorize } from '@bmg/authz';
import { newArtistId } from '@bmg/crypto';
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

/**
 * POST /artists: a BMG admin invites an artist (design F1). Needs a fresh
 * step-up. Creates the invite, starts onboarding (the artist's own KMS key),
 * and creates the Cognito user with an immutable artistId in the artist group.
 */
export const handler = handle(async (event) => {
  const ctx = authContext(event);
  const principal = await principalFor(ctx);
  const decision = authorize(principal, 'admin', { kind: 'org-admin' });
  if (!decision.allow) {
    await audit(event, 'artist.invite', 'denied', { reason: decision.reason });
    throw new HttpError(403, decision.reason);
  }

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

  // Executions are named by artistId, so a retry can never create a second key.
  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: env('ONBOARDING_STATE_MACHINE_ARN'),
      name: artistId,
      input: JSON.stringify({ artistId }),
    }),
  );

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
        DesiredDeliveryMediums: ['EMAIL'],
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

  await audit(event, 'artist.invite', 'success', { artistId });
  return json(201, { artistId, status: 'invited', expiresInDays: INVITE_DAYS });
});
