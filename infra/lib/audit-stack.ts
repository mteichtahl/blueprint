import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectLockRetention,
} from 'aws-cdk-lib/aws-s3';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface AuditStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly alarmTopic: ITopic;
}

/**
 * Per-environment event bus and audit archive (design 7.3, 15).
 * Security events (`source: bmg.audit`) go from the bus to a writer Lambda
 * that puts one object per event into an Object Lock bucket. Nothing in the
 * app can change or delete them during the retention period.
 */
export class AuditStack extends BmgStack {
  readonly bus: EventBus;
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: AuditStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;

    this.bus = new EventBus(this, 'Events', { eventBusName: `${p}-events` });

    const auditKey = new Key(this, 'AuditKey', {
      alias: `alias/${cfg.project}/${env}/audit`,
      description: `BMG ${env}: audit archive and dead-letter queue`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const accessLogs = new Bucket(this, 'AuditAccessLogs', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ expiration: Duration.days(365) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const lock = Duration.days(cfg.audit.retentionDays);
    this.bucket = new Bucket(this, 'AuditArchive', {
      encryption: BucketEncryption.KMS,
      encryptionKey: auditKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention:
        cfg.audit.objectLockMode === 'COMPLIANCE'
          ? ObjectLockRetention.compliance(lock)
          : ObjectLockRetention.governance(lock),
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'audit-archive/',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const writer = new BmgFunction(this, 'AuditWriter', {
      entry: 'services/api/src/handlers/audit-writer.ts',
      description: `BMG ${env}: write security events to the Object Lock archive`,
      prod,
      environment: { AUDIT_BUCKET: this.bucket.bucketName },
    });
    writer.addToRolePolicy(
      new PolicyStatement({
        sid: 'WriteAuditObjectsOnly',
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects('audit/*')],
      }),
    );
    auditKey.grant(writer, 'kms:GenerateDataKey');
    acknowledge(
      writer.role!,
      'One immutable object per audit event under audit/; the writer cannot read, overwrite (Object Lock) or delete.',
      `AwsSolutions-IAM5[Resource::<${this.getLogicalId(this.bucket.node.defaultChild as never)}.Arn>/audit/*]`,
    );

    const dlq = new Queue(this, 'AuditDeadLetters', {
      queueName: `${p}-audit-dlq`,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: auditKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    acknowledge(dlq, 'This is the dead-letter queue itself.', 'AwsSolutions-SQS3');

    new Rule(this, 'AuditToArchive', {
      eventBus: this.bus,
      description: 'Security events to the Object Lock archive',
      eventPattern: { source: ['bmg.audit'] },
      targets: [
        new LambdaFunction(writer, {
          deadLetterQueue: dlq,
          retryAttempts: 8,
          maxEventAge: Duration.hours(6),
        }),
      ],
    });

    new Alarm(this, 'AuditDeliveryFailures', {
      alarmName: `${p}-audit-delivery-failures`,
      alarmDescription: 'Audit events could not be written to the archive (see the DLQ).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));

    new StringParameter(this, 'EventBusName', {
      parameterName: names.ssm(cfg, env, 'audit/event-bus-name'),
      stringValue: this.bus.eventBusName,
    });
    new StringParameter(this, 'AuditBucketName', {
      parameterName: names.ssm(cfg, env, 'audit/bucket-name'),
      stringValue: this.bucket.bucketName,
    });
  }
}
