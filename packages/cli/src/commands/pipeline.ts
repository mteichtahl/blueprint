import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CodeConnectionsClient, GetConnectionCommand } from '@aws-sdk/client-codeconnections';
import { names } from '@bmg/config';
import { assertAccount, readConfig } from '../lib/aws.ts';
import { deployArgs } from '../lib/plans.ts';
import { deployWithDiagnostics, failedCreate, removeFailedCreate } from '../lib/stacks.ts';
import { cdk, executePlan, log, ok, type GlobalOptions, type PlanStep } from '../lib/runtime.ts';

/** `bmg pipeline deploy`: deploy the CodeBuild runner projects. After this, GitHub drives every change. */
export async function pipelineDeploy(opts: GlobalOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  if (!cfg.github.connectionArn) {
    throw new Error('Run `bmg github connect` first (github.connectionArn is not set).');
  }
  // CodeBuild rejects a project whose connection is not AVAILABLE with a
  // misleading "not authorized" error, so check first.
  const connection = (
    await new CodeConnectionsClient({ region: cfg.account.homeRegion }).send(
      new GetConnectionCommand({ ConnectionArn: cfg.github.connectionArn }),
    )
  ).Connection;
  if (connection?.ConnectionStatus !== 'AVAILABLE') {
    throw new Error(
      `GitHub connection is ${connection?.ConnectionStatus ?? 'missing'}, not AVAILABLE. ` +
        'Run `bmg github connect` and finish the approval in the AWS console first.',
    );
  }
  ok(`GitHub connection ${connection.ConnectionName} is AVAILABLE`);

  const stack = names.stack(cfg, 'tooling');
  const cfn = new CloudFormationClient({ region: cfg.account.homeRegion });
  const failed = await failedCreate(cfn, stack);
  const cleanup: PlanStep[] = failed
    ? [
        {
          description: `Remove ${stack} left in ${failed.status} by a failed first deploy`,
          run: () => removeFailedCreate(cfn, stack),
        },
      ]
    : [];
  await executePlan(
    'CI/CD tooling',
    [
      ...cleanup,
      {
        description: `Deploy ${stack}: CodeBuild runners ${['ci', 'deploy-staging', 'deploy-prod']
          .map((k) => `${cfg.project}-${k}`)
          .join(
            ', ',
          )} (webhooks limited to GitHub user ids ${cfg.github.allowedActorIds.join(', ')}), agent ECR repo`,
        run: async () => {
          await deployWithDiagnostics([{ name: stack, region: cfg.account.homeRegion }], () =>
            cdk(deployArgs([stack])),
          );
        },
      },
    ],
    opts,
  );
  log('\nNext: push to main. The pipeline deploys staging, then prod after an approval in GitHub.');
}
