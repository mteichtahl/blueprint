import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Secret, TOTP } from 'otpauth';

const PERIOD = 30;
/**
 * Cognito accepts each code once, so remember the last 30-second step used per
 * account. Kept in the package's own (git-ignored) folder, not the shared OS
 * temp folder, because a test worker that restarts after a failure is a new process.
 */
const DIR = fileURLToPath(new URL('../.e2e-cache/', import.meta.url));
const LEDGER = `${DIR}totp-steps.json`;

function ledger(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fresh 6-digit code for an account. Waits for the next 30-second step if
 * this step's code was already used (or is about to expire), so two sign-ins
 * in a row never send the same code.
 */
export async function freshCode(email: string, secretBase32: string): Promise<string> {
  const totp = new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
  for (;;) {
    const now = Date.now() / 1000;
    const step = Math.floor(now / PERIOD);
    const left = PERIOD - (now % PERIOD);
    const used = ledger()[email] ?? -1;
    if (step > used && left > 4) {
      mkdirSync(DIR, { recursive: true, mode: 0o700 });
      writeFileSync(LEDGER, JSON.stringify({ ...ledger(), [email]: step }), { mode: 0o600 });
      return totp.generate();
    }
    await sleep(Math.ceil(left * 1000) + 250);
  }
}

/** A code that is certainly wrong for this account right now. */
export function wrongCode(secretBase32: string): string {
  const totp = new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
  const valid = new Set(
    [-1, 0, 1].map((w) => totp.generate({ timestamp: Date.now() + w * PERIOD * 1000 })),
  );
  for (let n = 0; ; n++) {
    const code = String((123456 + n * 7919) % 1_000_000).padStart(6, '0');
    if (!valid.has(code)) return code;
  }
}
