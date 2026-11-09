import {
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { appOrigin, sendMail } from '@bmg/email';
import type { EventBridgeEvent } from 'aws-lambda';
import {
  onFeedbackGiven,
  onSubmissionUpdated,
  onTodoReminder,
  onTodoUpdated,
  type Decision,
  type FeedbackGiven,
  type SubmissionUpdated,
  type TodoItem,
  type TodoReminder,
  type TodoUpdated,
} from './model.ts';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const ARTIST_ID = /^art_[a-z0-9]{10,32}$/;
const ITEM_ID = /^[a-z0-9]{10,40}$/;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function get<T>(PK: string, SK: string): Promise<T | undefined> {
  const res = await db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: { PK, SK } }));
  return res.Item as T | undefined;
}

/**
 * Artists invited before contact records existed have none. Find their email
 * in the user pool's artist group once (Cognito can't filter on custom
 * attributes, but the roster is small) and save it, so later lookups are direct.
 */
async function contactFromUserPool(
  pk: string,
  artistId: string,
): Promise<{ email?: string } | undefined> {
  let NextToken: string | undefined;
  do {
    const res = await cognito.send(
      new ListUsersInGroupCommand({
        UserPoolId: env('USER_POOL_ID'),
        GroupName: 'artist',
        Limit: 60,
        ...(NextToken ? { NextToken } : {}),
      }),
    );
    for (const u of res.Users ?? []) {
      const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value;
      if (attr('custom:artistId') !== artistId) continue;
      const email = attr('email');
      if (!email) return undefined;
      await db.send(
        new UpdateCommand({
          TableName: env('MAIN_TABLE'),
          Key: { PK: pk, SK: 'CONTACT' },
          UpdateExpression:
            'SET #t = if_not_exists(#t, :t), artistId = :a, email = if_not_exists(email, :e), #s = if_not_exists(#s, :s)',
          ExpressionAttributeNames: { '#t': 'type', '#s': 'sub' },
          ExpressionAttributeValues: {
            ':t': 'artistContact',
            ':a': artistId,
            ':e': email,
            ':s': attr('sub') ?? null,
          },
        }),
      );
      log('notify.contactBackfilled', { artistId });
      return { email };
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return undefined;
}

/** Ids only in logs: no emails, names or titles. */
function log(event: string, fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

type Detail = Record<string, unknown> & { artistId?: string };

/**
 * Turns workspace events (to-do changes, scheduled reminders, review updates)
 * into BMG-branded emails. Errors throw, so EventBridge retries and finally
 * parks the event on the dead-letter queue.
 */
export const handler = async (event: EventBridgeEvent<string, Detail>): Promise<void> => {
  const d = event.detail;
  const artistId = d.artistId;
  if (!artistId || !ARTIST_ID.test(artistId)) {
    log('notify.skipped', { type: event['detail-type'], reason: 'bad-artist' });
    return;
  }
  const pk = `ARTIST#${artistId}`;
  const ctx = { appOrigin: await appOrigin() };
  const stored = await get<{ email?: string; displayName?: string }>(pk, 'CONTACT');
  const contact: { email?: string; displayName?: string } | undefined = stored?.email
    ? stored
    : { ...stored, ...(await contactFromUserPool(pk, artistId)) };
  const profile = await get<{ displayName?: string }>(pk, 'PROFILE');
  const artistName = profile?.displayName ?? contact?.displayName;
  const todo = async (id: unknown) =>
    typeof id === 'string' && ITEM_ID.test(id) ? get<TodoItem>(pk, `TODO#${id}`) : undefined;
  const subTitle = async (id: unknown) =>
    typeof id === 'string' && ITEM_ID.test(id)
      ? (await get<{ title?: string }>(pk, `SUB#${id}`))?.title
      : undefined;

  let decision: Decision;
  switch (event['detail-type']) {
    case 'todo.updated': {
      const e = d as unknown as TodoUpdated;
      decision = onTodoUpdated(
        ctx,
        { ...e, changedFields: Array.isArray(e.changedFields) ? e.changedFields : [] },
        await todo(e.todoId),
        artistName,
      );
      break;
    }
    case 'todo.reminder': {
      const e = d as unknown as TodoReminder;
      decision = onTodoReminder(ctx, e, await todo(e.todoId));
      break;
    }
    case 'submission.updated': {
      const e = d as unknown as SubmissionUpdated;
      decision = onSubmissionUpdated(ctx, e, await subTitle(e.submissionId));
      break;
    }
    case 'submission.feedbackGiven': {
      const e = d as unknown as FeedbackGiven;
      decision = onFeedbackGiven(ctx, e, await subTitle(e.submissionId));
      break;
    }
    default:
      log('notify.skipped', { type: event['detail-type'], reason: 'unknown-type' });
      return;
  }

  if (!decision.send) {
    log('notify.skipped', { type: event['detail-type'], artistId, reason: decision.reason });
    return;
  }
  const to = decision.to === 'bmg' ? env('BMG_NOTIFY_ADDRESS') : contact?.email;
  if (!to) {
    log('notify.skipped', { type: event['detail-type'], artistId, reason: 'no-contact' });
    return;
  }
  await sendMail(to, decision.email);
  log('notify.sent', { type: event['detail-type'], artistId, to: decision.to });
};
