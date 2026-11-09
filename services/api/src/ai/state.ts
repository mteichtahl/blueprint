import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { db, env } from '../lib.ts';

/**
 * Records an artist's current AI choice at `ARTIST#id / AI` (design 10.4).
 * An older decision never overwrites a newer one, so retries and out-of-order
 * events are safe.
 */
export async function projectAiState(artistId: string, aiOptIn: boolean, decidedAt: string) {
  if (!/^art_[a-z0-9]{12}$/.test(artistId)) return;
  try {
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: { PK: `ARTIST#${artistId}`, SK: 'AI' },
        UpdateExpression: 'SET aiOptIn = :o, decidedAt = :at, #t = :t',
        ConditionExpression: 'attribute_not_exists(decidedAt) OR decidedAt < :at',
        ExpressionAttributeNames: { '#t': 'type' },
        ExpressionAttributeValues: { ':o': aiOptIn, ':at': decidedAt, ':t': 'aiState' },
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
  }
}
