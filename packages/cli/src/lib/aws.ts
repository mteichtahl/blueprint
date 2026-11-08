import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { configPath, loadConfig, type BmgConfig } from '@bmg/config';
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
