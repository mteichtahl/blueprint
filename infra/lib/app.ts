import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { BmgConfig } from '@bmg/config';
import { AccountGlobalStack } from './account-global-stack.ts';
import { AccountGuardrailsStack } from './account-guardrails-stack.ts';
import { EnvFoundationStack } from './env-foundation-stack.ts';
import { ToolingStack } from './tooling-stack.ts';

export interface BuildAppOptions {
  /** Include the tooling stack (needs github.connectionArn). Default: when the ARN is set. */
  includeTooling?: boolean;
  skip?: { guardDuty?: boolean; securityHub?: boolean; config?: boolean; accessAnalyzer?: boolean };
  version?: string;
}

/**
 * Stack layout (one AWS account, design section 4):
 *   bmg-account-guardrails  home region  admin-deployed (`bmg account setup`)
 *   bmg-account-global      us-east-1    admin-deployed (root alarm, budget)
 *   bmg-tooling             home region  admin-deployed (`bmg pipeline deploy`)
 *   bmg-staging-foundation  home region  pipeline-deployed (bmg-deploy-staging)
 *   bmg-prod-foundation     home region  pipeline-deployed (bmg-deploy-prod)
 */
export function buildApp(app: App, cfg: BmgConfig, opts: BuildAppOptions = {}) {
  const home = { account: cfg.account.id, region: cfg.account.homeRegion };
  const edge = { account: cfg.account.id, region: cfg.account.edgeRegion };

  const guardrails = new AccountGuardrailsStack(app, `${cfg.project}-account-guardrails`, {
    config: cfg,
    env: home,
    description:
      'BMG account guardrails: permission boundary, CloudTrail, GuardDuty, Security Hub, Config, admin roles',
    ...(opts.skip ? { skip: opts.skip } : {}),
  });
  const global = new AccountGlobalStack(app, `${cfg.project}-account-global`, {
    config: cfg,
    env: edge,
    description: 'BMG us-east-1 account alarms and budget',
  });

  const includeTooling = opts.includeTooling ?? Boolean(cfg.github.connectionArn);
  const tooling = includeTooling
    ? new ToolingStack(app, `${cfg.project}-tooling`, {
        config: cfg,
        env: home,
        description: 'BMG CI/CD: CodeBuild-hosted GitHub Actions runners',
      })
    : undefined;
  tooling?.addStackDependency(guardrails);

  const environments = (['staging', 'prod'] as const).map(
    (envName) =>
      new EnvFoundationStack(app, `${cfg.project}-${envName}-foundation`, {
        config: cfg,
        env: home,
        envName,
        description: `BMG ${envName} foundation`,
        ...(opts.version ? { version: opts.version } : {}),
      }),
  );

  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return { guardrails, global, tooling, environments };
}
