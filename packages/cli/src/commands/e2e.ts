import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminSetUserPasswordCommand,
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  VerifySoftwareTokenCommand,
  type AdminGetUserCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { input } from '@inquirer/prompts';
import { names } from '@bmg/config';
import {
  E2E_ACCOUNT_KEYS,
  E2E_ACCOUNTS,
  e2eEmail,
  E2eSecret,
  type E2eAccount,
  type E2eAccountKey,
} from '@bmg/config/e2e';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import { e2ePassword, subFromJwt, termsVersionFrom, totpCode } from '../lib/e2e.ts';
import { executePlan, log, ok, REPO_ROOT, warn, type GlobalOptions } from '../lib/runtime.ts';

export interface E2eSetupOptions extends GlobalOptions {
  /** The inbox the accounts are plus-addresses of, e.g. you@example.com. */
  email?: string;
  env: string;
}

type ArtistKey = 'artistOn' | 'artistOff' | 'artistOther';
const ARTISTS: ArtistKey[] = ['artistOn', 'artistOff', 'artistOther'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `blueprint e2e setup`: create (or repair) the end-to-end test accounts on
 * staging and store their sign-in details for the Staging E2E job (docs/e2e.md).
 * Safe to run again: existing accounts keep their ids and data.
 */
export async function e2eSetup(opts: E2eSetupOptions): Promise<void> {
  if (opts.env !== 'staging') {
    throw new Error('E2E accounts are for staging only. Production has no test accounts.');
  }
  const env = 'staging' as const;
  const cfg = readConfig();
  await assertAccount(cfg);
  const region = cfg.account.homeRegion;
  const ssm = new SSMClient({ region });
  const param = async (key: string) =>
    (await ssm.send(new GetParameterCommand({ Name: names.ssm(cfg, env, key) }))).Parameter?.Value;
  const poolId = await param('identity/user-pool-id').catch(() => undefined);
  const webUrl = (await param('web/url').catch(() => undefined))?.replace(/\/+$/, '');
  if (!poolId || !webUrl) {
    throw new Error('Staging has no user pool or web app yet. Let Deploy staging finish first.');
  }

  const secrets = new SecretsManagerClient({ region });
  const secretId = names.e2eSecret(cfg, env);
  let previous: E2eSecret | undefined;
  try {
    const raw = (await secrets.send(new GetSecretValueCommand({ SecretId: secretId })))
      .SecretString;
    if (raw) previous = E2eSecret.parse(JSON.parse(raw));
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const base =
    opts.email ??
    previous?.accounts.admin.email.replace(/\+bmg-e2e-[a-z]+@/, '@') ??
    (await input({
      message: 'Inbox for the test accounts (each gets a +bmg-e2e-… alias of it)',
    }));
  const emails = Object.fromEntries(E2E_ACCOUNT_KEYS.map((k) => [k, e2eEmail(base, k)])) as Record<
    E2eAccountKey,
    string
  >;

  const cfgRes = await fetch(`${webUrl}/config.json`);
  if (!cfgRes.ok) throw new Error(`GET ${webUrl}/config.json returned ${cfgRes.status}`);
  const app = (await cfgRes.json()) as { clientId: string; apiBase: string };
  const apiBase = new URL(app.apiBase, `${webUrl}/`).toString().replace(/\/+$/, '');
  const termsVersion = termsVersionFrom(
    readFileSync(resolve(REPO_ROOT, 'apps/web/src/lib/api.ts'), 'utf8'),
  );

  const cognito = new CognitoIdentityProviderClient({ region });
  const accounts: Partial<Record<E2eAccountKey, E2eAccount>> = {};
  const tokens: Partial<Record<E2eAccountKey, string>> = {};
  const signedInAt: Partial<Record<E2eAccountKey, number>> = {};
  const lastStep = new Map<string, number>();

  // ── Helpers ──
  async function getUser(email: string): Promise<AdminGetUserCommandOutput | undefined> {
    try {
      return await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
    } catch (err) {
      if ((err as Error).name === 'UserNotFoundException') return undefined;
      throw err;
    }
  }

  /** A code for this account that hasn't been used yet (Cognito takes each once). */
  async function code(email: string, secret: string): Promise<string> {
    for (;;) {
      const step = Math.floor(Date.now() / 30_000);
      const left = 30_000 - (Date.now() % 30_000);
      if (step > (lastStep.get(email) ?? -1) && left > 4_000) {
        lastStep.set(email, step);
        return totpCode(secret);
      }
      await sleep(left + 250);
    }
  }

  /**
   * Sets a known password, makes sure the account has an authenticator whose
   * secret we hold, and signs in. Returns the access token.
   */
  async function enrol(key: E2eAccountKey): Promise<string> {
    const email = emails[key];
    const before = previous?.accounts[key];
    const password = before?.email === email ? before.password : e2ePassword();
    let totpSecret = before?.email === email ? before.totpSecret : undefined;
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: poolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
    const signIn = () =>
      cognito.send(
        new InitiateAuthCommand({
          ClientId: app.clientId,
          AuthFlow: 'USER_AUTH',
          AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
        }),
      );
    let res = await signIn();
    if (res.ChallengeName === 'SOFTWARE_TOKEN_MFA' && !totpSecret) {
      // An authenticator we don't hold the secret for: switch it off and enrol again.
      await cognito.send(
        new AdminSetUserMFAPreferenceCommand({
          UserPoolId: poolId,
          Username: email,
          SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
        }),
      );
      res = await signIn();
    }
    let access: string | undefined;
    if (res.ChallengeName === 'MFA_SETUP') {
      const assoc = await cognito.send(new AssociateSoftwareTokenCommand({ Session: res.Session }));
      totpSecret = assoc.SecretCode!;
      const verified = await cognito.send(
        new VerifySoftwareTokenCommand({
          Session: assoc.Session,
          UserCode: await code(email, totpSecret),
          FriendlyDeviceName: 'E2E tests',
        }),
      );
      if (verified.Status !== 'SUCCESS') throw new Error(`${key}: authenticator set-up failed`);
      const done = await cognito.send(
        new RespondToAuthChallengeCommand({
          ClientId: app.clientId,
          ChallengeName: 'MFA_SETUP',
          Session: verified.Session,
          ChallengeResponses: { USERNAME: email },
        }),
      );
      access = done.AuthenticationResult?.AccessToken;
    } else if (res.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
      const done = await cognito.send(
        new RespondToAuthChallengeCommand({
          ClientId: app.clientId,
          ChallengeName: 'SOFTWARE_TOKEN_MFA',
          Session: res.Session,
          ChallengeResponses: {
            USERNAME: email,
            SOFTWARE_TOKEN_MFA_CODE: await code(email, totpSecret!),
          },
        }),
      );
      access = done.AuthenticationResult?.AccessToken;
    } else {
      access = res.AuthenticationResult?.AccessToken;
    }
    if (!access || !totpSecret) {
      throw new Error(`${key}: sign-in stopped at ${res.ChallengeName ?? 'an unknown step'}`);
    }
    accounts[key] = {
      email,
      password,
      totpSecret,
      sub: subFromJwt(access),
    };
    tokens[key] = access;
    signedInAt[key] = Date.now();
    return access;
  }

  /** Signs in again with the details enrol() recorded. */
  async function signInAgain(key: E2eAccountKey): Promise<void> {
    const a = accounts[key]!;
    const first = await cognito.send(
      new InitiateAuthCommand({
        ClientId: app.clientId,
        AuthFlow: 'USER_AUTH',
        AuthParameters: {
          USERNAME: a.email,
          PREFERRED_CHALLENGE: 'PASSWORD',
          PASSWORD: a.password,
        },
      }),
    );
    const done = await cognito.send(
      new RespondToAuthChallengeCommand({
        ClientId: app.clientId,
        ChallengeName: 'SOFTWARE_TOKEN_MFA',
        Session: first.Session,
        ChallengeResponses: {
          USERNAME: a.email,
          SOFTWARE_TOKEN_MFA_CODE: await code(a.email, a.totpSecret),
        },
      }),
    );
    const access = done.AuthenticationResult?.AccessToken;
    if (!access)
      throw new Error(`${key}: sign-in stopped at ${done.ChallengeName ?? 'an unknown step'}`);
    tokens[key] = access;
    signedInAt[key] = Date.now();
  }

  /** Inviting people needs a sign-in within the last 5 minutes (design 6.3). */
  async function freshAdmin(): Promise<void> {
    if (Date.now() - (signedInAt.admin ?? 0) > 4 * 60_000) await signInAgain('admin');
  }

  async function api<T>(
    as: E2eAccountKey,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[as]}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : {}) as T };
  }
  async function must<T>(as: E2eAccountKey, method: string, path: string, body?: unknown) {
    const res = await api<T>(as, method, path, body);
    if (res.status >= 300) {
      throw new Error(`${as} ${method} ${path} → ${res.status} ${JSON.stringify(res.data)}`);
    }
    return res.data;
  }

  /** Test accounts don't email or push anyone (they'd fill the inbox on every deploy). */
  const quiet = (key: E2eAccountKey) =>
    must(key, 'PUT', '/preferences', { email: false, push: false, quietHours: null });

  /**
   * Everyone accepts the Terms and makes the AI choice at first sign-in. For a
   * new artist this waits for onboarding to finish making their key.
   */
  async function consent(key: E2eAccountKey, aiOptIn: boolean): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const res = await api(key, 'POST', '/consent', { termsVersion, aiOptIn });
      if (res.status < 300) return;
      if (attempt >= 12)
        throw new Error(`${key} consent: ${res.status} ${JSON.stringify(res.data)}`);
      await sleep(10_000);
    }
  }

  // ── The plan ──
  await executePlan(
    'E2E test accounts on staging',
    [
      {
        description: `E2E Admin (${emails.admin}): Cognito user in bmg-admin, password, authenticator`,
        run: async () => {
          if (!(await getUser(emails.admin))) {
            await cognito.send(
              new AdminCreateUserCommand({
                UserPoolId: poolId,
                Username: emails.admin,
                UserAttributes: [
                  { Name: 'email', Value: emails.admin },
                  { Name: 'email_verified', Value: 'true' },
                  { Name: 'name', Value: E2E_ACCOUNTS.admin.displayName },
                ],
                TemporaryPassword: e2ePassword(),
                MessageAction: 'SUPPRESS',
              }),
            );
          }
          await cognito.send(
            new AdminAddUserToGroupCommand({
              UserPoolId: poolId,
              Username: emails.admin,
              GroupName: 'bmg-admin',
            }),
          );
          await enrol('admin');
          await must('admin', 'PATCH', '/me', { jobTitle: E2E_ACCOUNTS.admin.jobTitle });
          await consent('admin', true);
          await quiet('admin');
          ok(`admin is ${accounts.admin!.sub}`);
        },
      },
      ...ARTISTS.map((key) => ({
        description: `${E2E_ACCOUNTS[key].displayName} (${emails[key]}): invite, password, authenticator, terms, AI ${E2E_ACCOUNTS[key].aiOptIn ? 'on' : 'off'}`,
        run: async () => {
          const def = E2E_ACCOUNTS[key];
          let artistId = previous?.accounts[key]?.artistId;
          const user = await getUser(emails[key]);
          if (!user) {
            await freshAdmin();
            // The app's own invite: roster entry, the artist's key, the Cognito user.
            const res = await api<{ artistId?: string; detail?: string }>(
              'admin',
              'POST',
              '/artists',
              {
                email: emails[key],
                displayName: def.displayName,
              },
            );
            // 502 = created, but the invitation email failed: fine for a test account.
            if (res.status !== 201 && res.status !== 502) {
              throw new Error(`Inviting ${key} failed: ${res.status} ${JSON.stringify(res.data)}`);
            }
            artistId = res.data.artistId ?? /art_[a-z0-9]+/.exec(res.data.detail ?? '')?.[0];
          } else {
            artistId ??= user.UserAttributes?.find((a) => a.Name === 'custom:artistId')?.Value;
          }
          if (!artistId) throw new Error(`Couldn't find ${key}'s artist id`);
          await enrol(key);
          accounts[key]!.artistId = artistId;
          await consent(key, def.aiOptIn);
          await quiet(key);
          ok(`${key} is ${artistId}`);
        },
      })),
      {
        description: `E2E Staff (${emails.staff}): team member assigned to ${E2E_ACCOUNTS.artistOn.displayName}`,
        run: async () => {
          if (!(await getUser(emails.staff))) {
            await freshAdmin();
            await must('admin', 'POST', '/access/team', {
              email: emails.staff,
              displayName: E2E_ACCOUNTS.staff.displayName,
              role: 'bmg-staff',
              jobTitle: E2E_ACCOUNTS.staff.jobTitle,
              artistIds: [accounts.artistOn!.artistId],
            }).catch((err: Error) => {
              // Created but not emailed is fine here.
              if (!/→ 502/.test(err.message)) throw err;
            });
          }
          await enrol('staff');
          await consent('staff', true);
          await quiet('staff');
          ok(`staff is ${accounts.staff!.sub}`);
        },
      },
      {
        description: `A plan for ${E2E_ACCOUNTS.artistOn.displayName}, owned by E2E Admin`,
        run: async () => {
          const id = accounts.artistOn!.artistId!;
          await freshAdmin();
          const got = await must<{
            exists: boolean;
            ownerNeeded: boolean;
            plan: { outcome: string; measures: unknown; phases: unknown; version: number };
          }>('admin', 'GET', `/artists/${id}/plan`);
          if (got.exists && !got.ownerNeeded) return ok('plan already there');
          await must('admin', 'PUT', `/artists/${id}/plan`, {
            outcome: got.plan.outcome || 'E2E test plan',
            measures: got.plan.measures,
            phases: got.plan.phases,
            version: got.plan.version,
            ownerSub: accounts.admin!.sub,
          });
        },
      },
      {
        description: `Store the accounts in ${secretId} (encrypted with alias/${cfg.project}/tooling)`,
        run: async () => {
          const value: E2eSecret = E2eSecret.parse({
            version: 1,
            webUrl,
            accounts,
          });
          const SecretString = JSON.stringify(value);
          if (previous) {
            await secrets.send(new PutSecretValueCommand({ SecretId: secretId, SecretString }));
          } else {
            await secrets.send(
              new CreateSecretCommand({
                Name: secretId,
                SecretString,
                KmsKeyId: `alias/${cfg.project}/tooling`,
                Description: 'BMG staging end-to-end test accounts (docs/e2e.md)',
                // Read by the tooling runner: the permission boundary refuses
                // resources tagged for another environment (DenyCrossEnvironmentAccess).
                Tags: [
                  { Key: 'bmg:env', Value: 'tooling' },
                  { Key: 'bmg:purpose', Value: 'e2e-staging' },
                ],
              }),
            );
          }
        },
      },
    ],
    opts,
  );
  if (!opts.dryRun) {
    log(
      '\nThe Staging E2E job reads these on the next deploy. The invitations emailed to the\n' +
        'test inboxes carry temporary passwords that no longer work; you can delete them.',
    );
    if (!previous)
      warn('First time? Run `blueprint pipeline deploy` so the runner can read the secret.');
  }
}
