import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { projectAiState } from '../ai/state.ts';
import { LOGO_MAX_BYTES, parseLogoDataUrl } from '../address-book/logo.ts';
import { authContext, db, env, handle, HttpError, json, parseBody } from '../lib.ts';

/** Artists' job title is always "Artist" (rev 7); Blueprint people set their own. */
export const ARTIST_JOB_TITLE = 'Artist';
export const profileKey = (sub: string) => ({ PK: `USER#${sub}`, SK: 'PROFILE' });
export const ProfilePatch = z
  .object({
    jobTitle: z.string().trim().max(80, 'Keep the job title under 80 characters').optional(),
    /**
     * Profile picture: a small square image the browser has already cropped and
     * re-encoded (PNG/JPEG/WebP, max 512px), as a data URL. null removes it.
     */
    avatar: z
      .string()
      .max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 64, 'The picture is too large')
      .nullable()
      .optional(),
  })
  .strict()
  .refine((p) => p.jobTitle !== undefined || p.avatar !== undefined, 'Nothing to change');

/** Checks a profile picture data URL and returns it normalised; throws a 400 if it's not a safe image. */
export function checkAvatar(dataUrl: string): string {
  try {
    const { contentType, bytes } = parseLogoDataUrl(dataUrl, 'picture');
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export function jobTitleFor(role: string, stored: unknown): string {
  if (role === 'artist') return ARTIST_JOB_TITLE;
  return typeof stored === 'string' ? stored : '';
}

/**
 * GET /me: who the API thinks you are, your job title, profile picture and
 * latest consent decision. PATCH /me: change your job title (Blueprint people
 * only) and/or your profile picture (everyone).
 */
export const handler = handle(async (event) => {
  const ctx = authContext(event);

  if (event.httpMethod === 'PATCH') {
    const { jobTitle, avatar } = parseBody(event, ProfilePatch);
    if (jobTitle !== undefined && ctx.role === 'artist')
      throw new HttpError(403, `Artists' job title is always "${ARTIST_JOB_TITLE}"`);
    const sets = ['updatedAt = :at', '#type = :type'];
    const removes: string[] = [];
    const values: Record<string, unknown> = {
      ':at': new Date().toISOString(),
      ':type': 'user-profile',
    };
    if (jobTitle !== undefined) {
      sets.push('jobTitle = :t');
      values[':t'] = jobTitle;
    }
    let stored: string | null | undefined;
    if (avatar === null) {
      removes.push('avatar');
      stored = null;
    } else if (avatar !== undefined) {
      stored = checkAvatar(avatar);
      sets.push('avatar = :a');
      values[':a'] = stored;
    }
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: profileKey(ctx.sub),
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: values,
      }),
    );
    return json(200, {
      ...(jobTitle !== undefined ? { jobTitle } : {}),
      ...(stored !== undefined ? { avatar: stored } : {}),
    });
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
    db.send(new GetCommand({ TableName: env('MAIN_TABLE'), Key: profileKey(ctx.sub) })),
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
    jobTitle: jobTitleFor(ctx.role, profile.Item?.jobTitle),
    avatar: typeof profile.Item?.avatar === 'string' ? profile.Item.avatar : null,
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
