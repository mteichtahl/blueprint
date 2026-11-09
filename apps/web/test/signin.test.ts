import { describe, expect, it } from 'vitest';
import { friendlyError, otpauthUri, toStep } from '../src/lib/cognito.ts';
import { fromB64url, requestOptions, toB64url } from '../src/lib/webauthn.ts';
import { passwordProblems } from '../src/pages/SignIn.tsx';

describe('sign-in steps from Cognito', () => {
  it('offers a passkey only when the account has one', () => {
    expect(
      toStep({
        ChallengeName: 'SELECT_CHALLENGE',
        Session: 's',
        AvailableChallenges: ['PASSWORD', 'PASSWORD_SRP', 'WEB_AUTHN'],
      }),
    ).toEqual({ kind: 'choose', session: 's', passkey: true, password: true });
    expect(
      toStep({
        ChallengeName: 'SELECT_CHALLENGE',
        Session: 's',
        AvailableChallenges: ['PASSWORD'],
      }),
    ).toMatchObject({ passkey: false, password: true });
  });

  it('maps each challenge to a screen, and tokens to done', () => {
    expect(toStep({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' }).kind).toBe(
      'newPassword',
    );
    expect(toStep({ ChallengeName: 'MFA_SETUP', Session: 's' }).kind).toBe('mfaSetup');
    expect(toStep({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 's' }).kind).toBe('mfaCode');
    expect(
      toStep({
        ChallengeName: 'WEB_AUTHN',
        Session: 's',
        ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: '{"challenge":"AA"}' },
      }),
    ).toEqual({ kind: 'passkey', session: 's', options: '{"challenge":"AA"}' });
    const tokens = { AccessToken: 'a', IdToken: 'i', RefreshToken: 'r', ExpiresIn: 900 };
    expect(toStep({ AuthenticationResult: tokens })).toEqual({ kind: 'done', tokens });
    expect(() => toStep({ ChallengeName: 'SMS_MFA' })).toThrow(/doesn’t support/);
  });

  it('turns Cognito errors into plain words without saying whether an account exists', () => {
    const wrong = friendlyError('NotAuthorizedException', 'Incorrect username or password.');
    expect(wrong).toBe(friendlyError('UserNotFoundException', 'User does not exist.'));
    expect(
      friendlyError('NotAuthorizedException', 'Invalid session for the user, session is expired.'),
    ).toMatch(/start again/);
    expect(friendlyError('CodeMismatchException', '')).toMatch(/code isn’t right/);
  });

  it('builds an authenticator link for the user', () => {
    expect(otpauthUri('ABCD', 'chloe@example.com')).toBe(
      'otpauth://totp/Blueprint%3Achloe%40example.com?secret=ABCD&issuer=Blueprint',
    );
  });
});

describe('passwords', () => {
  it('match the user pool rules', () => {
    expect(passwordProblems('short')).toContain('at least 12 characters');
    expect(passwordProblems('alllowercase123!')).toEqual(['an upper-case letter']);
    expect(passwordProblems('Good-Password-2026')).toEqual([]);
  });
});

describe('passkey encoding', () => {
  it('round-trips base64url', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(new Uint8Array(fromB64url(toB64url(bytes)))).toEqual(bytes);
    expect(toB64url(bytes)).not.toMatch(/[+/=]/);
  });

  it('decodes the challenge and allowed credentials', () => {
    const o = requestOptions({
      challenge: 'AQID',
      rpId: 'app.example',
      allowCredentials: [{ type: 'public-key', id: 'BAUG' }],
    });
    expect(new Uint8Array(o.challenge as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(o.rpId).toBe('app.example');
    expect(new Uint8Array(o.allowCredentials![0]!.id as ArrayBuffer)).toEqual(
      new Uint8Array([4, 5, 6]),
    );
  });
});
