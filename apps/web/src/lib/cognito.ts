import type { AppConfig } from './config.ts';

/**
 * Cognito's public user-pool API, called straight from the app (no hosted UI).
 * These operations need no AWS credentials: an app client id, a session from
 * the previous step, or the user's own access token. The client has no secret.
 */

export class CognitoError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'CognitoError';
  }
}

export async function cognito<T = Record<string, unknown>>(
  cfg: Pick<AppConfig, 'region'>,
  operation: string,
  body: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CognitoError(
      'NetworkError',
      'Can’t reach the sign-in service. Check your connection.',
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const type = String(data.__type ?? 'Error')
      .split('#')
      .pop()!;
    throw new CognitoError(type, friendlyError(type, String(data.message ?? '')));
  }
  return data as T;
}

/** Cognito's messages are written for developers; these are for people. */
export function friendlyError(type: string, message: string): string {
  switch (type) {
    case 'NotAuthorizedException':
      if (/session is expired|Invalid session/i.test(message)) {
        return 'That took a little too long. Please start again.';
      }
      if (/attempts exceeded/i.test(message)) {
        return 'Too many attempts. Wait a few minutes, then try again.';
      }
      if (/Refresh Token/i.test(message)) return 'Your session has ended. Please sign in again.';
      return 'That email and password don’t match. Try again, or reset your password.';
    case 'UserNotFoundException':
      return 'That email and password don’t match. Try again, or reset your password.';
    case 'CodeMismatchException':
    case 'EnableSoftwareTokenMFAException':
      return 'That code isn’t right. Check your authenticator and try again.';
    case 'ExpiredCodeException':
      return 'That code has expired. Ask for a new one.';
    case 'InvalidPasswordException':
      return 'That password doesn’t meet the rules: at least 12 characters, with upper and lower case letters, a number and a symbol.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return 'Too many attempts. Wait a few minutes, then try again.';
    case 'PasswordResetRequiredException':
      return 'You need to reset your password. Use “Forgot your password?”.';
    case 'UserNotConfirmedException':
      return 'Your account isn’t active yet. Ask Blueprint to resend your invitation.';
    case 'WebAuthnNotEnabledException':
    case 'WebAuthnConfigurationMissingException':
    case 'WebAuthnRelyingPartyMismatchException':
    case 'WebAuthnOriginNotAllowedException':
      return 'Passkeys aren’t available on this address yet. Use your password for now.';
    case 'WebAuthnCredentialNotSupportedException':
      return 'That passkey isn’t supported. Try another device or your password.';
    case 'WebAuthnChallengeNotFoundException':
      return 'That took a little too long. Please try the passkey again.';
    default:
      return message || 'Something went wrong. Please try again.';
  }
}

// ── Sign-in steps ─────────────────────────────────────────────────────────

export interface Tokens {
  AccessToken: string;
  IdToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
}

interface AuthResponse {
  ChallengeName?: string;
  Session?: string;
  ChallengeParameters?: Record<string, string>;
  AvailableChallenges?: string[];
  AuthenticationResult?: Tokens;
}

/** The next thing the user has to do, or the tokens when they're done. */
export type Step =
  | {
      kind: 'choose';
      session: string;
      passkey: boolean;
      password: boolean;
      /** Set when Cognito went straight to the passkey: the request to answer with one. */
      passkeyOptions?: string;
    }
  | { kind: 'passkey'; session: string; options: string }
  | { kind: 'newPassword'; session: string }
  | { kind: 'mfaSetup'; session: string }
  | { kind: 'mfaCode'; session: string }
  /** A text-message code was sent (to the masked number shown). */
  | { kind: 'smsCode'; session: string; destination: string }
  /** Both an authenticator and text codes are on: which one this time. */
  | { kind: 'chooseMfa'; session: string; sms: boolean; app: boolean }
  | { kind: 'done'; tokens: Tokens };

