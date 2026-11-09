import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  DEFAULT_PREFERENCES,
  notificationPk,
  Preferences,
  PREFS_SK,
  PushSubscriptionBody,
  pushSk,
  userPk,
} from '../notifications/model.ts';
import { authContext, db, env, handle, HttpError, json, parseBody } from '../lib.ts';

const secrets = new SecretsManagerClient({});
let vapidPublicKey: string | undefined;

const Unsubscribe = z.object({ endpoint: z.string().url().max(1000) });

const MarkRead = z.object({
  ids: z
    .array(z.string().regex(/^N#[\dT:.\-Z]+#[0-9a-f-]{36}$/))
    .max(100)
    .default([]),
  all: z.boolean().default(false),
});

/** The bell (in-app notifications) and notification preferences, for the signed-in user only. */
export const handler = handle(async (event) => {
  const { sub } = authContext(event);
  const table = env('MAIN_TABLE');
  const route = `${event.httpMethod} ${event.resource}`;

  switch (route) {
    case 'GET /notifications': {
      const res = await db.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :n)',
          ExpressionAttributeValues: { ':pk': notificationPk(sub), ':n': 'N#' },
          ScanIndexForward: false,
          Limit: 50,
        }),
      );
      const items = (res.Items ?? []).map((n) => ({
        id: n.SK as string,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link,
        read: !!n.read,
        createdAt: n.createdAt,
      }));
      return json(200, { notifications: items, unread: items.filter((n) => !n.read).length });
    }

    case 'POST /notifications/read': {
      const body = parseBody(event, MarkRead);
      let ids = body.ids;
      if (body.all) {
        const res = await db.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :n)',
            FilterExpression: '#r = :f',
            ExpressionAttributeNames: { '#r': 'read' },
            ExpressionAttributeValues: { ':pk': notificationPk(sub), ':n': 'N#', ':f': false },
            Limit: 200,
          }),
        );
        ids = (res.Items ?? []).map((i) => i.SK as string);
      }
      await Promise.all(
        ids.map((id) =>
          db
            .send(
              new UpdateCommand({
                TableName: table,
                Key: { PK: notificationPk(sub), SK: id },
                UpdateExpression: 'SET #r = :t',
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeNames: { '#r': 'read' },
                ExpressionAttributeValues: { ':t': true },
              }),
            )
            .catch((err: Error) => {
              if (err.name !== 'ConditionalCheckFailedException') throw err;
            }),
        ),
      );
      return json(200, { updated: ids.length });
    }

    case 'GET /preferences': {
      const res = await db.send(
        new GetCommand({ TableName: table, Key: { PK: userPk(sub), SK: PREFS_SK } }),
      );
      const parsed = Preferences.safeParse(res.Item?.preferences);
      return json(200, parsed.success ? parsed.data : DEFAULT_PREFERENCES);
    }

    case 'PUT /preferences': {
      const prefs = parseBody(event, Preferences);
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            PK: userPk(sub),
            SK: PREFS_SK,
            type: 'preferences',
            preferences: prefs,
            updatedAt: new Date().toISOString(),
          },
        }),
      );
      return json(200, prefs);
    }

    case 'GET /push/key': {
      if (!vapidPublicKey) {
        const res = await secrets.send(
          new GetSecretValueCommand({ SecretId: env('VAPID_SECRET_ID') }),
        );
        vapidPublicKey = (JSON.parse(res.SecretString ?? '{}') as { publicKey?: string }).publicKey;
      }
      if (!vapidPublicKey) throw new HttpError(409, 'Push isn’t set up yet');
      return json(200, { publicKey: vapidPublicKey });
    }

    case 'POST /push/subscriptions': {
      const subscription = parseBody(event, PushSubscriptionBody);
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            PK: userPk(sub),
            SK: pushSk(subscription.endpoint),
            type: 'push-subscription',
            subscription,
            userAgent: (event.headers?.['user-agent'] ?? '').slice(0, 200),
            createdAt: new Date().toISOString(),
          },
        }),
      );
      return json(201, { ok: true });
    }

    case 'POST /push/unsubscribe': {
      const { endpoint } = parseBody(event, Unsubscribe);
      await db.send(
        new DeleteCommand({ TableName: table, Key: { PK: userPk(sub), SK: pushSk(endpoint) } }),
      );
      return json(200, { ok: true });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
