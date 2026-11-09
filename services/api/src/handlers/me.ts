import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { projectAiState } from '../ai/state.ts';
import { authContext, db, env, handle, json } from '../lib.ts';

/** GET /me: who the API thinks you are, and your latest consent decision. */
export const handler = handle(async (event) => {
  const ctx = authContext(event);
  const latest = await db.send(
    new QueryCommand({
      TableName: env('CONSENT_TABLE'),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${ctx.sub}` },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const consent = latest.Items?.[0];
  // Artists who chose before the assistant existed get their choice recorded
  // the next time they open the app (the ledger stays the source of truth).
  if (ctx.artistId && consent && typeof consent.aiOptIn === 'boolean') {
    await projectAiState(ctx.artistId, consent.aiOptIn, String(consent.decidedAt));
  }
  return json(200, {
    sub: ctx.sub,
    role: ctx.role,
    artistId: ctx.artistId ?? null,
    mfaLevel: ctx.mfaLevel,
    stepUpRequired: !ctx.mfaSatisfied,
    consent: consent
      ? {
          termsVersion: consent.termsVersion,
          aiOptIn: consent.aiOptIn,
          decidedAt: consent.decidedAt,
        }
      : null,
  });
});
