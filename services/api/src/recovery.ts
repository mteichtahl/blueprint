/**
 * Recovery codes (sign-in): ten one-time codes, made after a fresh sign-in
 * and shown once. One of them, with the account's email, turns off the
 * authenticator so the next sign-in (with the password) sets up a new one.
 * The password is still needed, so a code alone never opens an account.
 *
 * Only scrypt hashes are kept, each with its own salt. Pure, so it's tested.
 */
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const RECOVERY_CODES = 10;
/** No 0/O or 1/I/L: codes are read off paper. 31 symbols, 10 per code: about 49 bits. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Wrong codes allowed per account per hour before it's locked for that hour. */
export const MAX_RECOVERY_FAILURES = 5;
export const RECOVERY_SK = 'RECOVERY';

export interface RecoveryRecord {
  /** `salt:hash`, base64; null once used. */
  codes: (string | null)[];
  createdAt: string;
  /** Wrong tries in the current hour, and when that hour started (epoch seconds). */
  failures?: number;
  failWindowStart?: number;
  usedAt?: string;
}

/** "ABCDE-FGHJK" */
export function newCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** What was typed, as stored: upper case, no spaces or dashes. */
export const normalise = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

const hashWith = (salt: Buffer, code: string) =>
  scryptSync(normalise(code), salt, 32, { N: 16384, r: 8, p: 1 });

export function hashCode(code: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('base64')}:${hashWith(salt, code).toString('base64')}`;
}

/** The index of the unused code this matches, or -1. */
export function matchCode(code: string, stored: readonly (string | null)[]): number {
  const n = normalise(code);
  if (n.length !== 10 || [...n].some((c) => !ALPHABET.includes(c))) return -1;
  let found = -1;
  // Check every code (no early exit), so timing doesn't say which one matched.
  stored.forEach((h, i) => {
    if (!h) return;
    const [salt, hash] = h.split(':');
    const want = Buffer.from(hash!, 'base64');
    const got = hashWith(Buffer.from(salt!, 'base64'), n);
    if (want.length === got.length && timingSafeEqual(want, got) && found < 0) found = i;
  });
  return found;
}

/** A fresh set: the codes to show once, and the record to keep. */
export function newSet(now: Date): { shown: string[]; record: RecoveryRecord } {
  const shown = Array.from({ length: RECOVERY_CODES }, newCode);
  return { shown, record: { codes: shown.map(hashCode), createdAt: now.toISOString() } };
}

/** Too many wrong codes in this hour? */
export function locked(r: Pick<RecoveryRecord, 'failures' | 'failWindowStart'>, nowS: number) {
  return (
    (r.failures ?? 0) >= MAX_RECOVERY_FAILURES &&
    !!r.failWindowStart &&
    nowS - r.failWindowStart < 3600
  );
}

export const RecoveryBody = z
  .object({
    email: z.email().max(254),
    code: z.string().min(10).max(20),
  })
  .strict();

/** The same answer for a wrong code, an unknown email and a locked account. */
export const RECOVERY_REFUSED = 'That email and recovery code don’t match.';
