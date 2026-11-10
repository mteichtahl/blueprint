import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { projectAiState } from '../ai/state.ts';
import { authContext, db, env, handle, HttpError, json, parseBody } from '../lib.ts';

/** Artists' job title is always "Artist" (rev 7); Blueprint people set their own. */
export const ARTIST_JOB_TITLE = 'Artist';
export const profileKey = (sub: string) => ({ PK: `USER#${sub}`, SK: 'PROFILE' });
export const ProfilePatch = z
  .object({ jobTitle: z.string().trim().max(80, 'Keep the job title under 80 characters') })
  .strict();

export function jobTitleFor(role: string, stored: unknown): string {
  if (role === 'artist') return ARTIST_JOB_TITLE;
  return typeof stored === 'string' ? stored : '';
}

/**
 * GET /me: who the API thinks you are, your job title and your latest consent
 * decision. PATCH /me: change your job title (Blueprint people only).
 */
export const handler = handle(async (event) => {
  const ctx = authContext(event);

  if (event.httpMethod === 'PATCH') {
    if (ctx.role === 'artist')
      throw new HttpError(403, `Artists' job title is always "${ARTIST_JOB_TITLE}"`);
    const { jobTitle } = parseBody(event, ProfilePatch);
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: profileKey(ctx.sub),
        UpdateExpression: 'SET jobTitle = :t, updatedAt = :at, #type = :type',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: {
          ':t': jobTitle,
          ':at': new Date().toISOString(),
          ':type': 'user-profile',
        },
      }),
    );
    return json(200, { jobTitle });
  }

  const [latest, profile] = await Promise.all([
    db.send(
      new QueryCommand({
        TableName: env('CONSENT_TABLE'),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `USER#${ctx.sub}` },
        ScanIndexForward: false,
        Limit: 1,
      }),
    ),
    ctx.role === 'artist'
      ? Promise.resolve(undefined)
      : db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: profileKey(ctx.sub) })),
  ]);
  const consent = latest.Items?.[0];
  // Artists who chose before the assistant existed get their choice recorded
  // the next time they open the app (the ledger stays the source of truth).
  if (ctx.artistId && consent && typeof consent.aiOptIn === 'boolean') {
    await projectAiState(
      ctx.artistId,
      consent.aiOptIn,
      String(consent.decidedAt),
      typeof consent.termsVersion === 'string' ? consent.termsVersion : undefined,
    );
  }
  return json(200, {
    sub: ctx.sub,
    role: ctx.role,
    artistId: ctx.artistId ?? null,
    jobTitle: jobTitleFor(ctx.role, profile?.Item?.jobTitle),
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
