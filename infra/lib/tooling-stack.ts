import { Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { CfnProject } from 'aws-cdk-lib/aws-codebuild';
import { Repository, TagMutability } from 'aws-cdk-lib/aws-ecr';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
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
    description: 'GitHub Actions runner: deploys staging and runs e2e tests.',
  },
  {
    kind: 'deploy-prod',
    computeType: 'BUILD_GENERAL1_SMALL',
    deployTarget: 'prod',
    description: 'GitHub Actions runner: deploys production (production environment only).',
  },
];

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
      throw new Error(
        'github.connectionArn is not set. Run `npm run bmg -- github connect` first.',
      );
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
      repositoryName: `${cfg.project}-agent`,
      imageTagMutability: TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryptionKey: key,
      lifecycleRules: [{ maxImageCount: 30 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    for (const spec of RUNNERS) this.addRunner(cfg, spec, connectionArn, key);
  }

  private addRunner(cfg: BmgConfig, spec: RunnerSpec, connectionArn: string, key: Key): void {
    const projectName = names.runnerProject(cfg, spec.kind);
    const id = spec.kind.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase());

    const logGroup = new LogGroup(this, `${id}Logs`, {
      logGroupName: `/aws/codebuild/${projectName}`,
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
    // The permission boundary uses these tags to decide which deploy roles may be assumed.
    Tags.of(role).add('bmg:deploy-target', spec.deployTarget);

    logGroup.grantWrite(role);
    key.grantEncryptDecrypt(role);
    role.addToPolicy(
      new PolicyStatement({
        sid: 'UseGitHubConnection',
        actions: [
          'codeconnections:UseConnection',
          'codeconnections:GetConnectionToken',
          'codestar-connections:UseConnection',
        ],
        resources: [connectionArn],
      }),
    );

    const stagingQ = cfg.environments.staging.qualifier;
    const prodQ = cfg.environments.prod.qualifier;
    const assumable =
      spec.deployTarget === 'staging'
        ? cdkRoleArns(cfg, stagingQ, ['deploy', 'file-publishing', 'image-publishing', 'lookup'])
        : spec.deployTarget === 'prod'
          ? cdkRoleArns(cfg, prodQ, ['deploy', 'file-publishing', 'image-publishing', 'lookup'])
          : cdkRoleArns(cfg, stagingQ, ['lookup']); // ci: read-only `cdk diff` against staging
    role.addToPolicy(
      new PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: assumable,
      }),
    );

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
