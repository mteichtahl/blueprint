import { names } from '@bmg/config';
import { assertAccount, readConfig } from '../lib/aws.ts';
import { deployArgs } from '../lib/plans.ts';
import { cdk, executePlan, log, type GlobalOptions } from '../lib/runtime.ts';

/** `bmg pipeline deploy`: deploy the CodeBuild runner projects. After this, GitHub drives every change. */
export async function pipelineDeploy(opts: GlobalOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  if (!cfg.github.connectionArn) {
    throw new Error('Run `bmg github connect` first (github.connectionArn is not set).');
  }
  const stack = names.stack(cfg, 'tooling');
  await executePlan(
    'CI/CD tooling',
    [
      {
        description: `Deploy ${stack}: CodeBuild runners ${['ci', 'deploy-staging', 'deploy-prod']
          .map((k) => `${cfg.project}-${k}`)
          .join(
            ', ',
          )} (webhooks limited to GitHub user ids ${cfg.github.allowedActorIds.join(', ')}), agent ECR repo`,
        run: async () => {
          await cdk(deployArgs([stack]));
        },
      },
    ],
    opts,
  );
  log('\nNext: push to main. The pipeline deploys staging, then prod after an approval in GitHub.');
}
