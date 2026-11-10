import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isArtistId } from '@bmg/crypto';
import { db, env } from '../lib.ts';

/**
 * Records an artist's current AI choice at `ARTIST#id / AI` (design 10.4),
 * and, when known, the terms version they accepted with it (shown on
 * Artists & access). An older decision never overwrites a newer one, so
 * retries and out-of-order events are safe.
 */
export async function projectAiState(
  artistId: string,
  aiOptIn: boolean,
  decidedAt: string,
  termsVersion?: string,
) {
  if (!isArtistId(artistId)) return;
  try {
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: { PK: `ARTIST#${artistId}`, SK: 'AI' },
        UpdateExpression: `SET aiOptIn = :o, decidedAt = :at, #t = :t${
          termsVersion ? ', termsVersion = :tv, termsAcceptedAt = :at' : ''
        }`,
        ConditionExpression: termsVersion
          ? 'attribute_not_exists(decidedAt) OR decidedAt < :at OR (decidedAt = :at AND attribute_not_exists(termsVersion))'
          : 'attribute_not_exists(decidedAt) OR decidedAt < :at',
        ExpressionAttributeNames: { '#t': 'type' },
        ExpressionAttributeValues: {
          ':o': aiOptIn,
          ':at': decidedAt,
          ':t': 'aiState',
          ...(termsVersion ? { ':tv': termsVersion } : {}),
        },
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
  }
}
