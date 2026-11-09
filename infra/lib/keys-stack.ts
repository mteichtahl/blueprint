import { CfnOutput, CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { AccountPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import {
  DefinitionBody,
  LogLevel,
  StateMachine,
  StateMachineType,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface KeysStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly mainTable: ITable;
  /** Git commit being deployed; re-runs the isolation gate on every staging deploy. */
  readonly version?: string;
}

/** Session roles allowed to carry data-access sessions (design 6.3). */
const SESSION_ROLES = ['artist', 'bmg-admin', 'bmg-staff'];

/**
 * Per-artist encryption (design 9.1, 6.3):
 * - `<p>-key-admin`: the onboarding task's role. Creates each artist's key with
 *   the artist key policy; never decrypts.
 * - `<p>-data-access`: the only role a key policy lets use an artist key, and
 *   only in sessions tagged with that artist's id.
 * - `<p>-artist-onboarding`: the Step Functions workflow (key now; workspace
 *   and invite steps are added in Phase 3).
 * - Staging only: the isolation gate runs real KMS calls on every deploy and
 *   fails the deploy if any cross-artist or private-item access is allowed.
 */
export class KeysStack extends BmgStack {
  readonly dataAccessRole: Role;
  readonly onboarding: StateMachine;

  constructor(scope: Construct, id: string, props: KeysStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;
    const roleArn = (name: string) => `arn:aws:iam::${this.account}:role/${name}`;
    const keyAdminRoleName = `${p}-key-admin`;
    const dataAccessRoleName = `${p}-data-access`;
    const gateRoleName = `${p}-isolation-gate`;
    const anyKey = `arn:aws:kms:${this.region}:${this.account}:key/*`;
    const artistAliases = `arn:aws:kms:${this.region}:${this.account}:alias/${cfg.project}/${env}/artist/*`;

    // ── Data-access role: assumed per request with artistId + role session tags ──
    this.dataAccessRole = new Role(this, 'DataAccess', {
      roleName: dataAccessRoleName,
      description: `BMG ${env}: per-artist data access. Usable only in sessions tagged with artistId and role.`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new AccountPrincipal(this.account).withSessionTags().withConditions({
        ArnLike: {
          'aws:PrincipalArn': [
            roleArn(gateRoleName),
            // The staging files gate (files stack) runs the same kind of checks against S3.
            roleArn(`${p}-files-gate`),
            roleArn(`${p}-api-*`),
          ],
        },
        // Both tags are required and nothing else may be set (no tag overrides).
        Null: { 'aws:RequestTag/artistId': 'false', 'aws:RequestTag/role': 'false' },
        StringLike: { 'aws:RequestTag/artistId': 'art_*' },
        StringEquals: { 'aws:RequestTag/role': SESSION_ROLES },
        'ForAllValues:StringEquals': { 'aws:TagKeys': ['artistId', 'role'] },
      }),
    });
    this.dataAccessRole.addToPolicy(
      new PolicyStatement({
        sid: 'UseOnlyTheTaggedArtistsKey',
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:GenerateDataKey',
          'kms:GenerateDataKeyWithoutPlaintext',
        ],
        resources: [anyKey],
        conditions: {
          StringEquals: {
            'aws:ResourceTag/artistId': '${aws:PrincipalTag/artistId}',
            'kms:EncryptionContext:artistId': '${aws:PrincipalTag/artistId}',
          },
        },
      }),
    );
    this.dataAccessRole.addToPolicy(
      new PolicyStatement({
        sid: 'DescribeTheTaggedArtistsKey',
        actions: ['kms:DescribeKey'],
        resources: [anyKey],
        conditions: {
          StringEquals: { 'aws:ResourceTag/artistId': '${aws:PrincipalTag/artistId}' },
        },
      }),
    );
    acknowledge(
      this.dataAccessRole,
      'Artist keys are created at run time; access is limited to the key whose artistId tag equals the session tag, with a matching encryption context.',
      `AwsSolutions-IAM5[Resource::${anyKey}]`,
    );

    // ── Onboarding task (runs as the key-admin role) ──
    const onboard = new BmgFunction(this, 'OnboardArtist', {
      entry: 'services/keys/src/onboard.ts',
      description: `BMG ${env}: create an artist's KMS key and first workspace record`,
      roleName: keyAdminRoleName,
      timeout: Duration.seconds(30),
      prod,
      environment: {
        PROJECT: cfg.project,
        BMG_ENV: env,
        ACCOUNT_ID: this.account,
        KEY_ADMIN_ROLE_ARN: roleArn(keyAdminRoleName),
        DATA_ACCESS_ROLE_ARN: roleArn(dataAccessRoleName),
        MAIN_TABLE: props.mainTable.tableName,
      },
    });
    onboard.addToRolePolicy(
      new PolicyStatement({
        sid: 'CreateArtistKeysForThisEnvironment',
        actions: ['kms:CreateKey', 'kms:TagResource'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestTag/bmg:env': env },
          'ForAllValues:StringEquals': {
            'aws:TagKeys': ['artistId', 'bmg:env', 'bmg:project', 'bmg:managed-by'],
          },
        },
      }),
    );
    onboard.addToRolePolicy(
      new PolicyStatement({
        sid: 'ManageThisEnvironmentsArtistKeys',
        actions: ['kms:DescribeKey', 'kms:EnableKeyRotation', 'kms:CreateAlias'],
        resources: [anyKey],
        conditions: { StringEquals: { 'aws:ResourceTag/bmg:env': env } },
      }),
    );
    onboard.addToRolePolicy(
      new PolicyStatement({
        sid: 'ArtistAliasesOnly',
        actions: ['kms:CreateAlias', 'kms:DescribeKey'],
        resources: [artistAliases],
      }),
    );
    onboard.addToRolePolicy(
      new PolicyStatement({
        sid: 'RecordArtist',
        actions: ['dynamodb:PutItem'],
        resources: [props.mainTable.tableArn],
      }),
    );
    props.platformKey.grant(onboard, 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey');
    acknowledge(
      onboard.role!,
      'kms:CreateKey has no resource ARN before the key exists; it is limited by request tags to this environment. Other key actions are limited to keys tagged with this environment and to artist aliases.',
      'AwsSolutions-IAM5[Resource::*]',
      `AwsSolutions-IAM5[Resource::${anyKey}]`,
      `AwsSolutions-IAM5[Resource::${artistAliases}]`,
    );
    const onboardArnFinding = `AwsSolutions-IAM5[Resource::<${this.getLogicalId(onboard.node.defaultChild as never)}.Arn>:*]`;

    const sfnLogs = new LogGroup(this, 'OnboardingLogs', {
      retention: prod ? RetentionDays.ONE_YEAR : RetentionDays.ONE_MONTH,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.onboarding = new StateMachine(this, 'ArtistOnboarding', {
      stateMachineName: `${p}-artist-onboarding`,
      stateMachineType: StateMachineType.STANDARD,
      tracingEnabled: true,
      logs: { destination: sfnLogs, level: LogLevel.ALL, includeExecutionData: false },
      timeout: Duration.minutes(15),
      definitionBody: DefinitionBody.fromChainable(
        new LambdaInvoke(this, 'CreateArtistKey', {
          lambdaFunction: onboard,
          payloadResponseOnly: true,
          retryOnServiceExceptions: true,
        }),
      ),
    });
    acknowledge(
      this.onboarding,
      'Step Functions needs log delivery and X-Ray permissions that have no resource-level scoping.',
      'AwsSolutions-IAM5[Resource::*]',
      onboardArnFinding,
    );

    const params: Record<string, string> = {
      'keys/data-access-role-arn': this.dataAccessRole.roleArn,
      'keys/onboarding-state-machine-arn': this.onboarding.stateMachineArn,
    };

    // ── Phase 2 gate: cross-artist access must be refused by KMS (staging) ──
    if (!prod) {
      const gate = new BmgFunction(this, 'IsolationGate', {
        entry: 'services/keys/src/gate.ts',
        description: `BMG ${env}: proves KMS refuses cross-artist and private-item access`,
        roleName: gateRoleName,
        timeout: Duration.minutes(5),
        prod,
        environment: {
          DATA_ACCESS_ROLE_ARN: roleArn(dataAccessRoleName),
          ONBOARD_FUNCTION_NAME: onboard.functionName,
        },
      });
      onboard.grantInvoke(gate);
      gate.addToRolePolicy(
        new PolicyStatement({
          sid: 'TaggedDataAccessSessions',
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [this.dataAccessRole.roleArn],
        }),
      );
      acknowledge(
        gate.role!,
        'grantInvoke covers the function and its versions.',
        onboardArnFinding,
      );
      const run = new CustomResource(this, 'IsolationGateRun', {
        serviceToken: gate.functionArn,
        resourceType: 'Custom::BmgIsolationGate',
        properties: { version: props.version ?? 'unversioned' },
      });
      run.node.addDependency(this.dataAccessRole, onboard, onboard.role!, gate, gate.role!);
      params['keys/isolation-gate-function'] = gate.functionName;
      new CfnOutput(this, 'IsolationGateFunction', { value: gate.functionName });
    }

    for (const [key, value] of Object.entries(params)) {
      new StringParameter(this, key.replace(/\W/g, '-'), {
        parameterName: names.ssm(cfg, env, key),
        stringValue: value,
      });
    }
  }
}
