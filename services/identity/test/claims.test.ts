import { describe, expect, it } from 'vitest';
import {
  linkTarget,
  providerOf,
  buildClaims,
  ClaimsError,
  inviteKey,
  roleFromGroups,
  signUpAllowed,
} from '../src/claims.ts';

describe('roleFromGroups', () => {
  it('picks the highest-privilege group', () => {
    expect(roleFromGroups(['artist', 'bmg-staff'])).toBe('bmg-staff');
    expect(roleFromGroups(['bmg-admin', 'artist'])).toBe('bmg-admin');
    expect(roleFromGroups(['artist'])).toBe('artist');
    expect(roleFromGroups(['other'])).toBeUndefined();
  });
});

describe('buildClaims', () => {
  it('gives artists their artistId and Cognito MFA level', () => {
    expect(buildClaims({ groups: ['artist'], artistId: 'art_0123456789ab' })).toEqual({
      role: 'artist',
      mfa_level: 'cognito',
      artistId: 'art_0123456789ab',
    });
  });

  it('marks federated sign-ins so the API can require step-up', () => {
    const claims = buildClaims({
      groups: ['artist'],
      artistId: 'art_0123456789ab',
      identities: '[{"providerName":"Google"}]',
    });
    expect(claims.mfa_level).toBe('federated');
  });

  it('refuses an artist without a valid artistId', () => {
    expect(() => buildClaims({ groups: ['artist'] })).toThrow(ClaimsError);
    expect(() => buildClaims({ groups: ['artist'], artistId: '../other' })).toThrow(ClaimsError);
  });

  it('refuses accounts with no BMG group', () => {
    expect(() => buildClaims({ groups: [] })).toThrow(ClaimsError);
  });

  it('never gives staff an artistId claim', () => {
    expect(buildClaims({ groups: ['bmg-staff'], artistId: 'art_0123456789ab' })).toEqual({
      role: 'bmg-staff',
      mfa_level: 'cognito',
    });
  });
});

describe('signUpAllowed (nobody signs themselves up)', () => {
  it('allows only accounts Blueprint makes with the invite flow', () => {
    expect(signUpAllowed('PreSignUp_AdminCreateUser')).toBe(true);
  });

  it('never lets a social sign-in, or anyone, make their own account', () => {
    expect(signUpAllowed('PreSignUp_ExternalProvider')).toBe(false);
    expect(signUpAllowed('PreSignUp_SignUp')).toBe(false);
  });
});

describe('keys', () => {
  it('matches invites case-insensitively', () => {
    expect(inviteKey(' Kyra@BlueprintMusic.Group ')).toEqual({
      PK: 'INVITE#kyra@blueprintmusic.group',
      SK: 'INVITE',
    });
  });
});

describe('cognitoMessageKind', () => {
  it('brands every email trigger', async () => {
    const { cognitoMessageKind } = await import('../src/claims.ts');
    expect(cognitoMessageKind('CustomMessage_AdminCreateUser')).toBe('admin-create-user');
    expect(cognitoMessageKind('CustomMessage_ResendCode')).toBe('verification-code');
    expect(cognitoMessageKind('CustomMessage_ForgotPassword')).toBe('forgot-password');
    expect(cognitoMessageKind('CustomMessage_VerifyUserAttribute')).toBe('attribute-verification');
    expect(cognitoMessageKind('CustomMessage_Authentication')).toBeUndefined();
  });
});

describe('social sign-in joins the person’s own account (design D2)', () => {
  const user = (Username: string, over: Record<string, unknown> = {}, verified = 'true') => ({
    Username,
    Enabled: true,
    UserStatus: 'CONFIRMED',
    Attributes: [{ Name: 'email_verified', Value: verified }],
    ...over,
  });

  it('reads the provider from Cognito’s user name', () => {
    expect(providerOf('Google_1234')).toEqual({ provider: 'Google', id: '1234' });
    expect(providerOf('SignInWithApple_00.ab_c')).toEqual({
      provider: 'SignInWithApple',
      id: '00.ab_c',
    });
    expect(providerOf('3f0e-uuid')).toBeUndefined();
  });

  it('links to the one enabled account with a verified email', () => {
    expect(linkTarget([user('u1')], 'Google', 'true')).toBe('u1');
    // An invited artist who hasn't set a password yet joins, while the invitation is live.
    const invited = [user('u2', { UserStatus: 'FORCE_CHANGE_PASSWORD' }, 'false')];
    const now = 1_800_000_000;
    expect(
      linkTarget(invited, 'Google', 'true', { status: 'pending', expiresAt: now + 60 }, now),
    ).toBe('u2');
    expect(
      linkTarget(invited, 'Google', 'true', { status: 'pending', expiresAt: now - 1 }, now),
    ).toBeUndefined();
    expect(
      linkTarget(invited, 'Google', 'true', { status: 'revoked', expiresAt: now + 60 }, now),
    ).toBeUndefined();
    expect(linkTarget(invited, 'Google', 'true', undefined, now)).toBeUndefined();
    // Facebook only gives verified addresses.
    expect(linkTarget([user('u1')], 'Facebook', undefined)).toBe('u1');
  });

  it('never links an unverified social email, a turned-off account, another social user, or two matches', () => {
    expect(linkTarget([user('u1')], 'Google', 'false')).toBeUndefined();
    expect(linkTarget([user('u1', { Enabled: false })], 'Google', 'true')).toBeUndefined();
    expect(
      linkTarget([user('Facebook_9', { UserStatus: 'EXTERNAL_PROVIDER' })], 'Google', 'true'),
    ).toBeUndefined();
    expect(linkTarget([user('u1', {}, 'false')], 'Google', 'true')).toBeUndefined();
    expect(linkTarget([user('u1'), user('u2')], 'Google', 'true')).toBeUndefined();
  });
});
