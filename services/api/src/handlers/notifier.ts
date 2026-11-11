import { randomUUID } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';
import {
  DEFAULT_PREFERENCES,
  inQuietHours,
  MESSAGE_EMAIL_THROTTLE_SECONDS,
  NOTIFICATION_TTL_SECONDS,
  notificationPk,
  planGroups,
  Preferences,
  PREFS_SK,
  pushPayload,
  userPk,
  type Draft,
  type DomainEvent,
  type Planned,
  type PushSubscriptionBody,
  type Recipient,
} from '../notifications/model.ts';
import { publish } from '../realtime.ts';
import { namesFor } from '../files/people.ts';
import { artistPk, PLAN_SK, PROFILE_SK, type Plan, type Todo } from '../workspace/model.ts';
import { digestLines } from '../workspace/plan-owner.ts';
import { handoverSummary } from '../workspace/plan-handover.ts';
import { PLAN_LOG_PREFIX, type PlanChange } from '../workspace/plan-history.ts';
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

const get = async <T>(PK: string, SK: string) =>
  (await db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: { PK, SK } }))).Item as
    T | undefined;

async function query<T>(
  pk: string,
  prefix: string,
  opts: { newestFirst?: boolean; limit?: number } = {},
) {
  const res = await db.send(
    new QueryCommand({
      TableName: env('MAIN_TABLE'),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': pk, ':p': prefix },
      ScanIndexForward: !opts.newestFirst,
      Limit: opts.limit ?? 500,
    }),
  );
  return (res.Items ?? []) as T[];
}

const artistName = async (artistId: string) =>
  String(
    (await get<{ displayName?: string }>(artistPk(artistId), PROFILE_SK))?.displayName ??
      'An artist',
  );

const melbourneToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date());

/**
 * Plan events that need reading before anyone can be told (rev 12):
 * - `plan.digest` (from a 10-minute schedule): one editor's saves, as `plan.updated`;
 * - `plan.handover`: the handover summary for the new owner, as `plan.ownerChanged`;
 * - `plan.updated` from a meeting: adds the owner and the artist's name.
 * Anything else passes through.
 */
async function enrich(
  raw: Record<string, unknown> & { type: string },
): Promise<DomainEvent | undefined> {
  const artistId = typeof raw.artistId === 'string' ? raw.artistId : '';
  if (!raw.type.startsWith('plan.')) return raw as unknown as DomainEvent;
  if (!/^art_[a-z0-9]{10,32}$/.test(artistId)) return undefined;
  const pk = artistPk(artistId);
  const plan = await get<Plan>(pk, PLAN_SK);

  if (raw.type === 'plan.digest') {
    const bySub = String(raw.bySub ?? '');
    const since = String(raw.since ?? '');
    const res = await db.send(
      new QueryCommand({
        TableName: env('MAIN_TABLE'),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':from': `${PLAN_LOG_PREFIX}${since}`,
          ':to': `${PLAN_LOG_PREFIX}\uffff`,
        },
        Limit: 200,
      }),
    );
    const { lines, more } = digestLines((res.Items ?? []) as PlanChange[], bySub);
    if (lines.length === 0) return undefined;
    return {
      type: 'plan.updated',
      artistId,
      lines,
      more,
      bySub,
      ...(plan?.ownerSub ? { ownerSub: plan.ownerSub } : {}),
      artistName: await artistName(artistId),
    };
  }

  if (raw.type === 'plan.handover') {
    if (!plan) return undefined;
    const toSub = String(raw.toSub ?? '');
    const fromSub = typeof raw.fromSub === 'string' ? raw.fromSub : undefined;
    const bySub = String(raw.bySub ?? '');
    const names = await namesFor([toSub, bySub, ...(fromSub ? [fromSub] : [])]);
    const to = names.get(toSub);
    if (!to) return undefined;
    const [todos, subs, recent, name] = await Promise.all([
      query<Todo>(pk, 'TODO#'),
      query<{ title?: string; neededBy?: string; status?: string }>(pk, 'SUB#'),
      query<PlanChange>(pk, PLAN_LOG_PREFIX, { newestFirst: true, limit: 5 }),
      artistName(artistId),
    ]);
    // The note is kept on the plan, not on the bus (events carry ids only).
    const note = plan.handoverNote?.trim() || undefined;
    return {
      type: 'plan.ownerChanged',
      artistId,
      artistName: name,
      ...(fromSub ? { fromSub } : {}),
      toSub,
      toName: to.displayName,
      bySub,
      moved: Number(raw.moved ?? 0),
      summary: handoverSummary({
        artistName: name,
        ...(fromSub ? { fromName: names.get(fromSub)?.displayName ?? 'a former team member' } : {}),
        byName: names.get(bySub)?.displayName ?? 'Blueprint',
        byNewOwner: bySub === toSub,
        ...(note ? { note } : {}),
        plan,
        todos: todos.filter((t) => !t.done && t.bmgOwnerSub === toSub),
        waiting: subs.filter((s) => s.status === 'open'),
        recent,
        today: melbourneToday(),
      }),
    };
  }

  if (raw.type === 'plan.updated') {
    return {
      ...(raw as unknown as Extract<DomainEvent, { type: 'plan.updated' }>),
      ...(plan?.ownerSub && !raw.ownerSub ? { ownerSub: plan.ownerSub } : {}),
      artistName: typeof raw.artistName === 'string' ? raw.artistName : await artistName(artistId),
    };
  }
  return raw as unknown as DomainEvent;
}

/**
 * Turns domain events into notifications (design 7.4): an in-app item per
 * recipient, a realtime nudge on their personal channel, and an email job
 * unless they turned email off, it's their quiet hours, or (for messages)
 * they were emailed about this conversation in the last 30 minutes.
 */
export async function handler(event: { 'detail-type': string; detail: Record<string, unknown> }) {
  const e = await enrich({ ...event.detail, type: event['detail-type'] });
  if (!e) return;
  const all = await everyone();
  const groups = planGroups(e, all).filter((g) => g.to.length > 0);
  for (const g of groups) await deliver(e, g);
}

/** One wording to its recipients: in-app, realtime, push and email. */
async function deliver(e: DomainEvent, planned: Planned) {
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
