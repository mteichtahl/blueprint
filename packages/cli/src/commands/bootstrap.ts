import { GetPolicyCommand, IAMClient } from '@aws-sdk/client-iam';
import { names, type BmgConfig } from '@bmg/config';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import { ENVIRONMENTS, envBootstrap, toolingBootstrap, type BootstrapSpec } from '../lib/plans.ts';
import { cdk, executePlan, warn, type GlobalOptions, type PlanStep } from '../lib/runtime.ts';

export async function boundaryExists(cfg: BmgConfig): Promise<boolean> {
  try {
    await new IAMClient({ region: cfg.account.homeRegion }).send(
      new GetPolicyCommand({
        PolicyArn: `arn:aws:iam::${cfg.account.id}:policy/${names.permissionBoundary(cfg)}`,
      }),
    );
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

const step = (spec: BootstrapSpec): PlanStep => ({
  description: `cdk bootstrap ${spec.label} in ${spec.args.filter((a) => a.startsWith('aws://')).join(' and ')}`,
  run: async () => {
    await cdk(spec.args);
  },
});

export function envBootstrapSteps(cfg: BmgConfig): PlanStep[] {
  return ENVIRONMENTS.map((env) => step(envBootstrap(cfg, env)));
}

/**
 * `blueprint bootstrap`: CDK bootstrap with one qualifier per purpose (design 4.1).
 * The tooling bootstrap comes first; staging and prod are bootstrapped once the
 * account permission boundary exists (created by `blueprint account setup`).
 */
export async function bootstrap(opts: GlobalOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const steps: PlanStep[] = [step(toolingBootstrap(cfg))];
  if (await boundaryExists(cfg)) {
    steps.push(...envBootstrapSteps(cfg));
  } else {
    warn(
      'Staging/prod bootstraps wait for the permission boundary. `blueprint account setup` runs them next.',
    );
  }
  await executePlan('CDK bootstrap', steps, opts);
}
