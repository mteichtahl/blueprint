import type { PreTokenGenerationV2TriggerHandler } from 'aws-lambda';
import { buildClaims, ClaimsError } from '../claims.ts';
import { logEvent } from '../table.ts';

/**
 * Pre token generation V2 (design 6.1): adds `role`, `artistId` and `mfa_level`
 * to the ID and access tokens. Throwing refuses the sign-in.
 */
export const handler: PreTokenGenerationV2TriggerHandler = async (event) => {
  const attrs = event.request.userAttributes;
  try {
    const claims = buildClaims({
      groups: event.request.groupConfiguration.groupsToOverride ?? [],
      artistId: attrs['custom:artistId'],
      identities: attrs.identities,
    });
    const claimsToAddOrOverride: Record<string, string> = {
      role: claims.role,
      mfa_level: claims.mfa_level,
      ...(claims.artistId ? { artistId: claims.artistId } : {}),
    };
    event.response = {
      claimsAndScopeOverrideDetails: {
        idTokenGeneration: { claimsToAddOrOverride },
        accessTokenGeneration: { claimsToAddOrOverride },
      },
    };
    logEvent('identity.tokenIssued', { role: claims.role, mfaLevel: claims.mfa_level });
    return event;
  } catch (err) {
    if (err instanceof ClaimsError) {
      logEvent('identity.tokenRefused', { reason: err.message });
      throw new Error('This account is not set up yet. Contact Blueprint.', { cause: err });
    }
    throw err;
  }
};
