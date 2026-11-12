import {
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { PreSignUpTriggerHandler } from 'aws-lambda';
import {
  inviteKey,
  LINKED_MARKER,
  linkTarget,
  providerOf,
  signUpAllowed,
  type Invite,
} from '../claims.ts';
import { db, logEvent, mainTable } from '../table.ts';

const cognito = new CognitoIdentityProviderClient({});

/**
 * Refuses any sign-up that doesn't come from an invite (design 6.1).
 *
 * A first Google, Apple or Facebook sign-in (design D2) is linked to the
 * person's own Blueprint account with the same verified email, so from then
 * on it signs in as that account (its group, artist id and data). Cognito
 * still tries to make a separate user on that first attempt, so the link is
 * made and the attempt stopped with a marker; the app sees the marker and
 * signs in again at once, as the linked account. With no account to join,
 * the invite rule applies, as before.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const source = event.triggerSource;
  let invite: Invite | undefined;
  if (source === 'PreSignUp_ExternalProvider') {
    const email = event.request.userAttributes.email?.trim().toLowerCase();
    const social = providerOf(event.userName);
    if (email && social) {
      const found = await cognito.send(
        new ListUsersCommand({
          UserPoolId: event.userPoolId,
          Filter: `email = "${email.replace(/["\\]/g, '')}"`,
          Limit: 10,
        }),
      );
      const target = linkTarget(
        found.Users ?? [],
        social.provider,
        event.request.userAttributes.email_verified,
      );
      if (target) {
        await cognito.send(
          new AdminLinkProviderForUserCommand({
            UserPoolId: event.userPoolId,
            DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: target },
            SourceUser: {
              ProviderName: social.provider,
              ProviderAttributeName: 'Cognito_Subject',
              ProviderAttributeValue: social.id,
            },
          }),
        );
        logEvent('identity.preSignUp', { source, linked: true, provider: social.provider });
        throw new Error(`${LINKED_MARKER}: your account is linked; sign in again.`);
      }
    }
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
