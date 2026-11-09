import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { input } from '@inquirer/prompts';
import { names } from '@bmg/config';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import { executePlan, warn, type GlobalOptions } from '../lib/runtime.ts';

export interface AdminCreateOptions extends GlobalOptions {
  email?: string;
  env: 'staging' | 'prod';
}

/** `blueprint admin create`: the first bmg-admin user (Kyra). MFA and passkey are set up at first sign-in. */
export async function adminCreate(opts: AdminCreateOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const ssm = new SSMClient({ region: cfg.account.homeRegion });
  let poolId: string | undefined;
  try {
    poolId = (
      await ssm.send(
        new GetParameterCommand({ Name: names.ssm(cfg, opts.env, 'identity/user-pool-id') }),
      )
    ).Parameter?.Value;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (!poolId) {
    warn(
      `No Cognito user pool in ${opts.env} yet. This command works once Phase 2 (identity) is deployed.`,
    );
    process.exitCode = 1;
    return;
  }
  const email = opts.email ?? (await input({ message: 'Admin email address' }));
  const cognito = new CognitoIdentityProviderClient({ region: cfg.account.homeRegion });
  await executePlan(
    `First admin in ${opts.env}`,
    [
      {
        description: `Invite ${email} to the ${opts.env} user pool`,
        run: async () => {
          await cognito.send(
            new AdminCreateUserCommand({
              UserPoolId: poolId,
              Username: email,
              UserAttributes: [
                { Name: 'email', Value: email },
                { Name: 'email_verified', Value: 'true' },
              ],
              DesiredDeliveryMediums: ['EMAIL'],
            }),
          );
        },
      },
      {
        description: `Add ${email} to the bmg-admin group`,
        run: async () => {
          await cognito.send(
            new AdminAddUserToGroupCommand({
              UserPoolId: poolId,
              Username: email,
              GroupName: 'bmg-admin',
            }),
          );
        },
      },
    ],
    opts,
  );
}
