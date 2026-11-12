import {
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
 * Nobody signs themselves up (design 6.1): only Blueprint's invite flow makes
 * accounts.
 *
 * A Google, Apple or Facebook sign-in (design D2) is allowed only for someone
 * Blueprint invited: its first use is linked to their account (same email,
 * verified; or an invited artist whose invitation is still live), so from then
 * on it signs in as that account (its group, artist id and data). Cognito
 * still tries to make a separate user on that first attempt, so the link is
 * made and the attempt stopped with a marker; the app sees the marker and
 * signs in again at once, as the linked account. With no invited account to
 * join, it's refused: a social sign-in never makes an account.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const source = event.triggerSource;
  if (source === 'PreSignUp_ExternalProvider') {
    const email = event.request.userAttributes.email?.trim().toLowerCase();
    const social = providerOf(event.userName);
    if (email && social) {
      const [found, inv] = await Promise.all([
        cognito.send(
          new ListUsersCommand({
            UserPoolId: event.userPoolId,
            Filter: `email = "${email.replace(/["\\]/g, '')}"`,
            Limit: 10,
          }),
        ),
        db.send(new GetCommand({ TableName: mainTable(), Key: inviteKey(email) })),
      ]);
      const invite = inv.Item as Invite | undefined;
      const users = found.Users ?? [];
      const target = linkTarget(
        users,
        social.provider,
        event.request.userAttributes.email_verified,
        invite,
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
        // An invited artist who never set a password has still accepted
        // (Invite artist → Invitations shows them as accepted).
        const joined = users.find((u) => u.Username === target);
        if (joined?.UserStatus === 'FORCE_CHANGE_PASSWORD' && invite?.status === 'pending') {
          await db
            .send(
              new UpdateCommand({
                TableName: mainTable(),
                Key: inviteKey(email),
                UpdateExpression: 'SET #s = :a, acceptedAt = :at',
                ConditionExpression: '#s = :p',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: {
                  ':a': 'accepted',
                  ':p': 'pending',
                  ':at': new Date().toISOString(),
                },
              }),
            )
            .catch(() => undefined);
        }
        logEvent('identity.preSignUp', { source, linked: true, provider: social.provider });
        throw new Error(`${LINKED_MARKER}: your account is linked; sign in again.`);
      }
    }
  }
  const allowed = signUpAllowed(source);
  logEvent('identity.preSignUp', { source, allowed });
  if (!allowed) throw new Error('Sign-up is by invitation only.');
  return event;
};
