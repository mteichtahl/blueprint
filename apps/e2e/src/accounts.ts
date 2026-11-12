import { readFileSync } from 'node:fs';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { E2eSecret, type E2eAccountKey } from '@bmg/config/e2e';

/**
 * Where the test accounts come from (docs/e2e.md):
 *  - E2E_ACCOUNTS_FILE: a local JSON file in the E2eSecret shape (for running
 *    from a laptop without AWS access), or
 *  - Secrets Manager (default): E2E_SECRET_ID, default bmg/staging/e2e-accounts,
 *    read with whatever AWS credentials the process has. In CI that is the
 *    deploy-staging runner's role; nothing is stored in GitHub.
 */
let cached: Promise<E2eSecret> | undefined;

export function loadAccounts(): Promise<E2eSecret> {
  cached ??= (async () => {
    const file = process.env.E2E_ACCOUNTS_FILE;
    if (file) return E2eSecret.parse(JSON.parse(readFileSync(file, 'utf8')));
    const client = new SecretsManagerClient({
      region: process.env.E2E_AWS_REGION ?? process.env.AWS_REGION ?? 'ap-southeast-2',
    });
    const secretId = process.env.E2E_SECRET_ID ?? 'bmg/staging/e2e-accounts';
    let raw: string | undefined;
    try {
      raw = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
    } catch (err) {
      throw new Error(
        `Couldn't read the E2E accounts from ${secretId}: ${(err as Error).message}. ` +
          'Run `blueprint e2e setup` first, or set E2E_ACCOUNTS_FILE.',
        { cause: err },
      );
    }
    if (!raw) throw new Error(`${secretId} has no value. Run \`blueprint e2e setup\`.`);
    return E2eSecret.parse(JSON.parse(raw));
  })();
  return cached;
}

export async function account(key: E2eAccountKey) {
  return (await loadAccounts()).accounts[key];
}

/** The app under test: E2E_BASE_URL, else the web URL recorded by setup. */
export async function baseUrl(): Promise<string> {
  const url = process.env.E2E_BASE_URL ?? (await loadAccounts()).webUrl;
  return url.replace(/\/+$/, '');
}

/** An id for this run, put in everything the tests create so it can be traced. */
export const RUN_ID = process.env.GITHUB_RUN_ID
  ? `run ${process.env.GITHUB_RUN_ID}`
  : `local ${new Date().toISOString().slice(0, 16)}`;

export const tag = (what: string) => `[e2e ${RUN_ID}] ${what}`;
