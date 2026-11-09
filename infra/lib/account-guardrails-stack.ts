import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { CfnAnalyzer } from 'aws-cdk-lib/aws-accessanalyzer';
import { Trail } from 'aws-cdk-lib/aws-cloudtrail';
import { CfnConfigurationRecorder, CfnDeliveryChannel } from 'aws-cdk-lib/aws-config';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SnsTopic } from 'aws-cdk-lib/aws-events-targets';
import { CfnDetector } from 'aws-cdk-lib/aws-guardduty';
import {
  AccountPrincipal,
  Effect,
  Group,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  CfnBucket,
  ObjectLockRetention,
} from 'aws-cdk-lib/aws-s3';
import { CfnHub, CfnStandard } from 'aws-cdk-lib/aws-securityhub';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { acknowledge, BmgStack, KMS_GRANT_FINDINGS, type BmgStackProps } from './common.ts';
import { createPermissionBoundary } from './permission-boundary.ts';

export interface AccountGuardrailsStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  /** Skip services already enabled in the account (detected by `blueprint account setup`). */
  readonly skip?: {
    guardDuty?: boolean;
    securityHub?: boolean;
    config?: boolean;
    accessAnalyzer?: boolean;
  };
}

/**
 * Account-level guardrails for the single BMG AWS account (design 4.2, 13.2, 15).
 * Deployed by an admin with `blueprint account setup`, never by the pipeline.
 */
export class AccountGuardrailsStack extends BmgStack {
  readonly alertsTopic: Topic;

