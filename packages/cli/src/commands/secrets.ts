import { readFileSync } from 'node:fs';
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { password } from '@inquirer/prompts';
import { EnvironmentName } from '@bmg/config';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import { secretId } from '../lib/plans.ts';
import { executePlan, type GlobalOptions } from '../lib/runtime.ts';

export interface SecretsSetOptions extends GlobalOptions {
  env: string;
  fromFile?: string;
}

/**
 * `bmg secrets set <name>`: store a secret in Secrets Manager under
 * bmg/<env>/<name>, encrypted with that environment's platform key. The value is
 * read from a hidden prompt or a file and is never printed or logged.
 */
export async function secretsSet(name: string, opts: SecretsSetOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const env = EnvironmentName.parse(opts.env);
  const id = secretId(cfg, env, name);
  const value = opts.fromFile
    ? readFileSync(opts.fromFile, 'utf8').trim()
    : await password({ message: `Value for ${id}`, mask: '*' });
  if (!value) throw new Error('Empty secret value');

  const client = new SecretsManagerClient({ region: cfg.account.homeRegion });
  let exists = true;
  try {
    await client.send(new DescribeSecretCommand({ SecretId: id }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    exists = false;
  }

  await executePlan(
    'Secrets Manager',
    [
      {
        description: `${exists ? 'Update' : 'Create'} secret ${id} (KMS: alias/${cfg.project}/${env}/platform)`,
        run: async () => {
          if (exists) {
            await client.send(new PutSecretValueCommand({ SecretId: id, SecretString: value }));
          } else {
            await client.send(
              new CreateSecretCommand({
                Name: id,
                SecretString: value,
                KmsKeyId: `alias/${cfg.project}/${env}/platform`,
                Tags: [{ Key: 'bmg:env', Value: env }],
              }),
            );
          }
        },
      },
    ],
    opts,
  );
}
