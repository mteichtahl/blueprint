import { z } from 'zod';

/**
 * The end-to-end test accounts (docs/e2e.md). `blueprint e2e setup` creates
 * them on staging and stores their sign-in details in Secrets Manager; the
 * Staging E2E job reads them back. Shared here so both always agree.
 *
 * They are ordinary accounts with no special rights, kept apart from real
 * people by name ("E2E …") and email (plus-addresses of one inbox).
 */
export const E2E_ACCOUNTS = {
  admin: { role: 'bmg-admin', displayName: 'E2E Admin', jobTitle: 'E2E test admin' },
  staff: { role: 'bmg-staff', displayName: 'E2E Staff', jobTitle: 'E2E test team member' },
  artistOn: { role: 'artist', displayName: 'E2E Artist (AI on)', aiOptIn: true },
  artistOff: { role: 'artist', displayName: 'E2E Artist (AI off)', aiOptIn: false },
  artistOther: { role: 'artist', displayName: 'E2E Artist (privacy)', aiOptIn: true },
} as const;

export type E2eAccountKey = keyof typeof E2E_ACCOUNTS;
export const E2E_ACCOUNT_KEYS = Object.keys(E2E_ACCOUNTS) as E2eAccountKey[];

/** `you@example.com` → `you+bmg-e2e-artiston@example.com`. */
export function e2eEmail(base: string, key: E2eAccountKey): string {
  const at = base.lastIndexOf('@');
  if (at < 1) throw new Error(`"${base}" is not an email address`);
  return `${base.slice(0, at)}+bmg-e2e-${key.toLowerCase()}${base.slice(at)}`.toLowerCase();
}

const Account = z.object({
  email: z.email(),
  password: z.string().min(12),
  /** Base32 authenticator secret, so the tests can make their own 6-digit codes. */
  totpSecret: z.string().regex(/^[A-Z2-7]+=*$/),
  /** Cognito sub (Blueprint accounts) or art_… id (artists), filled in by setup. */
  sub: z.string().optional(),
  artistId: z.string().optional(),
});
export type E2eAccount = z.infer<typeof Account>;

export const E2eSecret = z.object({
  version: z.literal(1),
  /** The web app the accounts belong to, e.g. https://d1e03n0k2euijp.cloudfront.net */
  webUrl: z.url(),
  accounts: z.object({
    admin: Account,
    staff: Account,
    artistOn: Account,
    artistOff: Account,
    artistOther: Account,
  }),
});
export type E2eSecret = z.infer<typeof E2eSecret>;
