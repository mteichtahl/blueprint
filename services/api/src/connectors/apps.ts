import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { env } from '../lib.ts';
import { CONNECTORS, PROVIDERS, type ConnectorDef, type Provider } from './catalog.ts';
import type { ClientCreds } from './vendors.ts';

/**
 * The vendor OAuth apps behind the connectors (Google, Meta, Mailchimp,
 * TikTok, LinkedIn). An admin registers each one in the app; its id and
 * secret live in Secrets Manager under the environment's platform key,
 * `<prefix>/<provider>`. The secret never comes back out of the API.
 */
const secrets = new SecretsManagerClient({});

/** Where to register each app and what it covers (from the O1 vendor check). */
export const PROVIDER_GUIDE: Record<
  Provider,
  { name: string; where: string; steps: string[]; idLabel: string; secretLabel: string }
> = {
  google: {
    name: 'Google Cloud OAuth client',
    where: 'https://console.cloud.google.com/apis/credentials',
    steps: [
      'Create an OAuth client ID of type "Web application".',
      'Enable the Google Analytics Data, Analytics Admin, YouTube Data and Google Calendar APIs.',
      'Add the redirect address below under "Authorised redirect URIs".',
      'Publish the consent screen: tokens from a "Testing" app expire after 7 days.',
    ],
    idLabel: 'Client ID',
    secretLabel: 'Client secret',
  },
  meta: {
    name: 'Meta app (Business) with Facebook Login for Business',
    where: 'https://developers.facebook.com/apps',
    steps: [
      'Create a Business app and add Facebook Login for Business.',
      'Add the redirect address below under "Valid OAuth Redirect URIs".',
      'Give the owner and Kyra app roles, and link the Instagram professional account to the Facebook Page.',
    ],
    idLabel: 'App ID',
    secretLabel: 'App secret',
  },
  mailchimp: {
    name: 'Mailchimp registered app',
    where: 'https://admin.mailchimp.com/account/oauth2/',
    steps: [
      'Register an app under Account → Extras → Registered apps.',
      'Use the redirect address below as the Redirect URI.',
    ],
    idLabel: 'Client ID',
    secretLabel: 'Client secret',
  },
  tiktok: {
    name: 'TikTok developer app with Login Kit',
    where: 'https://developers.tiktok.com/apps',
    steps: [
      'Create an app, add Login Kit with the user.info.basic and user.info.stats scopes.',
      'Add the redirect address below.',
      'The app needs TikTok’s review; until then the sandbox allows up to 10 accounts you own.',
    ],
    idLabel: 'Client key',
    secretLabel: 'Client secret',
  },
  linkedin: {
    name: 'LinkedIn app with the Community Management API',
    where: 'https://www.linkedin.com/developers/apps',
    steps: [
      'Create an app linked to the verified Blueprint page and request the Community Management API.',
      'Add the redirect address below under "Authorized redirect URLs".',
      'LinkedIn tokens last 60 days, then Kyra signs in again.',
    ],
    idLabel: 'Client ID',
    secretLabel: 'Client secret',
  },
};

export const isProvider = (p: string | undefined): p is Provider =>
  (PROVIDERS as readonly string[]).includes(p ?? '');

const secretId = (provider: Provider) => `${env('CONNECTOR_SECRET_PREFIX')}/${provider}`;

interface Stored extends Partial<ClientCreds> {
  updatedAt?: string;
}

// Cached briefly per container; a save in this container clears it at once.
const TTL_MS = 5 * 60_000;
const cache = new Map<Provider, { at: number; value: Stored | null }>();

async function read(provider: Provider): Promise<Stored | null> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: Stored | null = null;
  try {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: secretId(provider) }));
    value = JSON.parse(res.SecretString ?? '{}') as Stored;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
  cache.set(provider, { at: Date.now(), value });
  return value;
}

export async function clientCreds(provider: Provider): Promise<ClientCreds | undefined> {
  try {
    const v = await read(provider);
    return v?.clientId && v.clientSecret
      ? { clientId: v.clientId, clientSecret: v.clientSecret }
      : undefined;
  } catch {
    return undefined;
  }
}

/** "…abcd": enough to recognise which app is registered, never the whole id. */
export const hint = (id: string) => (id.length <= 4 ? '…' : `…${id.slice(-4)}`);

export async function listApps(redirectUri: string) {
  return Promise.all(
    PROVIDERS.map(async (provider) => {
      const v = await read(provider).catch(() => null);
      const configured = !!(v?.clientId && v.clientSecret);
      return {
        provider,
        ...PROVIDER_GUIDE[provider],
        usedBy: (Object.values(CONNECTORS) as ConnectorDef[])
          .filter((c) => c.provider === provider)
          .map((c) => c.label),
        configured,
        clientIdHint: configured ? hint(v!.clientId!) : null,
        updatedAt: configured ? (v!.updatedAt ?? null) : null,
        redirectUri,
      };
    }),
  );
}

export const AppCredentials = z
  .object({
    clientId: z.string().trim().min(4).max(300).regex(/^\S+$/, 'No spaces in the id'),
    clientSecret: z.string().trim().min(8).max(500).regex(/^\S+$/, 'No spaces in the secret'),
  })
  .strict();

async function write(provider: Provider, value: Stored) {
  const SecretString = JSON.stringify(value);
  try {
    await secrets.send(new PutSecretValueCommand({ SecretId: secretId(provider), SecretString }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    await secrets.send(
      new CreateSecretCommand({
        Name: secretId(provider),
        SecretString,
        KmsKeyId: env('PLATFORM_KEY_ARN'),
        Description: `BMG ${env('BMG_ENV')}: ${provider} OAuth app for connectors`,
        Tags: [{ Key: 'bmg:env', Value: env('BMG_ENV') }],
      }),
    );
  }
  cache.delete(provider);
}

export const saveApp = (provider: Provider, creds: z.infer<typeof AppCredentials>) =>
  write(provider, { ...creds, updatedAt: new Date().toISOString() });

/** Forgets the app's id and secret (the secret itself stays, emptied). */
export const clearApp = (provider: Provider) => write(provider, {});