export function toStep(res: AuthResponse): Step {
  if (res.AuthenticationResult) return { kind: 'done', tokens: res.AuthenticationResult };
  const session = res.Session ?? '';
  switch (res.ChallengeName) {
    case 'SELECT_CHALLENGE': {
      const c = res.AvailableChallenges ?? [];
      return {
        kind: 'choose',
        session,
        passkey: c.includes('WEB_AUTHN'),
        password: c.includes('PASSWORD') || c.includes('PASSWORD_SRP'),
      };
    }
    case 'WEB_AUTHN':
      return {
        kind: 'passkey',
        session,
        options: res.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS ?? '',
      };
    case 'NEW_PASSWORD_REQUIRED':
      return { kind: 'newPassword', session };
    case 'MFA_SETUP':
      return { kind: 'mfaSetup', session };
    case 'SOFTWARE_TOKEN_MFA':
      return { kind: 'mfaCode', session };
    case 'SMS_MFA':
      return {
        kind: 'smsCode',
        session,
        destination: res.ChallengeParameters?.CODE_DELIVERY_DESTINATION ?? 'your phone',
      };
    case 'SELECT_MFA_TYPE': {
      const options = res.ChallengeParameters?.MFAS_CAN_CHOOSE ?? '';
      return {
        kind: 'chooseMfa',
        session,
        sms: options.includes('SMS_MFA'),
        app: options.includes('SOFTWARE_TOKEN_MFA'),
      };
    }
    default:
      throw new CognitoError(
        'UnsupportedChallenge',
        'This account needs a sign-in step the app doesn’t support. Please contact Blueprint.',
      );
  }
}

/** Choice-based sign-in (USER_AUTH): which factors does this account offer? */
export async function start(cfg: AppConfig, email: string): Promise<Step> {
  return toStep(
    await cognito<AuthResponse>(cfg, 'InitiateAuth', {
      ClientId: cfg.clientId,
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: email },
    }),
  );
}

export async function respond(
  cfg: AppConfig,
  challenge: string,
  session: string,
  responses: Record<string, string>,
): Promise<Step> {
  return toStep(
    await cognito<AuthResponse>(cfg, 'RespondToAuthChallenge', {
      ClientId: cfg.clientId,
      ChallengeName: challenge,
      Session: session,
      ChallengeResponses: responses,
    }),
  );
}

/**
 * Cognito can skip the choice and go straight to a passkey for accounts that
 * have one. Turn that back into a choice so a password always works too.
 */
export function asChoice(step: Step): Step {
  if (step.kind !== 'passkey') return step;
  return {
    kind: 'choose',
    session: step.session,
    passkey: true,
    password: true,
    passkeyOptions: step.options,
  };
}

/** Password sign-in from scratch (when the current session is a passkey one). */
export async function startWithPassword(cfg: AppConfig, email: string, password: string) {
  return toStep(
    await cognito<AuthResponse>(cfg, 'InitiateAuth', {
      ClientId: cfg.clientId,
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
    }),
  );
}

export const choosePassword = (cfg: AppConfig, s: string, email: string, password: string) =>
  respond(cfg, 'SELECT_CHALLENGE', s, { USERNAME: email, ANSWER: 'PASSWORD', PASSWORD: password });

export const choosePasskey = (cfg: AppConfig, s: string, email: string) =>
  respond(cfg, 'SELECT_CHALLENGE', s, { USERNAME: email, ANSWER: 'WEB_AUTHN' });

/** Authenticator setup during sign-in: the secret for the app to add. */
export async function associateTotp(
  cfg: AppConfig,
  session: string,
): Promise<{ secret: string; session: string }> {
  const res = await cognito<{ SecretCode: string; Session: string }>(
    cfg,
    'AssociateSoftwareToken',
    { Session: session },
  );
  return { secret: res.SecretCode, session: res.Session };
}

export async function verifyTotpSetup(
  cfg: AppConfig,
  session: string,
  code: string,
): Promise<string> {
  const res = await cognito<{ Status: string; Session: string }>(cfg, 'VerifySoftwareToken', {
    Session: session,
    UserCode: code,
    FriendlyDeviceName: 'Authenticator app',
  });
  if (res.Status !== 'SUCCESS') {
    throw new CognitoError('CodeMismatchException', friendlyError('CodeMismatchException', ''));
  }
  return res.Session;
}

