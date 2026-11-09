import { describe, expect, it } from 'vitest';
import { AppCredentials, hint, isProvider, PROVIDER_GUIDE } from '../src/connectors/apps.ts';
import { PROVIDERS } from '../src/connectors/catalog.ts';

describe('connector apps', () => {
  it('has setup guidance for every provider', () => {
    for (const p of PROVIDERS) {
      expect(PROVIDER_GUIDE[p].where).toMatch(/^https:\/\//);
      expect(PROVIDER_GUIDE[p].steps.length).toBeGreaterThan(0);
    }
  });

  it('only knows the five providers', () => {
    expect(isProvider('google')).toBe(true);
    expect(isProvider('spotify')).toBe(false);
    expect(isProvider(undefined)).toBe(false);
  });

  it('never shows more than the last four characters of an id', () => {
    expect(hint('1234567890.apps.googleusercontent.com')).toBe('….com');
    expect(hint('abc')).toBe('…');
  });

  it('checks the id and secret', () => {
    expect(
      AppCredentials.safeParse({ clientId: 'abcd1234', clientSecret: 's3cr3t-value' }).success,
    ).toBe(true);
    expect(
      AppCredentials.safeParse({ clientId: 'ab cd', clientSecret: 's3cr3t-value' }).success,
    ).toBe(false);
    expect(AppCredentials.safeParse({ clientId: 'abcd1234', clientSecret: 'short' }).success).toBe(
      false,
    );
    expect(
      AppCredentials.safeParse({ clientId: 'abcd1234', clientSecret: 's3cr3t-value', extra: 1 })
        .success,
    ).toBe(false);
  });
});