  constructor(scope: Construct, id: string, props: AccountGuardrailsStackProps) {
    super(scope, id, {
      ...props,
      qualifier: props.config.toolingQualifier,
      envTag: 'account',
      applyBoundary: false, // admin and AWS service roles live here
    });
    const cfg = props.config;
    const skip = props.skip ?? {};

    const boundary = createPermissionBoundary(this, cfg);
    acknowledge(
      boundary,
      'A permission boundary is a ceiling, not a grant: Allow */* is required so the explicit Deny statements define the limits.',
      'AwsSolutions-IAM5[Action::*]',
      'AwsSolutions-IAM5[Resource::*]',
    );

    // ---- Audit key, alerts topic ------------------------------------------------
    const auditKey = new Key(this, 'AuditKey', {
      alias: `alias/${cfg.project}/audit`,
      description: 'Encrypts CloudTrail, the audit archive and security alerts',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const service of [
      'cloudtrail.amazonaws.com',
      'config.amazonaws.com',
      'events.amazonaws.com',
      'sns.amazonaws.com',
    ]) {
      auditKey.grant(
        new ServicePrincipal(service),
        'kms:GenerateDataKey*',
        'kms:Decrypt',
        'kms:DescribeKey',
      );
    }

    this.alertsTopic = new Topic(this, 'SecurityAlerts', {
      topicName: `${cfg.project}-security-alerts`,
      masterKey: auditKey,
      enforceSSL: true,
    });
    for (const email of cfg.alerts.emails) {
      this.alertsTopic.addSubscription(new EmailSubscription(email));
    }

    // ---- Audit archive (Object Lock) -------------------------------------------
    const accessLogs = new Bucket(this, 'AuditAccessLogs', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ expiration: Duration.days(365) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const lockDuration = Duration.days(cfg.audit.retentionDays);
    const auditBucket = new Bucket(this, 'AuditArchive', {
      encryption: BucketEncryption.KMS,
      encryptionKey: auditKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention:
        cfg.audit.objectLockMode === 'COMPLIANCE'
          ? ObjectLockRetention.compliance(lockDuration)
          : ObjectLockRetention.governance(lockDuration),
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'audit-archive/',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- CloudTrail --------------------------------------------------------------
    const trailLogs = new LogGroup(this, 'TrailLogs', {
      retention: RetentionDays.THREE_MONTHS,
      encryptionKey: auditKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    auditKey.grant(
      new ServicePrincipal(`logs.${this.region}.amazonaws.com`),
      'kms:Encrypt*',
      'kms:Decrypt*',
      'kms:ReEncrypt*',
      'kms:GenerateDataKey*',
      'kms:Describe*',
    );

    const trail = new Trail(this, 'Trail', {
      trailName: `${cfg.project}-account-trail`,
      bucket: auditBucket,
      s3KeyPrefix: 'cloudtrail',
      encryptionKey: auditKey,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: trailLogs,
    });
    trail.node.addDependency(auditKey);

    // ---- GuardDuty, Security Hub, Config, Access Analyzer ------------------------
    if (!skip.guardDuty) {
      new CfnDetector(this, 'GuardDuty', {
        enable: true,
        findingPublishingFrequency: 'FIFTEEN_MINUTES',
        features: [
          { name: 'S3_DATA_EVENTS', status: 'ENABLED' },
          { name: 'LAMBDA_NETWORK_LOGS', status: 'ENABLED' },
        ],
      });
    }

    if (!skip.securityHub) {
      const hub = new CfnHub(this, 'SecurityHub', {
        enableDefaultStandards: false,
        controlFindingGenerator: 'SECURITY_CONTROL',
        autoEnableControls: true,
      });
      for (const [sid, standard] of [
        ['Fsbp', 'aws-foundational-security-best-practices/v/1.0.0'],
        ['Cis', 'cis-aws-foundations-benchmark/v/3.0.0'],
      ] as const) {
        new CfnStandard(this, `Standard${sid}`, {
          standardsArn: `arn:aws:securityhub:${this.region}::standards/${standard}`,
        }).addResourceDependency(hub);
      }
    }

    if (!skip.config) {
      const configRole = new Role(this, 'ConfigRecorderRole', {
        assumedBy: new ServicePrincipal('config.amazonaws.com'),
        managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('service-role/AWS_ConfigRole')],
      });
      auditBucket.grantPut(configRole, 'config/*');
      auditBucket.addToResourcePolicy(
        new PolicyStatement({
          sid: 'ConfigAclCheck',
          principals: [new ServicePrincipal('config.amazonaws.com')],
          actions: ['s3:GetBucketAcl', 's3:ListBucket'],
          resources: [auditBucket.bucketArn],
          conditions: { StringEquals: { 'AWS:SourceAccount': this.account } },
        }),
      );
      auditBucket.addToResourcePolicy(
        new PolicyStatement({
          sid: 'ConfigWrite',
          principals: [new ServicePrincipal('config.amazonaws.com')],
          actions: ['s3:PutObject'],
          resources: [auditBucket.arnForObjects(`config/AWSLogs/${this.account}/Config/*`)],
          conditions: {
            StringEquals: {
              's3:x-amz-acl': 'bucket-owner-full-control',
              'AWS:SourceAccount': this.account,
            },
          },
        }),
      );
      const recorder = new CfnConfigurationRecorder(this, 'ConfigRecorder', {
        roleArn: configRole.roleArn,
        recordingGroup: { allSupported: true, includeGlobalResourceTypes: true },
      });
      const channel = new CfnDeliveryChannel(this, 'ConfigDelivery', {
        s3BucketName: auditBucket.bucketName,
        s3KeyPrefix: 'config',
        s3KmsKeyArn: auditKey.keyArn,
        configSnapshotDeliveryProperties: { deliveryFrequency: 'TwentyFour_Hours' },
      });
      channel.addResourceDependency(recorder);
      acknowledge(
        configRole,
        'AWS_ConfigRole is the AWS-maintained policy for the Config recorder.',
        'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWS_ConfigRole]',
      );
      const auditLogicalId = this.getLogicalId(auditBucket.node.defaultChild as CfnBucket);
      acknowledge(
        configRole,
        'Config delivery writes under the config/ prefix of the audit bucket using the audit KMS key; CDK grants emit action families.',
        ...KMS_GRANT_FINDINGS,
        'AwsSolutions-IAM5[Action::s3:Abort*]',
        `AwsSolutions-IAM5[Resource::<${auditLogicalId}.Arn>/config/*]`,
      );
    }

    // AWS allows one account-level analyzer per region; reuse an existing one.
    if (!skip.accessAnalyzer) {
      new CfnAnalyzer(this, 'AccessAnalyzer', {
        type: 'ACCOUNT',
        analyzerName: `${cfg.project}-account-analyzer`,
      });
    }

    // ---- Alerts: high-severity GuardDuty and critical Security Hub findings -------
    new Rule(this, 'GuardDutyHighFindings', {
      description: 'GuardDuty findings with severity >= 7',
      eventPattern: {
        source: ['aws.guardduty'],
        detailType: ['GuardDuty Finding'],
        detail: { severity: [{ numeric: ['>=', 7] }] },
      },
      targets: [new SnsTopic(this.alertsTopic)],
    });
    new Rule(this, 'SecurityHubCriticalFindings', {
      description: 'New critical Security Hub findings',
      eventPattern: {
        source: ['aws.securityhub'],
        detailType: ['Security Hub Findings - Imported'],
        detail: {
          findings: {
            Severity: { Label: ['CRITICAL'] },
            Workflow: { Status: ['NEW'] },
            RecordState: ['ACTIVE'],
          },
        },
      },
      targets: [new SnsTopic(this.alertsTopic)],
    });

    // ---- Human access: MFA-only admin and read-only roles -------------------------
    const mfa = {
      Bool: { 'aws:MultiFactorAuthPresent': 'true' },
      NumericLessThan: { 'aws:MultiFactorAuthAge': '43200' },
    };
    const adminRole = new Role(this, 'AdminRole', {
      roleName: `${cfg.project}-admin`,
      description: 'Break-glass and setup admin. Assumable only with MFA.',
      assumedBy: new AccountPrincipal(this.account).withConditions(mfa),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
      maxSessionDuration: Duration.hours(4),
    });
    const readOnlyRole = new Role(this, 'ReadOnlyRole', {
      roleName: `${cfg.project}-readonly`,
      description: 'Day-to-day read-only access. Assumable only with MFA.',
      assumedBy: new AccountPrincipal(this.account).withConditions(mfa),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
      maxSessionDuration: Duration.hours(8),
    });

    const admins = new Group(this, 'Admins', { groupName: `${cfg.project}-admins` });
    admins.addToPolicy(
      new PolicyStatement({
        sid: 'AssumeAdminRolesWithMfa',
        actions: ['sts:AssumeRole'],
        resources: [adminRole.roleArn, readOnlyRole.roleArn],
        conditions: { Bool: { 'aws:MultiFactorAuthPresent': 'true' } },
      }),
    );
    admins.addToPolicy(
      new PolicyStatement({
        sid: 'ManageOwnCredentials',
        actions: [
          'iam:GetUser',
          'iam:ChangePassword',
          'iam:GetAccountPasswordPolicy',
          'iam:ListMFADevices',
          'iam:ListVirtualMFADevices',
          'iam:CreateVirtualMFADevice',
          'iam:EnableMFADevice',
          'iam:ResyncMFADevice',
          'iam:ListAccessKeys',
          'iam:CreateAccessKey',
          'iam:DeleteAccessKey',
          'iam:UpdateAccessKey',
        ],
        resources: [
          `arn:aws:iam::${this.account}:user/\${aws:username}`,
          `arn:aws:iam::${this.account}:mfa/*`,
        ],
      }),
    );
    admins.addToPolicy(
      new PolicyStatement({
        sid: 'DenyEverythingElseWithoutMfa',
        effect: Effect.DENY,
        notActions: [
          'iam:GetUser',
          'iam:ChangePassword',
          'iam:GetAccountPasswordPolicy',
          'iam:ListMFADevices',
          'iam:ListVirtualMFADevices',
          'iam:CreateVirtualMFADevice',
          'iam:EnableMFADevice',
          'iam:ResyncMFADevice',
          'sts:GetSessionToken',
        ],
        resources: ['*'],
        conditions: { BoolIfExists: { 'aws:MultiFactorAuthPresent': 'false' } },
      }),
    );

    // ---- cdk-nag acknowledgements (each with a reason) ---------------------------
    acknowledge(
      adminRole,
      'Break-glass admin role intentionally uses AdministratorAccess; assumable only with MFA.',
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AdministratorAccess]',
    );
    acknowledge(
      readOnlyRole,
      'Day-to-day read-only role uses the AWS managed ReadOnlyAccess job-function policy; MFA required.',
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/ReadOnlyAccess]',
    );
    acknowledge(
      admins,
      'Users must be able to register their own virtual MFA device, whose ARN is only known by name pattern.',
      `AwsSolutions-IAM5[Resource::arn:aws:iam::${cfg.account.id}:mfa/*]`,
    );
  }
}
