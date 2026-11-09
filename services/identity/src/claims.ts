/**
 * Pure rules for the Cognito triggers (design 6.1 and 6.2), kept free of AWS
 * calls so they are unit-tested directly.
 */

export const ROLES = ['bmg-admin', 'bmg-staff', 'artist'] as const;
export type Role = (typeof ROLES)[number];

/**
 * How the session's second factor is known:
 * - `cognito`: Cognito enforced MFA (TOTP, or a passkey with user verification).
 * - `federated`: Google/Apple/Facebook sign-in. Cognito applies no MFA, so the
 *   API refuses everything but the step-up endpoints until the app verifies it.
 */
export type MfaLevel = 'cognito' | 'federated';

/** Highest-privilege group wins, so a user in two groups never gets a mixed role. */
export function roleFromGroups(groups: readonly string[]): Role | undefined {
  return ROLES.find((r) => groups.includes(r));
}

export interface ClaimsInput {
  groups: readonly string[];
  /** `custom:artistId`, set only by the invite flow. */
  artistId?: string | undefined;
  /** Cognito's `identities` attribute, present only for federated users. */
  identities?: string | undefined;
}

export interface BmgClaims {
  role: Role;
  mfa_level: MfaLevel;
  artistId?: string;
}

export class ClaimsError extends Error {}

const ARTIST_ID = /^art_[a-z0-9]{10,32}$/;

/**
 * The claims added to both the ID and access tokens. Throws (which makes
 * Cognito refuse the sign-in) when the account is not in a valid state.
 */
export function buildClaims(input: ClaimsInput): BmgClaims {
  const role = roleFromGroups(input.groups);
  if (!role) throw new ClaimsError('Account has no BMG role');
  const mfa_level: MfaLevel = input.identities ? 'federated' : 'cognito';
  if (role === 'artist') {
    if (!input.artistId || !ARTIST_ID.test(input.artistId)) {
      throw new ClaimsError('Artist account is missing its artist id');
    }
    return { role, mfa_level, artistId: input.artistId };
  }
  // Staff never carry an artistId claim: their access comes from assignments, checked by authz.
  return { role, mfa_level };
}

export type SignUpSource =
  'PreSignUp_AdminCreateUser' | 'PreSignUp_ExternalProvider' | 'PreSignUp_SignUp' | string;

export interface Invite {
  status: 'pending' | 'accepted' | 'revoked';
  /** Epoch seconds. */
  expiresAt: number;
}

/**
 * Invite-only sign-up (design 6.1). Admin-created users come from the invite
 * flow itself. A first federated sign-in needs a pending, unexpired invite for
 * the same email. Anything else is refused.
 */
export function signUpAllowed(
  source: SignUpSource,
  invite: Invite | undefined,
  nowSeconds: number,
): boolean {
  if (source === 'PreSignUp_AdminCreateUser') return true;
  if (source === 'PreSignUp_ExternalProvider') {
    return !!invite && invite.status === 'pending' && invite.expiresAt > nowSeconds;
  }
  return false;
}

/** Key of the invite item in the main table. Emails are matched case-insensitively. */
export function inviteKey(email: string): { PK: string; SK: string } {
  return { PK: `INVITE#${email.trim().toLowerCase()}`, SK: 'INVITE' };
}

/** Key of the user profile item in the main table. */
export function profileKey(sub: string): { PK: string; SK: string } {
  return { PK: `USER#${sub}`, SK: 'PROFILE' };
}

/**
 * Where notifications find an artist's email (`ARTIST#<id>` / `CONTACT`). The
 * roster item stays free of email, and this item is on no index.
 */
export function contactKey(artistId: string): { PK: string; SK: string } {
  return { PK: `ARTIST#${artistId}`, SK: 'CONTACT' };
}

/** Which branded email replaces a Cognito message; undefined keeps Cognito's own (e.g. SMS). */
export function cognitoMessageKind(
  triggerSource: string,
):
  | 'admin-create-user'
  | 'verification-code'
  | 'forgot-password'
  | 'attribute-verification'
  | undefined {
  switch (triggerSource) {
    case 'CustomMessage_AdminCreateUser':
      return 'admin-create-user';
    case 'CustomMessage_SignUp':
    case 'CustomMessage_ResendCode':
      return 'verification-code';
    case 'CustomMessage_ForgotPassword':
      return 'forgot-password';
    case 'CustomMessage_UpdateUserAttribute':
    case 'CustomMessage_VerifyUserAttribute':
      return 'attribute-verification';
    default:
      return undefined;
  }
}
