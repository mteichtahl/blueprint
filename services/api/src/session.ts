/**
 * Pure rules for the authorizer and step-up (design 6.2, 7.2), unit-tested.
 */

export interface TokenClaims {
  sub: string;
  role?: string;
  artistId?: string;
  mfa_level?: string;
  auth_time?: number;
  origin_jti?: string;
}

export interface StepUpSession {
  verified: boolean;
  /** Epoch seconds. */
  expiresAt: number;
  /** Epoch seconds of the last successful step-up. */
  verifiedAt?: number;
}

const ROLES = new Set(['bmg-admin', 'bmg-staff', 'artist']);

/** Routes a session that still needs step-up may call (design 6.2 step 2). */
export const STEP_UP_ROUTES = ['POST/step-up/totp/setup', 'POST/step-up/totp/verify', 'GET/me'];

export interface SessionState {
  mfaSatisfied: boolean;
  /** Last sign-in, or last step-up for federated sessions. */
  authTime: number;
}

export function sessionState(
  claims: TokenClaims,
  stepUp: StepUpSession | undefined,
  nowSeconds: number,
): SessionState {
  const signedIn = claims.auth_time ?? 0;
  if (claims.mfa_level !== 'federated') return { mfaSatisfied: true, authTime: signedIn };
  const ok = !!stepUp?.verified && stepUp.expiresAt > nowSeconds;
  return {
    mfaSatisfied: ok,
    authTime: ok ? Math.max(signedIn, stepUp?.verifiedAt ?? 0) : signedIn,
  };
}

export function validClaims(claims: TokenClaims): boolean {
  return !!claims.sub && !!claims.role && ROLES.has(claims.role) && !!claims.origin_jti;
}

/** `arn:...:<api>/<stage>/<METHOD>/<path>` → resources the policy allows. */
export function allowedResources(methodArn: string, mfaSatisfied: boolean): string[] {
  const prefix = methodArn.split('/').slice(0, 2).join('/');
  if (mfaSatisfied) return [`${prefix}/*/*`];
  return STEP_UP_ROUTES.map((r) => {
    const [method, ...path] = r.split('/');
    return `${prefix}/${method}/${path.join('/')}`;
  });
}

/** TOTP step-up attempts allowed before the session is locked (design 13.3). */
export const MAX_STEP_UP_FAILURES = 5;
/** A verified step-up lasts for the session, up to 12 hours. */
export const STEP_UP_LIFETIME_SECONDS = 12 * 3600;
