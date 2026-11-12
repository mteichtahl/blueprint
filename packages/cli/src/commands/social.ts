import { readFileSync, writeFileSync } from 'node:fs';
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { input, password } from '@inquirer/prompts';
import { configPath, EnvironmentName, names } from '@bmg/config';
import { assertAccount, assertPlatformKey, isNotFound, readConfig } from '../lib/aws.ts';
import { executePlan, log, REPO_ROOT, type GlobalOptions } from '../lib/runtime.ts';

/** Cognito's names for the providers, and where each OAuth app is made. */
export const SOCIAL = {
  google: {
    name: 'Google',
    where:
      'Google Cloud console → APIs & Services → Credentials → Create OAuth client ID (Web application)',
  },
  apple: {
    name: 'Apple',
    where:
      'Apple Developer → Certificates, Identifiers & Profiles: a Services ID with Sign in with Apple, and a key for it',
  },
  facebook: {
    name: 'Facebook',
    where: 'Meta for Developers → My Apps → Create app → Facebook Login → Settings',
  },
} as const;
export type SocialProvider = keyof typeof SOCIAL;

/** The redirect URI each provider must be given: Cognito's own OAuth response endpoint. */
export const idpRedirect = (loginHost: string) => `https://${loginHost}/oauth2/idpresponse`;

/** `bmg.config.json` with the provider added to the environment's list (order kept, no repeats). */
export function withProvider(raw: string, env: EnvironmentName, provider: string): string {
  const cfg = JSON.parse(raw) as {
    environments: Record<string, { socialProviders?: string[] }>;
  };
  const e = cfg.environments[env]!;
  e.socialProviders = [...new Set([...(e.socialProviders ?? []), provider])];
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

export interface SocialSetupOptions extends GlobalOptions {
  env: string;
}

/**
 * `blueprint social setup <google|apple|facebook>`: stores the provider's
 * OAuth app in Secrets Manager (`<project>/<env>/social/<provider>`, under
 * the platform key, never printed) and turns it on in bmg.config.json. The
 * next deploy adds it to Cognito and puts its button on the sign-in screen.
 */
export async function socialSetup(provider: string, opts: SocialSetupOptions): Promise<void> {
  if (!(provider in SOCIAL)) throw new Error('Use google, apple or facebook');
  const p = SOCIAL[provider as SocialProvider];
  const cfg = readConfig();
  await assertAccount(cfg);
  const env = EnvironmentName.parse(opts.env);
  const keyAlias = await assertPlatformKey(cfg, env);
  const loginHost = `${names.cognitoDomainPrefix(cfg, env)}.auth.${cfg.account.homeRegion}.amazoncognito.com`;
  log(
    `${p.name}: create the OAuth app in ${p.where}.\n` +
      `  Redirect URI (authorised redirect / return URL): ${idpRedirect(loginHost)}\n` +
      `  Domain: ${loginHost}`,
  );
  const value: Record<string, string> =
    provider === 'apple'
      ? {
          clientId: (await input({ message: 'Services ID (client id)' })).trim(),
          teamId: (await input({ message: 'Team ID' })).trim(),
          keyId: (await input({ message: 'Key ID' })).trim(),
          privateKey: readFileSync(
            (await input({ message: 'Path to the .p8 private key file' })).trim(),
            'utf8',
          ),
        }
      : {
          clientId: (await input({ message: 'Client ID / App ID' })).trim(),
          clientSecret: await password({ message: 'Client secret / App secret', mask: '*' }),
        };
  if (Object.values(value).some((v) => !v)) throw new Error('Every value is needed');

  const secretId = names.socialSecret(cfg, env, p.name);
  const client = new SecretsManagerClient({ region: cfg.account.homeRegion });
  let exists = true;
  try {
    await client.send(new DescribeSecretCommand({ SecretId: secretId }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    exists = false;
  }
  const file = configPath(REPO_ROOT);
  await executePlan(
    `${p.name} sign-in for ${env}`,
    [
      {
        description: `${exists ? 'Update' : 'Create'} ${secretId} under ${keyAlias}`,
        run: async () => {
          const SecretString = JSON.stringify(value);
          if (exists) {
            await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString }));
          } else {
            await client.send(
              new CreateSecretCommand({
                Name: secretId,
                SecretString,
                KmsKeyId: keyAlias,
                Description: `${p.name} sign-in for BMG ${env}`,
                Tags: [{ Key: 'bmg:env', Value: env }],
              }),
            );
          }
        },
      },
      {
        description: `Turn on ${p.name} in bmg.config.json (${env}); deploy to add its button`,
        run: async () => writeFileSync(file, withProvider(readFileSync(file, 'utf8'), env, p.name)),
      },
    ],
    opts,
  );
}
