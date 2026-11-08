import { describe, expect, it } from 'vitest';
import { allowedResources, sessionState, validClaims } from '../src/session.ts';

const now = 1_800_000_000;
const arn = 'arn:aws:execute-api:ap-southeast-2:111111111111:abc123/prod/GET/me';

describe('sessionState (design 6.2)', () => {
  it('trusts Cognito MFA for native sign-ins', () => {
    expect(
      sessionState({ sub: 's', mfa_level: 'cognito', auth_time: now - 10 }, undefined, now),
    ).toEqual({
      mfaSatisfied: true,
      authTime: now - 10,
    });
  });

  it('requires a live, verified step-up for social sign-ins', () => {
    const claims = { sub: 's', mfa_level: 'federated', auth_time: now - 1000 };
    expect(sessionState(claims, undefined, now).mfaSatisfied).toBe(false);
    expect(sessionState(claims, { verified: false, expiresAt: now + 60 }, now).mfaSatisfied).toBe(
      false,
    );
    expect(sessionState(claims, { verified: true, expiresAt: now - 1 }, now).mfaSatisfied).toBe(
      false,
    );
    expect(
      sessionState(claims, { verified: true, expiresAt: now + 60, verifiedAt: now - 5 }, now),
    ).toEqual({ mfaSatisfied: true, authTime: now - 5 });
  });
});

describe('validClaims', () => {
  it('needs a known role and a session id', () => {
    expect(validClaims({ sub: 's', role: 'artist', origin_jti: 'j' })).toBe(true);
    expect(validClaims({ sub: 's', role: 'root', origin_jti: 'j' })).toBe(false);
    expect(validClaims({ sub: 's', role: 'artist' })).toBe(false);
  });
});

describe('allowedResources', () => {
  it('allows every route once MFA is satisfied', () => {
    expect(allowedResources(arn, true)).toEqual([
      'arn:aws:execute-api:ap-southeast-2:111111111111:abc123/prod/*/*',
    ]);
  });

  it('allows only step-up routes and GET /me before step-up', () => {
    expect(allowedResources(arn, false)).toEqual([
      'arn:aws:execute-api:ap-southeast-2:111111111111:abc123/prod/POST/step-up/totp/setup',
      'arn:aws:execute-api:ap-southeast-2:111111111111:abc123/prod/POST/step-up/totp/verify',
      'arn:aws:execute-api:ap-southeast-2:111111111111:abc123/prod/GET/me',
    ]);
  });
});

describe('auditKey', () => {
  it('files events by day and action, with unsafe characters replaced', async () => {
    const { auditKey } = await import('../src/handlers/audit-writer.ts');
    expect(auditKey('2026-11-08T12:00:00.000Z', 'artist.invite', 'abc-123')).toBe(
      'audit/2026/11/08/artist.invite/abc-123.json',
    );
    expect(auditKey('2026-11-08T12:00:00.000Z', '../x', 'a/b')).toBe(
      'audit/2026/11/08/.._x/a_b.json',
    );
  });
});
