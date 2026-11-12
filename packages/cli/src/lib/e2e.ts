import { randomInt } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

/** Pure helpers for `blueprint e2e setup` (tested in test/e2e.test.ts). */

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!#%*+-=?@^_';

/** A strong password that meets the pool's rules (12+, upper, lower, number, symbol). */
export function e2ePassword(length = 32): string {
  const pick = (set: string) => set[randomInt(set.length)]!;
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** The Terms version the app asks people to accept, read from the web app's source. */
export function termsVersionFrom(apiSource: string): string {
  const m = /export const TERMS_VERSION = '(\d{4}-\d{2}-\d{2})'/.exec(apiSource);
  if (!m) throw new Error('Could not find TERMS_VERSION in apps/web/src/lib/api.ts');
  return m[1]!;
}

export function totpCode(secretBase32: string, at = Date.now()): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate({ timestamp: at });
}

/** The `sub` claim of a Cognito JWT (no signature check: it came straight from Cognito). */
export function subFromJwt(jwt: string): string {
  const payload = jwt.split('.')[1];
  if (!payload) throw new Error('Not a JWT');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string };
  if (!claims.sub) throw new Error('The token has no sub');
  return claims.sub;
}
