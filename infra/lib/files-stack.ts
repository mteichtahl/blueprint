import { CfnOutput, CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { IEventBus } from 'aws-cdk-lib/aws-events';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { CfnMalwareProtectionPlan } from 'aws-cdk-lib/aws-guardduty';
import {
  AnyPrincipal,
  Effect,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
} from 'aws-cdk-lib/aws-s3';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface FilesStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly mainTable: ITable;
  readonly bus: IEventBus;
  readonly alarmTopic: ITopic;
  /** `bmg-<env>-data-access`, from the keys stack. */
  readonly dataAccessRoleArn: string;
  /** Git commit being deployed; re-runs the files gate on every staging deploy. */
  readonly version?: string;
}

/**
 * File storage and the malware scan (design 9.2, 9.3, F2):
 * - `quarantine`: every upload lands here first, through a presigned POST.
 *   GuardDuty Malware Protection for S3 scans each new object. Only the
 *   scanner and the promoter can read it; objects expire after 7 days.
 * - `artist-data`: clean artist files, each encrypted with that artist's own
 *   KMS key and encryption context. Only data-access sessions tagged with
 *   the artist can read or write the artist's prefix.
 * - `org-data`: BMG's document library, under the platform key.
 * - The promoter moves a clean file to its real bucket, or deletes it.
 */
export class FilesStack extends BmgStack {
  readonly quarantine: Bucket;
  readonly quarantineKey: Key;
  readonly artistData: Bucket;
  readonly orgData: Bucket;

