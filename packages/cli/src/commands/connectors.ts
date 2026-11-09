import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { input, password } from '@inquirer/prompts';
import { EnvironmentName, names } from '@bmg/config';
import { assertAccount, assertPlatformKey, isNotFound, readConfig } from '../lib/aws.ts';
import { executePlan, fail, heading, log, ok, type GlobalOptions } from '../lib/runtime.ts';

export const CONNECTOR_PROVIDERS = ['google', 'meta', 'mailchimp', 'tiktok', 'linkedin'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

/** Where BMG registers each app, and what it covers (from the O1 vendor check). */
export const PROVIDER_GUIDE: Record<
  ConnectorProvider,
  { name: string; where: string; covers: string; idLabel: string }
> = {
  google: {
    name: 'Google Cloud OAuth client (Web application)',
    where:
      'console.cloud.google.com → APIs & Services → Credentials. Enable the Google Analytics Data, Analytics Admin, YouTube Data and Calendar APIs. Publish the consent screen (Testing tokens expire after 7 days).',
    covers: 'Squarespace website stats (GA4), Google Workspace and artist calendars, YouTube',
    idLabel: 'Client ID',
  },
  meta: {
    name: 'Meta app (Business type) with Facebook Login for Business',
    where:
      'developers.facebook.com → My Apps. Give the owner and Kyra app roles; link the Instagram professional account to the Facebook Page.',
    covers: 'Meta Business Suite, Instagram and Facebook (Blueprint and artists)',
    idLabel: 'App ID',
  },
  mailchimp: {
    name: 'Mailchimp registered app',
    where: 'Mailchimp → Account → Extras → Registered apps',
    covers: 'Newsletter subscribers',
    idLabel: 'Client ID',
  },
  tiktok: {
    name: 'TikTok developer app with Login Kit (user.info.basic, user.info.stats)',
    where:
      'developers.tiktok.com → Manage apps. Needs app review; the sandbox allows up to 10 accounts BMG owns.',
    covers: 'TikTok followers (Blueprint and artists)',
    idLabel: 'Client key',
  },
  linkedin: {
    name: 'LinkedIn app with the Community Management API (Development tier)',
    where: 'linkedin.com/developers → Create app, linked to the verified Blueprint page',
    covers: 'LinkedIn company page followers. Tokens last 60 days, then Kyra signs in again.',
    idLabel: 'Client ID',
  },
};

export interface ConnectorsSetupOptions extends GlobalOptions {
  env: string;
  provider: string;
}

async function appUrl(cfg: ReturnType<typeof readConfig>, env: EnvironmentName) {
  const ssm = new SSMClient({ region: cfg.account.homeRegion });
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: names.ssm(cfg, env, 'web/url') }));
    return (res.Parameter?.Value ?? '').replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/**
 * `blueprint connectors setup <provider>`: stores one OAuth app's client id
 * and secret in Secrets Manager (bmg/<env>/connectors/<provider>), under the
 * environment's platform key. Prints the redirect address to register.
 */
export async function connectorsSetup(opts: ConnectorsSetupOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const env = EnvironmentName.parse(opts.env);
  if (!(CONNECTOR_PROVIDERS as readonly string[]).includes(opts.provider)) {
    throw new Error(`Provider must be one of: ${CONNECTOR_PROVIDERS.join(', ')}`);
  }
  const provider = opts.provider as ConnectorProvider;
  const guide = PROVIDER_GUIDE[provider];
  const keyAlias = await assertPlatformKey(cfg, env);
  const secretId = `${names.connectorSecretPrefix(cfg, env)}/${provider}`;
  const url = await appUrl(cfg, env);

  heading(`${guide.name} for ${env}`);
  log(`Covers: ${guide.covers}`);
  log(`Register it at: ${guide.where}`);
  if (url) log(`Redirect URI to add to the app: ${url}/connectors/callback`);
  else fail('The web app has not been deployed yet, so there is no redirect address to register.');

  const clientId = (await input({ message: guide.idLabel })).trim();
  const clientSecret = await password({ message: 'Client secret', mask: '*' });
  if (!clientId || !clientSecret) throw new Error('Both the id and the secret are needed');

  const client = new SecretsManagerClient({ region: cfg.account.homeRegion });
  let exists = true;
  try {
    await client.send(new DescribeSecretCommand({ SecretId: secretId }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    exists = false;
  }
  const value = JSON.stringify({ clientId, clientSecret });
  await executePlan(
    `Connector app for ${env}`,
    [
      {
        description: `${exists ? 'Update' : 'Create'} ${secretId} under ${keyAlias}`,
        run: async () => {
          if (exists) {
            await client.send(
              new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
            );
          } else {
            await client.send(
              new CreateSecretCommand({
                Name: secretId,
                SecretString: value,
                KmsKeyId: keyAlias,
                Description: `BMG ${env}: ${provider} OAuth app for connectors`,
                Tags: [{ Key: 'bmg:env', Value: env }],
              }),
            );
          }
        },
      },
    ],
    opts,
  );
  ok(
    `${provider} is ready. Connect it from the app: Connectors (Blueprint) or My connectors (artists).`,
  );
}

/** `blueprint connectors status`: which OAuth apps are registered in an environment. */
export async function connectorsStatus(opts: GlobalOptions & { env: string }): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const env = EnvironmentName.parse(opts.env);
  const client = new SecretsManagerClient({ region: cfg.account.homeRegion });
  heading(`Connector apps in ${env}`);
  for (const p of CONNECTOR_PROVIDERS) {
    try {
      await client.send(
        new DescribeSecretCommand({ SecretId: `${names.connectorSecretPrefix(cfg, env)}/${p}` }),
      );
      ok(`${p}: registered (${PROVIDER_GUIDE[p].covers})`);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      fail(`${p}: not set up. Run \`blueprint connectors setup ${p} --env ${env}\``);
    }
  }
  log(
    'Humanitix needs no app: an admin pastes a scoped API key in Connectors. Spotify numbers are entered by hand.',
  );
}
