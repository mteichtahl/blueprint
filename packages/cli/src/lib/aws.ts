import { DescribeKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { configPath, loadConfig, type BmgConfig, type EnvironmentName } from '@bmg/config';
import { REPO_ROOT } from './runtime.ts';

export function readConfig(): BmgConfig {
  return loadConfig(configPath(REPO_ROOT));
}

export async function callerIdentity(region: string) {
  const sts = new STSClient({ region });
  return sts.send(new GetCallerIdentityCommand({}));
}

/** Refuse to touch an account other than the one in bmg.config.json. */
export async function assertAccount(cfg: BmgConfig): Promise<void> {
  const id = await callerIdentity(cfg.account.homeRegion);
  if (id.Account !== cfg.account.id) {
    throw new Error(
      `Your AWS credentials are for account ${id.Account}, but bmg.config.json is for ${cfg.account.id}. ` +
        'Switch profile (AWS_PROFILE) and try again.',
    );
  }
}

export function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  return /NotFound|NoSuch|ResourceNotFound|ParameterNotFound/.test(name);
}

/**
 * Secrets are encrypted with the environment's platform key, which the
 * bmg-<env>-foundation stack creates on the pipeline's first deploy. Fail early,
 * with the fix, before asking for any secret value.
 */
export async function assertPlatformKey(cfg: BmgConfig, env: EnvironmentName): Promise<string> {
  const alias = `alias/${cfg.project}/${env}/platform`;
  try {
    await new KMSClient({ region: cfg.account.homeRegion }).send(
      new DescribeKeyCommand({ KeyId: alias }),
    );
    return alias;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    throw new Error(
      `${alias} does not exist yet. It is created by the ${cfg.project}-${env}-foundation stack, ` +
        'which the pipeline deploys. First run `bmg pipeline deploy`, then push to main and let the ' +
        `Deploy workflow finish${env === 'prod' ? ' (including the production approval)' : ' for staging'}. ` +
        'Then re-run this command.',
    );
  }
}
