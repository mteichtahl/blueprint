import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { contactKey, profileKey } from '../claims.ts';
import { db, logEvent, mainTable } from '../table.ts';

const ARTIST_ID = /^art_[a-z0-9]{10,32}$/;

/**
 * Creates the user's profile record the first time they confirm (design 6.1),
 * and for artists keeps the contact record notifications use up to date.
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  const attrs = event.request.userAttributes;
  const sub = attrs.sub;
  if (!sub) return event;
  try {
    await db.send(
      new PutCommand({
        TableName: mainTable(),
        Item: {
          ...profileKey(sub),
          type: 'profile',
          email: attrs.email,
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    logEvent('identity.profileCreated', { source: event.triggerSource });
  } catch (err) {
    // Already there (e.g. a forgotten-password confirmation): nothing to do.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
  const artistId = attrs['custom:artistId'];
  if (artistId && ARTIST_ID.test(artistId) && attrs.email) {
    // Merge: the invite may have written it first.
    await db.send(
      new UpdateCommand({
        TableName: mainTable(),
        Key: contactKey(artistId),
        UpdateExpression: 'SET #t = :t, artistId = :a, email = :e, #sub = :s, updatedAt = :at',
        ExpressionAttributeNames: { '#t': 'type', '#sub': 'sub' },
        ExpressionAttributeValues: {
          ':t': 'artistContact',
          ':a': artistId,
          ':e': attrs.email.toLowerCase(),
          ':s': sub,
          ':at': new Date().toISOString(),
        },
      }),
    );
  }
  return event;
};
