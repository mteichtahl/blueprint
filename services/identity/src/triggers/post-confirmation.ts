import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { profileKey } from '../claims.ts';
import { db, logEvent, mainTable } from '../table.ts';

/** Creates the user's profile record the first time they confirm (design 6.1). */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  const sub = event.request.userAttributes.sub;
  if (!sub) return event;
  try {
    await db.send(
      new PutCommand({
        TableName: mainTable(),
        Item: {
          ...profileKey(sub),
          type: 'profile',
          email: event.request.userAttributes.email,
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
  return event;
};
