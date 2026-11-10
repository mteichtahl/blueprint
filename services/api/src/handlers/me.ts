import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { projectAiState } from '../ai/state.ts';
import { LOGO_MAX_BYTES, parseLogoDataUrl } from '../address-book/logo.ts';
import { authContext, db, env, handle, HttpError, json, parseBody } from '../lib.ts';

/** Artists' job title is always "Artist" (rev 7); Blueprint people set their own. */
export const ARTIST_JOB_TITLE = 'Artist';
export const profileKey = (sub: string) => ({ PK: `USER#${sub}`, SK: 'PROFILE' });
/**
 * An artist's profile picture, copied from their own USER#<sub> profile so that
 * screens which only know the artist (rosters, chats, workspaces) can show it.
 * Its own item, so artist lists never carry the image.
 */
export const artistAvatarKey = (artistId: string) => ({ PK: `ARTIST#${artistId}`, SK: 'AVATAR' });

/** Most people one GET /avatars call looks up (each list). */
export const AVATAR_BATCH = 50;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** "a,b,c" from the query string: unique, well-formed ids only, at most AVATAR_BATCH. */
export function avatarIds(raw: string | undefined | null): string[] {
  const ids = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length > AVATAR_BATCH)
    throw new HttpError(400, `Ask for at most ${AVATAR_BATCH} pictures at a time`);
  if (ids.some((x) => !ID.test(x))) throw new HttpError(400, 'Not a valid id');
  return ids;
}

async function batchAvatars(keys: { PK: string; SK: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 100) {
    let request: Record<string, { Keys: Record<string, unknown>[]; ProjectionExpression: string }> =
      {
        [env('MAIN_TABLE')]: { Keys: keys.slice(i, i + 100), ProjectionExpression: 'PK, avatar' },
      };
    for (let tries = 0; tries < 4 && Object.keys(request).length; tries++) {
      const res = await db.send(new BatchGetCommand({ RequestItems: request }));
      for (const item of res.Responses?.[env('MAIN_TABLE')] ?? [])
        if (typeof item.avatar === 'string') out.set(String(item.PK), item.avatar);
      request = (res.UnprocessedKeys ?? {}) as typeof request;
    }
  }
  return out;
}
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

  // GET /avatars?artists=a,b&users=s1,s2: profile pictures for the people on a
  // screen. Missing ones are left out; the app shows initials for those.
  if (
    event.httpMethod === 'GET' &&
    (event.resource === '/avatars' || /\/avatars$/.test(event.path ?? ''))
  ) {
    const artists = avatarIds(event.queryStringParameters?.artists);
    const users = avatarIds(event.queryStringParameters?.users);
    const found = await batchAvatars([
      ...artists.map(artistAvatarKey),
      ...users.map((sub) => profileKey(sub)),
    ]);
    const pick = (ids: string[], pk: (id: string) => string) =>
      Object.fromEntries(
        ids.flatMap((id) => (found.has(pk(id)) ? [[id, found.get(pk(id))!]] : [])),
      );
    return json(200, {
      artists: pick(artists, (id) => `ARTIST#${id}`),
      users: pick(users, (sub) => `USER#${sub}`),
    });
  }

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
    if (stored !== undefined && ctx.artistId) await mirrorArtistAvatar(ctx.artistId, stored);
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
  const avatar = typeof profile.Item?.avatar === 'string' ? profile.Item.avatar : null;
  // Pictures saved before artists' copies existed are copied the next time the artist opens the app.
  if (ctx.artistId && avatar) await mirrorArtistAvatar(ctx.artistId, avatar, true);
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
    avatar,
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

/**
 * Keeps ARTIST#<id> / AVATAR in step with the artist's own picture (null removes it).
 * onlyIfChanged skips the write when the copy is already the same.
 */
async function mirrorArtistAvatar(artistId: string, avatar: string | null, onlyIfChanged = false) {
  try {
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: artistAvatarKey(artistId),
        ...(avatar === null
          ? {
              UpdateExpression: 'REMOVE avatar SET updatedAt = :at',
              ExpressionAttributeValues: { ':at': new Date().toISOString() },
            }
          : {
              UpdateExpression: 'SET avatar = :a, updatedAt = :at, #type = :type',
              ExpressionAttributeNames: { '#type': 'type' },
              ExpressionAttributeValues: {
                ':a': avatar,
                ':at': new Date().toISOString(),
                ':type': 'artist-avatar',
              },
              ...(onlyIfChanged
                ? { ConditionExpression: 'attribute_not_exists(avatar) OR avatar <> :a' }
                : {}),
            }),
      }),
    );
  } catch (e) {
    if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
  }
}
