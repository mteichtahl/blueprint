import { describe, expect, it } from 'vitest';
import { E2E_ACCOUNT_KEYS, e2eEmail, E2eSecret } from '@bmg/config/e2e';
import { e2ePassword, subFromJwt, termsVersionFrom, totpCode } from '../src/lib/e2e.ts';

describe('e2e setup helpers', () => {
  it('makes one plus-address per account from a single inbox', () => {
    const emails = E2E_ACCOUNT_KEYS.map((k) => e2eEmail('Marc@Example.com', k));
    expect(emails).toContain('marc+bmg-e2e-artiston@example.com');
    expect(new Set(emails).size).toBe(E2E_ACCOUNT_KEYS.length);
    expect(() => e2eEmail('not-an-email', 'admin')).toThrow();
  });

  it('makes passwords that meet the pool rules', () => {
    for (let i = 0; i < 50; i++) {
      const p = e2ePassword();
      expect(p).toHaveLength(32);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/\d/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('reads the Terms version from the web app', () => {
    expect(termsVersionFrom("export const TERMS_VERSION = '2026-11-09';")).toBe('2026-11-09');
    expect(() => termsVersionFrom('nothing here')).toThrow(/TERMS_VERSION/);
  });

  it('makes RFC 6238 codes', () => {
    // RFC 6238 test secret "12345678901234567890" in base32, at T = 59 s → 94287082 (8 digits).
    expect(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
  });

  it('reads the sub from a token', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'abc-123' })).toString('base64url');
    expect(subFromJwt(`x.${payload}.y`)).toBe('abc-123');
  });

  it('rejects a secret without every account', () => {
    expect(() =>
      E2eSecret.parse({ version: 1, webUrl: 'https://x.example', accounts: {} }),
    ).toThrow();
  });
});
