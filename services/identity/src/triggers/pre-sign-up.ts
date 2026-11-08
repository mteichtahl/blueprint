import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { PreSignUpTriggerHandler } from 'aws-lambda';
import { inviteKey, signUpAllowed, type Invite } from '../claims.ts';
import { db, logEvent, mainTable } from '../table.ts';

/** Refuses any sign-up that doesn't come from an invite (design 6.1). */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const source = event.triggerSource;
  let invite: Invite | undefined;
  if (source === 'PreSignUp_ExternalProvider') {
    const email = event.request.userAttributes.email;
    if (email) {
      const res = await db.send(new GetCommand({ TableName: mainTable(), Key: inviteKey(email) }));
      invite = res.Item as Invite | undefined;
    }
  }
  const allowed = signUpAllowed(source, invite, Math.floor(Date.now() / 1000));
  logEvent('identity.preSignUp', { source, allowed });
  if (!allowed) throw new Error('Sign-up is by invitation only.');
  return event;
};
