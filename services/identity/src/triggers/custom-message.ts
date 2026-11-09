import { appOrigin, cognitoEmail } from '@bmg/email';
import type { CustomMessageTriggerHandler } from 'aws-lambda';
import { cognitoMessageKind } from '../claims.ts';
import { logEvent } from '../table.ts';

/**
 * Brands every email Cognito sends (codes, password resets, admin-created
 * accounts) with the BMG layout. Cognito fills in its own placeholders
 * ({####}, {username}) after this returns, so they are passed through as-is.
 * Anything unexpected falls back to Cognito's default message rather than
 * blocking sign-in.
 */
export const handler: CustomMessageTriggerHandler = async (event) => {
  const kind = cognitoMessageKind(event.triggerSource);
  if (!kind) return event;
  try {
    const origin = await appOrigin();
    if (!origin) return event;
    const email = cognitoEmail({ appOrigin: origin }, kind, {
      code: event.request.codeParameter,
      ...(event.request.usernameParameter ? { username: event.request.usernameParameter } : {}),
    });
    event.response.emailSubject = email.subject;
    event.response.emailMessage = email.html;
    logEvent('identity.customMessage', { source: event.triggerSource });
  } catch (err) {
    logEvent('identity.customMessageFallback', { name: (err as Error).name });
  }
  return event;
};