  constructor(scope: Construct, id: string, props: FilesStackProps) {
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
    const scannerRoleName = `${p}-malware-scan`;
    // Matches `<p>-api-*`, the pattern the data-access role trusts.
    const promoterRoleName = `${p}-api-files-promote`;

    const accessLogs = new Bucket(this, 'FilesAccessLogs', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(prod ? 365 : 30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── Quarantine ──
    this.quarantineKey = new Key(this, 'QuarantineKey', {
      alias: `alias/${cfg.project}/${env}/quarantine`,
      description: `BMG ${env}: uploads waiting for the malware scan`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const appOrigins = [
      `https://${names.host(cfg, env, 'app')}`,
      // The web app is served from its CloudFront domain until DNS is set up.
      'https://*.cloudfront.net',
      ...(prod ? [] : ['http://localhost:5173']),
    ];
    this.quarantine = new Bucket(this, 'Quarantine', {
      bucketName: names.bucket(cfg, env, 'quarantine'),
      encryption: BucketEncryption.KMS,
      encryptionKey: this.quarantineKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'quarantine/',
      // Browsers upload straight to S3 with a presigned POST (design 9.3).
      cors: [
        {
          allowedMethods: [HttpMethods.POST],
          allowedOrigins: appOrigins,
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ── Real homes ──
    this.artistData = new Bucket(this, 'ArtistData', {
      bucketName: names.bucket(cfg, env, 'artist-data'),
      // Default encryption only covers writes that don't name a key; the app
      // always names the artist's key, and the policy below insists on SSE-KMS.
      encryption: BucketEncryption.KMS,
      encryptionKey: props.platformKey,
      // Off: each object carries its own artist encryption context (artistId,
      // and visibility=private where it applies), which KMS checks on decrypt.
      bucketKeyEnabled: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'artist-data/',
      // The app reads images through presigned links (brand kit PDF, profile
      // pictures); that fetch needs CORS. Links are still presigned and short-lived.
      cors: [
        {
          allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: appOrigins,
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(35) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.artistData.addToResourcePolicy(
      new PolicyStatement({
        sid: 'ArtistObjectsOnlyThroughDataAccessSessions',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
        resources: [this.artistData.arnForObjects('artists/*')],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': props.dataAccessRoleArn } },
      }),
    );
    this.artistData.addToResourcePolicy(
      new PolicyStatement({
        sid: 'ArtistObjectsUseKms',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.artistData.arnForObjects('*')],
        conditions: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
      }),
    );

    this.orgData = new Bucket(this, 'OrgData', {
      bucketName: names.bucket(cfg, env, 'org-data'),
      encryption: BucketEncryption.KMS,
      encryptionKey: props.platformKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'org-data/',
      // As for artist data: library images are read in the browser (profile pictures).
      cors: [
        {
          allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: appOrigins,
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(35) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── Data-access sessions may use their own artist's prefix (and nothing else) ──
    const prefix = 'artists/${aws:PrincipalTag/artistId}/*';
    new Policy(this, 'DataAccessArtistFiles', {
      roles: [Role.fromRoleArn(this, 'DataAccessRole', props.dataAccessRoleArn)],
      statements: [
        new PolicyStatement({
          sid: 'OwnArtistObjects',
          // Delete: artists remove their own uploads (versioned bucket, so recoverable for 35 days).
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [this.artistData.arnForObjects(prefix)],
        }),
        new PolicyStatement({
          // Lets a missing object read as 404 rather than 403.
          sid: 'ListOwnArtistPrefix',
          actions: ['s3:ListBucket'],
          resources: [this.artistData.bucketArn],
          conditions: { StringLike: { 's3:prefix': [prefix] } },
        }),
      ],
    });
    acknowledge(
      this.node.findChild('DataAccessArtistFiles'),
      "Scoped to the session's own artist prefix by the artistId session tag.",
      `AwsSolutions-IAM5[Resource::<${this.getLogicalId(this.artistData.node.defaultChild as never)}.Arn>/artists/<aws:PrincipalTag/artistId>/*]`,
    );

    // ── GuardDuty Malware Protection for S3 ──
    const scanner = new Role(this, 'MalwareScanRole', {
      roleName: scannerRoleName,
      description: `BMG ${env}: GuardDuty Malware Protection scans the quarantine bucket`,
      assumedBy: new ServicePrincipal('malware-protection-plan.guardduty.amazonaws.com'),
    });
    const guardDutyRules = `arn:aws:events:${this.region}:${this.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`;
    scanner.addToPolicy(
      new PolicyStatement({
        sid: 'ManagedRuleForS3Events',
        actions: [
          'events:PutRule',
          'events:DeleteRule',
          'events:PutTargets',
          'events:RemoveTargets',
        ],
        resources: [guardDutyRules],
        conditions: {
          StringLike: { 'events:ManagedBy': 'malware-protection-plan.guardduty.amazonaws.com' },
        },
      }),
    );
    scanner.addToPolicy(
      new PolicyStatement({
        sid: 'MonitorManagedRule',
        actions: ['events:DescribeRule', 'events:ListTargetsByRule'],
        resources: [guardDutyRules],
      }),
    );
    scanner.addToPolicy(
      new PolicyStatement({
        sid: 'ScanAndTag',
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObjectTagging',
          's3:GetObjectTagging',
          's3:PutObjectVersionTagging',
          's3:GetObjectVersionTagging',
        ],
        resources: [this.quarantine.arnForObjects('*')],
      }),
    );
    scanner.addToPolicy(
      new PolicyStatement({
        sid: 'BucketSetup',
        actions: ['s3:PutBucketNotification', 's3:GetBucketNotification', 's3:ListBucket'],
        resources: [this.quarantine.bucketArn],
      }),
    );
    scanner.addToPolicy(
      new PolicyStatement({
        sid: 'ValidationObject',
        actions: ['s3:PutObject'],
        resources: [this.quarantine.arnForObjects('malware-protection-resource-validation-object')],
      }),
    );
    scanner.addToPolicy(
      new PolicyStatement({
        sid: 'DecryptForScan',
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: [this.quarantineKey.keyArn],
        conditions: { StringLike: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` } },
      }),
    );
    acknowledge(
      scanner,
      'GuardDuty manages its own EventBridge rule (fixed name prefix) and scans and tags every object in the quarantine bucket, per the AWS-documented role.',
      `AwsSolutions-IAM5[Resource::${guardDutyRules}]`,
      `AwsSolutions-IAM5[Resource::<${this.getLogicalId(this.quarantine.node.defaultChild as never)}.Arn>/*]`,
    );

    const plan = new CfnMalwareProtectionPlan(this, 'MalwareProtection', {
      role: scanner.roleArn,
      protectedResource: { s3Bucket: { bucketName: this.quarantine.bucketName } },
      actions: { tagging: { status: 'ENABLED' } },
    });
    plan.node.addDependency(scanner);

    // ── Promoter ──
    const promoter = new BmgFunction(this, 'FilesPromote', {
      entry: 'services/api/src/handlers/files-promote.ts',
      description: `BMG ${env}: move scanned uploads out of quarantine`,
      roleName: promoterRoleName,
      timeout: Duration.minutes(5),
      memorySize: 1024,
      prod,
      environment: {
        PROJECT: cfg.project,
        BMG_ENV: env,
        ACCOUNT_ID: this.account,
        MAIN_TABLE: props.mainTable.tableName,
        EVENT_BUS: props.bus.eventBusName,
        QUARANTINE_BUCKET: this.quarantine.bucketName,
        ARTIST_BUCKET: this.artistData.bucketName,
        LIBRARY_BUCKET: this.orgData.bucketName,
        DATA_ACCESS_ROLE_ARN: props.dataAccessRoleArn,
      },
    });
    const allow = (sid: string, actions: string[], resources: string[]) =>
      promoter.addToRolePolicy(new PolicyStatement({ sid, actions, resources }));
    allow(
      'ReadAndClearQuarantine',
      ['s3:GetObject', 's3:DeleteObject'],
      [this.quarantine.arnForObjects('*')],
    );
    allow('ListQuarantine', ['s3:ListBucket'], [this.quarantine.bucketArn]);
    allow(
      'WriteLibrary',
      ['s3:PutObject', 's3:GetObject'],
      [this.orgData.arnForObjects('library/*')],
    );
    allow('ListLibrary', ['s3:ListBucket'], [this.orgData.bucketArn]);
    allow('FileRecords', ['dynamodb:GetItem', 'dynamodb:UpdateItem'], [props.mainTable.tableArn]);
    allow('PublishAudit', ['events:PutEvents'], [props.bus.eventBusArn]);
    allow('ArtistSessions', ['sts:AssumeRole', 'sts:TagSession'], [props.dataAccessRoleArn]);
    this.quarantineKey.grant(promoter, 'kms:Decrypt');
    props.platformKey.grant(promoter, 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey');
    acknowledge(
      promoter.role!,
      'The promoter reads and deletes any object in quarantine and writes under library/ in org-data; artist files are written through tagged data-access sessions.',
      `AwsSolutions-IAM5[Resource::<${this.getLogicalId(this.quarantine.node.defaultChild as never)}.Arn>/*]`,
      `AwsSolutions-IAM5[Resource::<${this.getLogicalId(this.orgData.node.defaultChild as never)}.Arn>/library/*]`,
    );

    // Only the scanner and the promoter can read unscanned uploads.
    this.quarantine.addToResourcePolicy(
      new PolicyStatement({
        sid: 'OnlyScannerAndPromoterRead',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [this.quarantine.arnForObjects('*')],
        conditions: {
          ArnNotEquals: {
            'aws:PrincipalArn': [roleArn(scannerRoleName), roleArn(promoterRoleName)],
          },
        },
      }),
    );
    this.quarantine.addToResourcePolicy(
      new PolicyStatement({
        sid: 'OnlyTheQuarantineKey',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.quarantine.arnForObjects('*')],
        conditions: {
          StringNotEqualsIfExists: {
            's3:x-amz-server-side-encryption-aws-kms-key-id': this.quarantineKey.keyArn,
          },
        },
      }),
    );

    const dlq = new Queue(this, 'PromoteDeadLetters', {
      queueName: `${p}-files-promote-dlq`,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: props.platformKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    acknowledge(dlq, 'This is the dead-letter queue itself.', 'AwsSolutions-SQS3');
    new Rule(this, 'ScanResults', {
      description: 'GuardDuty scan results for the quarantine bucket',
      eventPattern: {
        source: ['aws.guardduty'],
        detailType: ['GuardDuty Malware Protection Object Scan Result'],
        detail: { s3ObjectDetails: { bucketName: [this.quarantine.bucketName] } },
      },
      targets: [
        new LambdaFunction(promoter, {
          deadLetterQueue: dlq,
          retryAttempts: 8,
          maxEventAge: Duration.hours(6),
        }),
      ],
    });
    new Alarm(this, 'PromoteFailures', {
      alarmName: `${p}-files-promote-failures`,
      alarmDescription: 'Scanned uploads could not be moved out of quarantine (see the DLQ).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));

    // ── Phase 3 gate (staging): stored files keep the artist boundary and "private" ──
    if (!prod) {
      const gate = new BmgFunction(this, 'FilesGate', {
        entry: 'services/keys/src/files-gate.ts',
        description: `BMG ${env}: proves S3 file access is held to each artist's key`,
        roleName: `${p}-files-gate`,
        timeout: Duration.minutes(5),
        prod,
        environment: {
          PROJECT: cfg.project,
          BMG_ENV: env,
          ACCOUNT_ID: this.account,
          ARTIST_BUCKET: this.artistData.bucketName,
          DATA_ACCESS_ROLE_ARN: props.dataAccessRoleArn,
        },
      });
      gate.addToRolePolicy(
        new PolicyStatement({
          sid: 'TaggedDataAccessSessions',
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [props.dataAccessRoleArn],
        }),
      );
      const run = new CustomResource(this, 'FilesGateRun', {
        serviceToken: gate.functionArn,
        resourceType: 'Custom::BmgFilesGate',
        properties: { version: props.version ?? 'unversioned' },
      });
      run.node.addDependency(
        this.artistData,
        this.node.findChild('DataAccessArtistFiles'),
        gate,
        gate.role!,
      );
      new CfnOutput(this, 'FilesGateFunction', { value: gate.functionName });
      new StringParameter(this, 'files-gate-function', {
        parameterName: names.ssm(cfg, env, 'files/gate-function'),
        stringValue: gate.functionName,
      });
    }

    for (const [key, value] of Object.entries({
      'files/quarantine-bucket': this.quarantine.bucketName,
      'files/artist-data-bucket': this.artistData.bucketName,
      'files/org-data-bucket': this.orgData.bucketName,
    })) {
      new StringParameter(this, key.replace(/\W/g, '-'), {
        parameterName: names.ssm(cfg, env, key),
        stringValue: value,
      });
    }
  }
}
