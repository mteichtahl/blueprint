import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { db, env, HttpError } from '../lib.ts';

/**
 * Names (rev 22). One name per person, kept where every screen already reads it:
 * - artists: `ARTIST#<id> / PROFILE` (`displayName`, and the roster sort key
 *   `GSI1SK`), with a copy on `ARTIST#<id> / CONTACT` for notifications;
 * - Blueprint people: `USER#<sub> / PROFILE` (`displayName`).
 * Chat sender names, plan owners and document owners are worked out from these
 * when they're read, so a change shows everywhere without rewriting history.
 */

/** Control characters, including the line breaks a name never has. */
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
/** At least one letter or number in any script, so a name can't be only emoji or punctuation. */
const SOMETHING = /[\p{L}\p{N}]/u;

export const NAME_MAX = 100;

export const DisplayName = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, 'Enter a name')
      .max(NAME_MAX, `Keep the name under ${NAME_MAX} characters`)
      .refine((s) => !CONTROL.test(s), 'A name is one line of text')
      .refine((s) => SOMETHING.test(s), 'A name needs at least one letter or number'),
  );

/** The roster's sort key: name first, so Artists & access lists A to Z. */
export const rosterSortKey = (name: string, artistId: string) =>
  `${name.toLowerCase()}#${artistId}`;

const table = () => env('MAIN_TABLE');
const artistProfileKey = (artistId: string) => ({ PK: `ARTIST#${artistId}`, SK: 'PROFILE' });
const userProfileKey = (sub: string) => ({ PK: `USER#${sub}`, SK: 'PROFILE' });

export interface Renamed {
  before: string;
  after: string;
}

/**
 * Renames an artist. Refused for an artist being deleted. The roster sort key
 * only changes while they're on the roster (a deleting artist has none).
 */
export async function renameArtist(artistId: string, name: string): Promise<Renamed> {
  const current = (
    await db.send(new GetCommand({ TableName: table(), Key: artistProfileKey(artistId) }))
  ).Item;
  if (!current) throw new HttpError(404, 'No such artist');
  if (current.status === 'deleting' || current.status === 'deleted')
    throw new HttpError(409, 'This artist is being deleted');
  const before = String(current.displayName ?? '');
  if (before === name) return { before, after: name };
  const now = new Date().toISOString();
  try {
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: artistProfileKey(artistId),
        UpdateExpression: current.GSI1PK
          ? 'SET displayName = :n, GSI1SK = :sk, nameChangedAt = :at'
          : 'SET displayName = :n, nameChangedAt = :at',
        ConditionExpression: 'attribute_exists(PK) AND NOT #s IN (:deleting, :deleted)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':n': name,
          ':at': now,
          ':deleting': 'deleting',
          ':deleted': 'deleted',
          ...(current.GSI1PK ? { ':sk': rosterSortKey(name, artistId) } : {}),
        },
      }),
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException')
      throw new HttpError(409, 'This artist is being deleted');
    throw err;
  }
  // The copy notifications and invitation resends use. Missing for test artists.
  await db
    .send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: `ARTIST#${artistId}`, SK: 'CONTACT' },
        UpdateExpression: 'SET displayName = :n, updatedAt = :at',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':n': name, ':at': now },
      }),
    )
    .catch((err: Error) => {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
    });
  return { before, after: name };
}

/** Renames a Blueprint person (their own profile item). */
export async function renameUser(sub: string, name: string): Promise<Renamed> {
  const current = (await db.send(new GetCommand({ TableName: table(), Key: userProfileKey(sub) })))
    .Item;
  const before = String(current?.displayName ?? '');
  if (before === name) return { before, after: name };
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: userProfileKey(sub),
      UpdateExpression:
        'SET displayName = :n, nameChangedAt = :at, updatedAt = :at, #type = if_not_exists(#type, :type)',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: {
        ':n': name,
        ':at': new Date().toISOString(),
        ':type': 'profile',
      },
    }),
  );
  return { before, after: name };
}

/** The name to show for whoever is signed in: the artist's roster name, or their own profile name. */
export function shownName(
  role: string,
  artistProfile: Record<string, unknown> | undefined,
  userProfile: Record<string, unknown> | undefined,
): string | null {
  const v = role === 'artist' ? artistProfile?.displayName : userProfile?.displayName;
  return typeof v === 'string' && v.trim() ? v : null;
}
