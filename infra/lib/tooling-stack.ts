import { Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { CfnProject } from 'aws-cdk-lib/aws-codebuild';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import {
  OidcProviderNative,
  PolicyStatement,
  Role,
  ServicePrincipal,
  WebIdentityPrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { names, type BmgConfig } from '@bmg/config';
import {
  acknowledge,
  BmgStack,
  cdkRoleArns,
  KMS_GRANT_FINDINGS,
  type BmgStackProps,
} from './common.ts';

type RunnerKind = 'ci' | 'deploy-staging' | 'deploy-prod';

interface RunnerSpec {
  kind: RunnerKind;
  computeType: 'BUILD_GENERAL1_SMALL' | 'BUILD_GENERAL1_LARGE';
  deployTarget: 'none' | 'staging' | 'prod';
  description: string;
}

const RUNNERS: RunnerSpec[] = [
  {
    kind: 'ci',
    computeType: 'BUILD_GENERAL1_SMALL',
    deployTarget: 'none',
    description: 'GitHub Actions runner: lint, typecheck, tests, synth, scans. No deploy rights.',
  },
  {
    kind: 'deploy-staging',
    computeType: 'BUILD_GENERAL1_LARGE',
    deployTarget: 'staging',
    description:
      'GitHub Actions runner for staging deploys and e2e tests. AWS rights come from the staging GitHub deploy role.',
  },
  {
    kind: 'deploy-prod',
    computeType: 'BUILD_GENERAL1_SMALL',
    deployTarget: 'prod',
    description:
      'GitHub Actions runner for production deploys. AWS rights come from the production GitHub deploy role.',
  },
];

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/** The GitHub environment whose deploy jobs may use a target's deploy role. */
export function githubEnvironment(target: 'staging' | 'prod'): 'staging' | 'production' {
  return target === 'prod' ? 'production' : 'staging';
}

/**
 * The OIDC `sub` a deploy job's token carries: GitHub sets it to the
 * environment only for a job that declared it and passed its rules.
 */
export function githubDeploySubject(cfg: BmgConfig, target: 'staging' | 'prod'): string {
  return `repo:${cfg.github.owner}/${cfg.github.repo}:environment:${githubEnvironment(target)}`;
}

/**
 * CI/CD tooling (design section 16): CodeBuild projects that act as ephemeral,
 * self-hosted GitHub Actions runners. Every workflow job runs here; nothing runs
 * on GitHub-hosted runners.
 */
export class ToolingStack extends BmgStack {
  constructor(scope: Construct, id: string, props: Omit<BmgStackProps, 'envTag' | 'qualifier'>) {
    super(scope, id, { ...props, qualifier: props.config.toolingQualifier, envTag: 'tooling' });
    const cfg = props.config;
    const connectionArn = cfg.github.connectionArn;
    if (!connectionArn) {
      throw new Error('github.connectionArn is not set. Run `blueprint github connect` first.');
    }

    const key = new Key(this, 'ToolingKey', {
      alias: `alias/${cfg.project}/tooling`,
      description: 'Encrypts CodeBuild logs and artifacts, and the agent image repository',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    key.grant(
      new ServicePrincipal(`logs.${this.region}.amazonaws.com`),
      'kms:Encrypt*',
      'kms:Decrypt*',
      'kms:ReEncrypt*',
      'kms:GenerateDataKey*',
      'kms:Describe*',
    );

    // Agent container image for AgentCore Runtime (built in Phase 5).
    new Repository(this, 'AgentImages', {
      repositoryName: names.agentRepository(cfg),
      imageTagMutability: TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryptionKey: key,
      lifecycleRules: [{ maxImageCount: 30 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    for (const spec of RUNNERS) this.addRunner(cfg, spec, connectionArn, key);

    // Deploy rights (security review H1): a runner's own role can't deploy,
    // because a workflow on any branch can ask for any runner by its label.
    // Deploy jobs swap the job's GitHub OIDC token for a deploy role instead,
    // and the token only names an environment when the job passed that
    // environment's rules (production: v* tags and an approval).
    const github = new OidcProviderNative(this, 'GitHubOidc', {
      url: `https://${GITHUB_OIDC_HOST}`,
      clientIds: ['sts.amazonaws.com'],
    });
    for (const target of ['staging', 'prod'] as const) {
      this.addDeployRole(cfg, target, github, key);
    }
  }

  private addDeployRole(
    cfg: BmgConfig,
    target: 'staging' | 'prod',
    github: OidcProviderNative,
    key: Key,
  ): void {
    const id = target === 'prod' ? 'GitHubDeployProd' : 'GitHubDeployStaging';
    const role = new Role(this, id, {
      roleName: names.githubDeployRole(cfg, target),
      description: `GitHub Actions deploy jobs in the ${githubEnvironment(target)} environment: deploy ${target}`,
      assumedBy: new WebIdentityPrincipal(github.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: githubDeploySubject(cfg, target),
        },
      }),
      maxSessionDuration: Duration.hours(2),
    });
    // The permission boundary uses this tag to decide which deploy roles may be assumed.
    Tags.of(role).add('bmg:deploy-target', target);
    const q =
      target === 'prod' ? cfg.environments.prod.qualifier : cfg.environments.staging.qualifier;
    role.addToPolicy(
      new PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: cdkRoleArns(cfg, q, ['deploy', 'file-publishing', 'image-publishing', 'lookup']),
      }),
    );
    if (target === 'staging') {
      // The Staging E2E job signs in as the test accounts (docs/e2e.md). Their
      // details live in Secrets Manager under the tooling key, never in GitHub.
      const e2eSecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${names.e2eSecret(cfg, 'staging')}-*`;
      role.addToPolicy(
        new PolicyStatement({
          sid: 'ReadE2eAccounts',
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: [e2eSecretArn],
        }),
      );
      key.grantDecrypt(role);
      acknowledge(
        role,
        'One named secret; Secrets Manager appends a random suffix to every secret ARN.',
        `AwsSolutions-IAM5[Resource::${e2eSecretArn}]`,
      );
    }
  }

  private addRunner(cfg: BmgConfig, spec: RunnerSpec, connectionArn: string, key: Key): void {
    const projectName = names.runnerProject(cfg, spec.kind);
    const id = spec.kind.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase());

    const logGroup = new LogGroup(this, `${id}Logs`, {
      logGroupName: names.runnerLogGroup(cfg, spec.kind),
      retention: RetentionDays.THREE_MONTHS,
      encryptionKey: key,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const role = new Role(this, `${id}Role`, {
      roleName: `${projectName}-runner`,
      description: spec.description,
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:codebuild:${this.region}:${this.account}:project/${projectName}`,
          },
        },
      }),
      maxSessionDuration: Duration.hours(2),
    });
    // No runner role can deploy (security review H1): deploy jobs use the
    // GitHub deploy roles below. The boundary denies the bootstrap deploy
    // roles to any principal without a matching tag.
    Tags.of(role).add('bmg:deploy-target', 'none');

    logGroup.grantWrite(role);
    key.grantEncryptDecrypt(role);
    role.addToPolicy(
      new PolicyStatement({
        sid: 'UseGitHubConnection',
        // CodeBuild checks these on the service role when it creates a project
        // with CODECONNECTIONS source auth; both IAM prefixes are evaluated.
        actions: [
          'codeconnections:GetConnection',
          'codeconnections:GetConnectionToken',
          'codeconnections:UseConnection',
          'codestar-connections:GetConnection',
          'codestar-connections:GetConnectionToken',
          'codestar-connections:UseConnection',
        ],
        resources: [connectionArn],
      }),
    );

    if (spec.deployTarget === 'none') {
      // CI: read-only `cdk diff` against staging.
      role.addToPolicy(
        new PolicyStatement({
          sid: 'AssumeCdkLookupRole',
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: cdkRoleArns(cfg, cfg.environments.staging.qualifier, ['lookup']),
        }),
      );
    }

    const project = new CfnProject(this, `${id}Project`, {
      name: projectName,
      description: spec.description,
      serviceRole: role.roleArn,
      encryptionKey: key.keyArn,
      timeoutInMinutes: 60,
      queuedTimeoutInMinutes: 30,
      source: {
        type: 'GITHUB',
        location: `https://github.com/${cfg.github.owner}/${cfg.github.repo}.git`,
        auth: { type: 'CODECONNECTIONS', resource: connectionArn },
        reportBuildStatus: false,
      },
      artifacts: { type: 'NO_ARTIFACTS' },
      environment: {
        type: 'ARM_CONTAINER',
        image: 'aws/codebuild/amazonlinux-aarch64-standard:3.0',
        computeType: spec.computeType,
        privilegedMode: false,
        imagePullCredentialsType: 'CODEBUILD',
      },
      logsConfig: {
        cloudWatchLogs: { status: 'ENABLED', groupName: logGroup.logGroupName },
        s3Logs: { status: 'DISABLED' },
      },
      triggers: {
        webhook: true,
        buildType: 'BUILD',
        filterGroups: [
          [
            { type: 'EVENT', pattern: 'WORKFLOW_JOB_QUEUED' },
            // Public repo (design 16.4): only these GitHub users can start a runner.
            { type: 'ACTOR_ACCOUNT_ID', pattern: `^(${cfg.github.allowedActorIds.join('|')})$` },
          ],
        ],
      },
    });
    project.node.addDependency(role);

    acknowledge(
      role,
      'key.grantEncryptDecrypt() emits KMS action families; the grant is scoped to the tooling key only.',
      ...KMS_GRANT_FINDINGS,
    );
  }
}
