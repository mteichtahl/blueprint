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

// ── Enrolling and checking the app authenticator (security review M2) ──────

/** Wrong codes allowed per person in an hour, across every sign-in session. */
export const MAX_STEP_UP_FAILURES_PER_HOUR = 5;
const FAIL_WINDOW_SECONDS = 3600;
/** TOTP time step. */
export const TOTP_PERIOD_SECONDS = 30;

/** What the app keeps about a person's app authenticator (`USER#<sub> / TOTP`). */
export interface TotpRecord {
  sealedSecret?: string;
  confirmed?: boolean;
  /** Wrong codes in the current window, and when the window started (epoch seconds). */
  failures?: number;
  failWindowStart?: number;
  /** The newest TOTP time step accepted, so a code can't be used twice. */
  lastStep?: number;
}

/**
 * Whether a social sign-in may add the first app authenticator (security
 * review M2). Only for an account that has never signed in any other way: an
 * invited artist who joined with Google and never set a password
 * (`FORCE_CHANGE_PASSWORD`). Anyone with their own password or passkey adds it
 * from that sign-in instead, so a hijacked social account alone can't enrol
 * an attacker's authenticator and skip their real second factor.
 */
export function federatedEnrolAllowed(nativeUserStatus: string | undefined): boolean {
  return nativeUserStatus === 'FORCE_CHANGE_PASSWORD';
}

/** True while this person has used up their wrong codes for the hour. */
export function totpLocked(
  rec: Pick<TotpRecord, 'failures' | 'failWindowStart'> | undefined,
  nowSeconds: number,
): boolean {
  return (
    (rec?.failures ?? 0) >= MAX_STEP_UP_FAILURES_PER_HOUR &&
    !!rec?.failWindowStart &&
    nowSeconds - rec.failWindowStart < FAIL_WINDOW_SECONDS
  );
}

/** Failure count after one more wrong code (a new window once the hour is up). */
export function afterFailure(
  rec: Pick<TotpRecord, 'failures' | 'failWindowStart'> | undefined,
  nowSeconds: number,
): { failures: number; failWindowStart: number } {
  const fresh = !rec?.failWindowStart || nowSeconds - rec.failWindowStart >= FAIL_WINDOW_SECONDS;
  return fresh
    ? { failures: 1, failWindowStart: nowSeconds }
    : { failures: (rec.failures ?? 0) + 1, failWindowStart: rec.failWindowStart! };
}

/** The TOTP time step a matched code belongs to (`delta` from otpauth's validate). */
export function totpStep(nowSeconds: number, delta: number): number {
  return Math.floor(nowSeconds / TOTP_PERIOD_SECONDS) + delta;
}

/** A code is accepted once: only a step newer than the last one used. */
export function freshStep(lastStep: number | undefined, step: number): boolean {
  return lastStep === undefined || step > lastStep;
}
