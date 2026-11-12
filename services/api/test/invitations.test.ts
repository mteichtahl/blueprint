import { describe, expect, it } from 'vitest';
import {
  byStatusThenNewest,
  hasSignedIn,
  invitationActions,
  invitationStatus,
  refusal,
} from '../src/invitations/model.ts';

const NOW = 1_800_000_000;
const pending = { status: 'pending' as const, expiresAt: NOW + 3600 };

describe('invitation status', () => {
  it('is accepted once the artist has signed in for the first time', () => {
    expect(hasSignedIn({ userStatus: 'FORCE_CHANGE_PASSWORD' })).toBe(false);
    expect(hasSignedIn({ userStatus: 'CONFIRMED' })).toBe(true);
    expect(hasSignedIn({ userStatus: 'EXTERNAL_PROVIDER' })).toBe(true);
    expect(invitationStatus(pending, { userStatus: 'CONFIRMED' }, NOW)).toBe('accepted');
    // Recorded as accepted: stays accepted.
    expect(invitationStatus({ status: 'accepted', expiresAt: 0 }, undefined, NOW)).toBe(
      'accepted',
    );
  });

  it('is pending until it expires, and revoked when revoked', () => {
    const waiting = { userStatus: 'FORCE_CHANGE_PASSWORD' };
    expect(invitationStatus(pending, waiting, NOW)).toBe('pending');
    expect(invitationStatus({ ...pending, expiresAt: NOW - 1 }, waiting, NOW)).toBe('expired');
    expect(invitationStatus({ ...pending, status: 'revoked' }, waiting, NOW)).toBe('revoked');
  });

  it('offers resend until accepted, and revoke only while it can still be used', () => {
    expect(invitationActions('pending')).toEqual({ resend: true, revoke: true });
    expect(invitationActions('expired')).toEqual({ resend: true, revoke: true });
    expect(invitationActions('revoked')).toEqual({ resend: true, revoke: false });
    expect(invitationActions('accepted')).toEqual({ resend: false, revoke: false });
    expect(refusal('resend', 'accepted')).toMatch(/already signed in/);
    expect(refusal('revoke', 'revoked')).toMatch(/already revoked/);
    expect(refusal('resend', 'revoked')).toBeUndefined();
  });

  it('lists invitations still waiting first, newest first', () => {
    const rows = [
      { status: 'accepted' as const, invitedAt: '2026-11-12' },
      { status: 'pending' as const, invitedAt: '2026-11-01' },
      { status: 'pending' as const, invitedAt: '2026-11-10' },
      { status: 'revoked' as const, invitedAt: '2026-11-11' },
    ].sort(byStatusThenNewest);
    expect(rows.map((r) => `${r.status} ${r.invitedAt}`)).toEqual([
      'pending 2026-11-10',
      'pending 2026-11-01',
      'revoked 2026-11-11',
      'accepted 2026-11-12',
    ]);
  });
});
