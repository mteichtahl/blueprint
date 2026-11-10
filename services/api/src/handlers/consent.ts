import { randomUUID } from 'node:crypto';
import { projectAiState } from '../ai/state.ts';
import { PutEventsCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  audit,
  authContext,
  db,
  env,
  handle,
  hashIp,
  HttpError,
  json,
  parseBody,
  principalFor,
} from '../lib.ts';

const events = new EventBridgeClient({});

const ConsentBody = z.object({
  termsVersion: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'termsVersion must be a date like 2026-11-08'),
  aiOptIn: z.boolean(),
});

/**
 * GET /consent: your decision history. POST /consent: record terms acceptance
 * and the AI choice (design F1 step 4, 10.4). The ledger is append-only: this
 * role can put and query, never update or delete.
 */
export const handler = handle(async (event) => {
  const ctx = authContext(event);
  const principal = await principalFor(ctx);
  const pk = `USER#${ctx.sub}`;

  if (event.httpMethod === 'GET') {
    const res = await db.send(
      new QueryCommand({
        TableName: env('CONSENT_TABLE'),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: false,
        Limit: 50,
      }),
    );
    return json(200, {
      decisions: (res.Items ?? []).map((i) => ({
        termsVersion: i.termsVersion,
        aiOptIn: i.aiOptIn,
        decidedAt: i.decidedAt,
      })),
    });
  }

  // Consent is personal: the key comes from the verified token, so a user can
  // only ever read or record their own decisions.
  if (!principal.mfaSatisfied) throw new HttpError(403, 'two-step verification required');

  const body = parseBody(event, ConsentBody);
  const previous = await db.send(
    new QueryCommand({
      TableName: env('CONSENT_TABLE'),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const decidedAt = new Date().toISOString();
  await db.send(
    new PutCommand({
      TableName: env('CONSENT_TABLE'),
      Item: {
        PK: pk,
        SK: `CONSENT#${decidedAt}#${randomUUID()}`,
        sub: ctx.sub,
        role: ctx.role,
        artistId: ctx.artistId,
        termsVersion: body.termsVersion,
        aiOptIn: body.aiOptIn,
        decidedAt,
        ipHash: hashIp(event.requestContext.identity?.sourceIp),
        userAgent: (event.headers?.['user-agent'] ?? event.headers?.['User-Agent'] ?? '').slice(
          0,
          256,
        ),
      },
      ConditionExpression: 'attribute_not_exists(SK)',
    }),
  );

  const aiChanged = previous.Items?.[0]?.aiOptIn !== body.aiOptIn;
  if (aiChanged && ctx.artistId) {
    // The AI purge/grant workflows subscribe to this (Phase 5, design 10.4).
    await events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: env('EVENT_BUS'),
            Source: 'bmg.identity',
            DetailType: 'consent.aiChanged',
            Detail: JSON.stringify({ artistId: ctx.artistId, aiOptIn: body.aiOptIn, decidedAt }),
          },
        ],
      }),
    );
  }
  // The roster's Terms and AI columns (Artists & access) read this summary.
  if (ctx.artistId) await projectAiState(ctx.artistId, body.aiOptIn, decidedAt, body.termsVersion);
  await audit(event, 'consent.recorded', 'success', {
    termsVersion: body.termsVersion,
    aiOptIn: body.aiOptIn,
  });
  return json(201, { termsVersion: body.termsVersion, aiOptIn: body.aiOptIn, decidedAt });
});
