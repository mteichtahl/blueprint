import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { names } from '@bmg/config';
import { assertAccount, readConfig } from '../lib/aws.ts';
import { accountStacks, ENV_STACK_SUFFIXES, ENVIRONMENTS } from '../lib/plans.ts';
import { executePlan, ok, type GlobalOptions, type PlanStep } from '../lib/runtime.ts';
import { failedCreate, removeFailedCreate } from '../lib/stacks.ts';

/**
 * `bmg stacks repair`: removes BMG stacks whose first create failed
 * (ROLLBACK_COMPLETE, ROLLBACK_FAILED or REVIEW_IN_PROGRESS). They hold no
 * resources, but termination protection stops CloudFormation (and the
 * pipeline) from replacing them, so the next deploy can't run until they're gone.
 */
export async function stacksRepair(opts: GlobalOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const home = new CloudFormationClient({ region: cfg.account.homeRegion });
  const candidates: Array<[string, CloudFormationClient]> = [
    // bmg-account-global lives in the edge region (us-east-1); everything else in home.
    ...accountStacks(cfg).map((name): [string, CloudFormationClient] => [
      name,
      name === names.stack(cfg, 'account-global')
        ? new CloudFormationClient({ region: cfg.account.edgeRegion })
        : home,
    ]),
    [names.stack(cfg, 'tooling'), home],
    ...ENVIRONMENTS.flatMap((env) =>
      ENV_STACK_SUFFIXES.map((suffix): [string, CloudFormationClient] => [
        names.envStack(cfg, env, suffix),
        home,
      ]),
    ),
  ];
  const steps: PlanStep[] = [];
  for (const [name, client] of candidates) {
    const failed = await failedCreate(client, name);
    if (failed) {
      steps.push({
        description: `Remove ${name} (${failed.status}: its first create failed; it holds no resources)`,
        run: () => removeFailedCreate(client, name),
      });
    }
  }
  if (steps.length === 0) {
    ok('No failed stacks to repair');
    return;
  }
  await executePlan('Repair failed stacks', steps, opts);
}
