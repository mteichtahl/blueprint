import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { names, type BmgConfig } from '@bmg/config';
import { AccountGlobalStack } from './account-global-stack.ts';
import { ApiStack } from './api-stack.ts';
import { AuditStack } from './audit-stack.ts';
import { AccountGuardrailsStack } from './account-guardrails-stack.ts';
import { DataStack } from './data-stack.ts';
import { EnvFoundationStack } from './env-foundation-stack.ts';
import { FilesStack } from './files-stack.ts';
import { IdentityStack } from './identity-stack.ts';
import { KeysStack } from './keys-stack.ts';
import { NotifyStack } from './notify-stack.ts';
import { WebStack } from './web-stack.ts';
import { ToolingStack } from './tooling-stack.ts';

export interface BuildAppOptions {
  /** Include the tooling stack (needs github.connectionArn). Default: when the ARN is set. */
  includeTooling?: boolean;
  skip?: { guardDuty?: boolean; securityHub?: boolean; config?: boolean; accessAnalyzer?: boolean };
  version?: string;
}

/**
 * Stack layout (one AWS account, design section 4):
 *   bmg-account-guardrails  home region  admin-deployed (`blueprint account setup`)
 *   bmg-account-global      us-east-1    admin-deployed (root alarm, budget)
 *   bmg-tooling             home region  admin-deployed (`blueprint pipeline deploy`)
 *   bmg-<env>-foundation    home region  pipeline-deployed (platform key, alarms)
 *   bmg-<env>-data          home region  pipeline-deployed (DynamoDB tables)
 *   bmg-<env>-identity      home region  pipeline-deployed (Cognito, triggers)
 *   bmg-<env>-keys          home region  pipeline-deployed (per-artist KMS, onboarding, isolation gate)
 *   bmg-<env>-audit         home region  pipeline-deployed (event bus, Object Lock audit archive)
 *   bmg-<env>-files         home region  pipeline-deployed (quarantine, malware scan, file buckets)
 *   bmg-<env>-api           home region  pipeline-deployed (REST API, authorizer, WAF)
 *   bmg-<env>-notify        home region  pipeline-deployed (branded notification email)
 *   bmg-<env>-web           home region  pipeline-deployed (web app on CloudFront, web client)
 * where <env> is staging (bmg-deploy-staging runner) or prod (bmg-deploy-prod).
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

  const environments = (['staging', 'prod'] as const).map((envName) => {
    const foundation = new EnvFoundationStack(app, `${cfg.project}-${envName}-foundation`, {
      config: cfg,
      env: home,
      envName,
      description: `BMG ${envName} foundation`,
      ...(opts.version ? { version: opts.version } : {}),
    });
    const data = new DataStack(app, `${cfg.project}-${envName}-data`, {
      config: cfg,
      env: home,
      envName,
      platformKey: foundation.platformKey,
      description: `BMG ${envName} DynamoDB tables`,
    });
    const identity = new IdentityStack(app, `${cfg.project}-${envName}-identity`, {
      config: cfg,
      env: home,
      envName,
      platformKey: foundation.platformKey,
      mainTable: data.tables.main,
      description: `BMG ${envName} identity: Cognito user pool, web client, triggers`,
    });
    const keys = new KeysStack(app, `${cfg.project}-${envName}-keys`, {
      config: cfg,
      env: home,
      envName,
      platformKey: foundation.platformKey,
      mainTable: data.tables.main,
      description: `BMG ${envName} per-artist keys: key-admin and data-access roles, onboarding`,
      ...(opts.version ? { version: opts.version } : {}),
    });
    const audit = new AuditStack(app, `${cfg.project}-${envName}-audit`, {
      config: cfg,
      env: home,
      envName,
      alarmTopic: foundation.alarmTopic,
      description: `BMG ${envName} event bus and Object Lock audit archive`,
    });
    const files = new FilesStack(app, `${cfg.project}-${envName}-files`, {
      config: cfg,
      env: home,
      envName,
      platformKey: foundation.platformKey,
      mainTable: data.tables.main,
      bus: audit.bus,
      alarmTopic: foundation.alarmTopic,
      dataAccessRoleArn: `arn:aws:iam::${cfg.account.id}:role/${cfg.project}-${envName}-data-access`,
      description: `BMG ${envName} files: quarantine, GuardDuty malware scan, artist and org file buckets`,
      ...(opts.version ? { version: opts.version } : {}),
    });
    // The data-access role (keys stack) gets its file permissions here.
    files.addDependency(keys);
    const api = new ApiStack(app, `${cfg.project}-${envName}-api`, {
      config: cfg,
      env: home,
      envName,
      platformKey: foundation.platformKey,
      userPool: identity.userPool,
      mainTable: data.tables.main,
      consentTable: data.tables.consent,
      sessionsTable: data.tables.sessions,
      bus: audit.bus,
      alarmTopic: foundation.alarmTopic,
      onboarding: keys.onboarding,
      quarantineKey: files.quarantineKey,
      description: `BMG ${envName} REST API: authorizer, consent, step-up, invites`,
    });
    const notify = new NotifyStack(app, `${cfg.project}-${envName}-notify`, {
      config: cfg,
      env: home,
      envName,
      platformKey: foundation.platformKey,
      mainTable: data.tables.main,
      userPool: identity.userPool,
      bus: audit.bus,
      alarmTopic: foundation.alarmTopic,
      description: `BMG ${envName} notifications: branded email for workspace events`,
    });
    const web = new WebStack(app, `${cfg.project}-${envName}-web`, {
      config: cfg,
      env: home,
      envName,
      userPool: identity.userPool,
      loginDomain: `${names.cognitoDomainPrefix(cfg, envName)}.auth.${cfg.account.homeRegion}.amazoncognito.com`,
      restApiId: api.api.restApiId,
      realtime: { httpDns: api.realtime.httpDns, realtimeDns: api.realtime.realtimeDns },
      uploadOrigin: `https://${names.bucket(cfg, envName, 'quarantine')}.s3.${cfg.account.homeRegion}.amazonaws.com`,
      description: `BMG ${envName} web app: CloudFront, site bucket, web client`,
    });
    return { foundation, data, identity, keys, audit, files, api, notify, web };
  });

  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return { guardrails, global, tooling, environments };
}
