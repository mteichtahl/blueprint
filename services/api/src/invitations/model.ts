/**
 * Artist invitations (onboarding): where each one stands. An invitation is
 * accepted the first time the artist signs in, which Cognito records by moving
 * the user out of FORCE_CHANGE_PASSWORD (a temporary password replaced) or by a
 * federated sign-in (EXTERNAL_PROVIDER).
 */
export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'revoked';

export interface InviteItem {
  artistId?: string;
  displayName?: string;
  status?: 'pending' | 'accepted' | 'revoked';
  /** Epoch seconds. */
  expiresAt?: number;
  createdAt?: string;
  invitedBy?: string;
  lastSentAt?: string;
  acceptedAt?: string;
  revokedAt?: string;
}

export interface CognitoState {
  /** Cognito UserStatus: FORCE_CHANGE_PASSWORD, CONFIRMED, EXTERNAL_PROVIDER… */
  userStatus?: string;
  enabled?: boolean;
  /** When Cognito last changed the user (first sign-in, for an accepted invite). */
  lastModified?: string;
}

/** True once the artist has signed in for the first time. */
export function hasSignedIn(c: CognitoState | undefined): boolean {
  return !!c?.userStatus && c.userStatus !== 'FORCE_CHANGE_PASSWORD' && c.userStatus !== 'UNKNOWN';
}

export function invitationStatus(
  invite: InviteItem | undefined,
  cognito: CognitoState | undefined,
  nowSeconds: number,
): InvitationStatus {
  // Signing in wins: an accepted invitation stays accepted.
  if (invite?.status === 'accepted' || hasSignedIn(cognito)) return 'accepted';
  if (invite?.status === 'revoked') return 'revoked';
  if ((invite?.expiresAt ?? 0) <= nowSeconds) return 'expired';
  return 'pending';
}

/** What an admin may do with an invitation in each state. */
export function invitationActions(status: InvitationStatus): { resend: boolean; revoke: boolean } {
  return {
    resend: status !== 'accepted',
    revoke: status === 'pending' || status === 'expired',
  };
}

/** Refusals, in plain words, for a resend or revoke that doesn't fit the state. */
export function refusal(action: 'resend' | 'revoke', status: InvitationStatus): string | undefined {
  if (status === 'accepted') {
    return action === 'resend'
      ? 'This artist has already signed in'
      : 'This artist has already signed in, so there is no invitation to revoke';
  }
  if (action === 'revoke' && status === 'revoked') return 'This invitation is already revoked';
  return undefined;
}

/** Newest first, with invitations still waiting at the top. */
const ORDER: Record<InvitationStatus, number> = { pending: 0, expired: 1, revoked: 2, accepted: 3 };
export function byStatusThenNewest<
  T extends { status: InvitationStatus; invitedAt: string | null },
>(a: T, b: T): number {
  return ORDER[a.status] - ORDER[b.status] || (b.invitedAt ?? '').localeCompare(a.invitedAt ?? '');
}
