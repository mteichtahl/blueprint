import { randomUUID } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { BatchGetCommand, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';
import {
  DEFAULT_PREFERENCES,
  inQuietHours,
  MESSAGE_EMAIL_THROTTLE_SECONDS,
  NOTIFICATION_TTL_SECONDS,
  notificationPk,
  plan,
  Preferences,
  PREFS_SK,
  pushPayload,
  userPk,
  type Draft,
  type DomainEvent,
  type PushSubscriptionBody,
  type Recipient,
} from '../notifications/model.ts';
import { publish } from '../realtime.ts';
import { db, env } from '../lib.ts';

const cognito = new CognitoIdentityProviderClient({});
const sqs = new SQSClient({});
const secrets = new SecretsManagerClient({});

let vapid: { publicKey: string; privateKey: string; subject: string } | null | undefined;
async function vapidKeys() {
  if (vapid !== undefined) return vapid;
  try {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: env('VAPID_SECRET_ID') }));
    const v = JSON.parse(res.SecretString ?? '{}');
    vapid = v.publicKey && v.privateKey ? v : null;
  } catch {
    vapid = null;
  }
  return vapid;
}

/** Sends to each of the person's devices; drops subscriptions the push service says are gone. */
async function push(sub: string, draft: Draft) {
  const keys = await vapidKeys();
  if (!keys) return;
  const res = await db.send(
    new QueryCommand({
      TableName: env('MAIN_TABLE'),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': userPk(sub), ':p': 'PUSH#' },
      Limit: 10,
    }),
  );
  await Promise.all(
    (res.Items ?? []).map(async (item) => {
      try {
        await webpush.sendNotification(
          item.subscription as PushSubscriptionBody,
          pushPayload(draft),
          {
            vapidDetails: keys,
            TTL: 24 * 3600,
            urgency: 'normal',
          },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.send(
            new DeleteCommand({ TableName: env('MAIN_TABLE'), Key: { PK: item.PK, SK: item.SK } }),
          );
        } else {
          console.warn(JSON.stringify({ level: 'warn', event: 'push.failed', status }));
        }
      }
    }),
  );
}

const attr = (u: UserType, name: string) => u.Attributes?.find((a) => a.Name === name)?.Value;

async function group(name: string): Promise<UserType[]> {
  const users: UserType[] = [];
  let token: string | undefined;
  do {
    const res = await cognito.send(
      new ListUsersInGroupCommand({
        UserPoolId: env('USER_POOL_ID'),
        GroupName: name,
        NextToken: token,
      }),
    );
    users.push(...(res.Users ?? []));
    token = res.NextToken;
  } while (token);
  return users.filter((u) => u.Enabled !== false);
}

/** Everyone who could be notified: artists, admins and staff (with assignments). */
async function everyone(): Promise<Recipient[]> {
  const [artists, admins, staff] = await Promise.all([
    group('artist'),
    group('bmg-admin'),
    group('bmg-staff'),
  ]);
  const to = (u: UserType, role: Recipient['role']): Recipient | undefined => {
    const sub = attr(u, 'sub');
    if (!sub) return undefined;
    const email = attr(u, 'email');
    const artistId = attr(u, 'custom:artistId');
    return { sub, role, ...(email ? { email } : {}), ...(artistId ? { artistId } : {}) };
  };
  const staffList = staff.map((u) => to(u, 'bmg-staff')).filter((r): r is Recipient => !!r);
  if (staffList.length) {
    const res = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [env('MAIN_TABLE')]: {
            Keys: staffList.slice(0, 100).map((r) => ({ PK: `STAFF#${r.sub}`, SK: 'ASSIGNMENTS' })),
          },
        },
      }),
    );
    const byPk = Object.fromEntries(
      (res.Responses?.[env('MAIN_TABLE')] ?? []).map((i) => [i.PK, i.artistIds as string[]]),
    );
    for (const r of staffList) r.assignedArtistIds = byPk[`STAFF#${r.sub}`] ?? [];
  }
  return [
    ...artists.map((u) => to(u, 'artist')),
    ...admins.map((u) => to(u, 'bmg-admin')),
    ...staffList,
  ].filter((r): r is Recipient => !!r);
}

async function preferences(subs: string[]): Promise<Record<string, Preferences>> {
  if (subs.length === 0) return {};
  const res = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [env('MAIN_TABLE')]: {
          Keys: subs.slice(0, 100).map((s) => ({ PK: userPk(s), SK: PREFS_SK })),
        },
      },
    }),
  );
  const out: Record<string, Preferences> = {};
  for (const item of res.Responses?.[env('MAIN_TABLE')] ?? []) {
    const parsed = Preferences.safeParse(item.preferences);
    if (parsed.success) out[(item.PK as string).slice(5)] = parsed.data;
  }
  return out;
}

/** True the first time in the window; later calls in the window are throttled. */
async function claimThrottle(sub: string, key: string): Promise<boolean> {
  try {
    await db.send(
      new PutCommand({
        TableName: env('MAIN_TABLE'),
        Item: {
          PK: notificationPk(sub),
          SK: `MAILED#${key}`,
          ttl: Math.floor(Date.now() / 1000) + MESSAGE_EMAIL_THROTTLE_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK) OR #ttl < :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
      }),
    );
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Turns domain events into notifications (design 7.4): an in-app item per
 * recipient, a realtime nudge on their personal channel, and an email job
 * unless they turned email off, it's their quiet hours, or (for messages)
 * they were emailed about this conversation in the last 30 minutes.
 */
export async function handler(event: { 'detail-type': string; detail: Record<string, unknown> }) {
  const e = { ...event.detail, type: event['detail-type'] } as DomainEvent;
  const all = await everyone();
  const planned = plan(e, all);
  if (!planned || planned.to.length === 0) return;
  const prefs = await preferences(planned.to.map((r) => r.sub));
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + NOTIFICATION_TTL_SECONDS;

  for (const r of planned.to) {
    const id = randomUUID();
    await db.send(
      new PutCommand({
        TableName: env('MAIN_TABLE'),
        Item: {
          PK: notificationPk(r.sub),
          SK: `N#${now.toISOString()}#${id}`,
          type: 'notification',
          notificationId: id,
          ...planned.draft,
          read: false,
          createdAt: now.toISOString(),
          ttl,
        },
      }),
    );
    await publish([`/inbox/user-${r.sub}`], { notification: id });

    const p = prefs[r.sub] ?? DEFAULT_PREFERENCES;
    const quiet = inQuietHours(p, now);
    if (p.push && !quiet) await push(r.sub, planned.draft);
    if (!r.email || !p.email || quiet) continue;
    if (planned.draft.throttleKey && !(await claimThrottle(r.sub, planned.draft.throttleKey)))
      continue;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: env('MAIL_QUEUE_URL'),
        MessageBody: JSON.stringify({ to: r.email, draft: planned.draft }),
      }),
    );
  }
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'notifications.sent',
      type: e.type,
      recipients: planned.to.length,
    }),
  );
}