export const forgotPassword = (cfg: AppConfig, email: string) =>
  cognito(cfg, 'ForgotPassword', { ClientId: cfg.clientId, Username: email });

export const confirmForgotPassword = (
  cfg: AppConfig,
  email: string,
  code: string,
  password: string,
) =>
  cognito(cfg, 'ConfirmForgotPassword', {
    ClientId: cfg.clientId,
    Username: email,
    ConfirmationCode: code,
    Password: password,
  });

/** The client rotates refresh tokens, so refreshing returns a new one too. */
export async function refreshTokens(cfg: AppConfig, refreshToken: string): Promise<Tokens> {
  const res = await cognito<{ AuthenticationResult: Tokens }>(cfg, 'GetTokensFromRefreshToken', {
    ClientId: cfg.clientId,
    RefreshToken: refreshToken,
  });
  return res.AuthenticationResult;
}

export const revokeToken = (cfg: AppConfig, refreshToken: string) =>
  cognito(cfg, 'RevokeToken', { ClientId: cfg.clientId, Token: refreshToken });

// ── Passkeys for a signed-in user ─────────────────────────────────────────

export async function listPasskeys(cfg: AppConfig, accessToken: string): Promise<number> {
  const res = await cognito<{ Credentials?: unknown[] }>(cfg, 'ListWebAuthnCredentials', {
    AccessToken: accessToken,
  });
  return res.Credentials?.length ?? 0;
}

export async function startPasskeyRegistration(
  cfg: AppConfig,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const res = await cognito<{ CredentialCreationOptions: Record<string, unknown> }>(
    cfg,
    'StartWebAuthnRegistration',
    { AccessToken: accessToken },
  );
  return res.CredentialCreationOptions;
}

export const completePasskeyRegistration = (
  cfg: AppConfig,
  accessToken: string,
  credential: Record<string, unknown>,
) =>
  cognito(cfg, 'CompleteWebAuthnRegistration', {
    AccessToken: accessToken,
    Credential: credential,
  });

/** The otpauth:// link authenticator apps understand. */
export function otpauthUri(secret: string, email: string): string {
  const label = encodeURIComponent(`Blueprint:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Blueprint')}`;
}

// ── Text-message codes (Profile → Security) ─────────────────────────────────
/** Saves the number and texts it a code to check it. Numbers are E.164 (+61…). */
export const setPhone = (cfg: AppConfig, accessToken: string, phone: string) =>
  cognito(cfg, 'UpdateUserAttributes', {
    AccessToken: accessToken,
    UserAttributes: [{ Name: 'phone_number', Value: phone }],
  });

export const verifyPhone = (cfg: AppConfig, accessToken: string, code: string) =>
  cognito(cfg, 'VerifyUserAttribute', {
    AccessToken: accessToken,
    AttributeName: 'phone_number',
    Code: code,
  });

/** Turns text codes on or off; the authenticator stays the preferred way while it's set up. */
export const setSmsMfa = (cfg: AppConfig, accessToken: string, on: boolean) =>
  cognito(cfg, 'SetUserMFAPreference', {
    AccessToken: accessToken,
    SMSMfaSettings: { Enabled: on, PreferredMfa: false },
  });

/** The number on the account, its check, and whether text codes are on. */
export async function smsStatus(cfg: AppConfig, accessToken: string) {
  const u = await cognito<{
    UserAttributes?: { Name: string; Value: string }[];
    UserMFASettingList?: string[];
  }>(cfg, 'GetUser', { AccessToken: accessToken });
  const attr = (n: string) => u.UserAttributes?.find((a) => a.Name === n)?.Value;
  return {
    phone: attr('phone_number') ?? null,
    verified: attr('phone_number_verified') === 'true',
    on: (u.UserMFASettingList ?? []).includes('SMS_MFA'),
  };
}

/** "0412 345 678" (Australia) or "+44 …" as E.164, or null if it isn't a phone number. */
export function toE164(input: string): string | null {
  const s = input.replace(/[\s()-]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(s)) return s;
  if (/^0[2-9]\d{8}$/.test(s)) return `+61${s.slice(1)}`;
  return null;
}
