import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, type IEventBus } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, KMS_GRANT_FINDINGS, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface MeetingsStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly quarantineKey: IKey;
  readonly mainTable: ITable;
  readonly bus: IEventBus;
  readonly alarmTopic: ITopic;
}

/**
 * Meeting transcripts (rev 11). The worker sends a meeting's recording to
 * Amazon Transcribe in Sydney and files the transcript:
 *
 * - **Work bucket:** the only place Transcribe reads from and writes to, with
 *   its own key (as quarantine has), so Transcribe never touches an artist's
 *   key. Copies are deleted as soon as a job ends, and anything left expires
 *   after 3 days.
 * - **Worker:** started when a recording passes the malware scan, when
 *   someone asks to try again, and when a job finishes. It reads recordings
 *   and writes transcripts through tagged data-access sessions, like every
 *   other reader of artist data. Before each job it checks the artists' AI
 *   choice and the account's AWS AI opt-out, and does nothing without both.
 *
 * The meetings API function lives here too, for the same reason: the API
 * stack is at its resource guardrail, so it only holds the two routes.
 */
export class MeetingsStack extends BmgStack {
  readonly workKey: Key;
  readonly workBucket: Bucket;
  readonly worker: BmgFunction;
  /** The meetings API (`/meetings`, routed by the API stack). */
  readonly api: BmgFunction;

  constructor(scope: Construct, id: string, props: MeetingsStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;
    const main = props.mainTable.tableArn;
    const bucket = (kind: 'quarantine' | 'artist-data' | 'org-data') =>
      names.bucket(cfg, env, kind);
    const dataAccessRoleArn = `arn:aws:iam::${this.account}:role/${p}-data-access`;

    const accessLogs = new Bucket(this, 'MeetingsAccessLogs', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(prod ? 365 : 30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.workKey = new Key(this, 'WorkKey', {
      alias: `alias/${cfg.project}/${env}/meetings-work`,
      description: `BMG ${env}: meeting recordings and transcripts while Transcribe works on them`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.workBucket = new Bucket(this, 'Work', {
      bucketName: `${p}-meetings-work-${this.account}`,
      encryption: BucketEncryption.KMS,
      encryptionKey: this.workKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(3) }],
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'work/',
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Matches `<p>-api-*`; listed in DATA_ACCESS_CALLERS (keys stack).
    this.worker = new BmgFunction(this, 'MeetingsWorker', {
      entry: 'services/api/src/handlers/meetings-worker.ts',
      description: `BMG ${env}: transcribe meeting recordings and file the transcript`,
      roleName: `${p}-api-meetings-worker`,
      prod,
      bundleAwsSdk: true,
      // Copies a recording of up to 500 MB into the work bucket.
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: {
        PROJECT: cfg.project,
        BMG_ENV: env,
        ACCOUNT_ID: this.account,
        MAIN_TABLE: props.mainTable.tableName,
        EVENT_BUS: props.bus.eventBusName,
        DATA_ACCESS_ROLE_ARN: dataAccessRoleArn,
        ARTIST_BUCKET: bucket('artist-data'),
        LIBRARY_BUCKET: bucket('org-data'),
        QUARANTINE_BUCKET: bucket('quarantine'),
        QUARANTINE_KEY_ARN: props.quarantineKey.keyArn,
        WORK_BUCKET: this.workBucket.bucketName,
        WORK_KEY_ARN: this.workKey.keyArn,
      },
    });
    const fn = this.worker;
    const allow = (sid: string, actions: string[], resources: string[]) =>
      fn.addToRolePolicy(new PolicyStatement({ sid, actions, resources }));

    allow(
      'MeetingItems',
      [
        'dynamodb:GetItem',
        // Each artist's AI choice (ARTIST#id / AI).
        'dynamodb:BatchGetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      ],
      [main],
    );
    allow('ArtistSessions', ['sts:AssumeRole', 'sts:TagSession'], [dataAccessRoleArn]);
    // Blueprint-only meetings: their recordings (library/) and content (meetings/) in org-data.
    const libraryRecordings = `arn:aws:s3:::${bucket('org-data')}/library/*`;
    const libraryContent = `arn:aws:s3:::${bucket('org-data')}/meetings/*`;
    allow('LibraryRecordings', ['s3:GetObject'], [libraryRecordings]);
    allow(
      'LibraryMeetingContent',
      ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      [libraryContent],
    );
    props.platformKey.grant(fn, 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey');
    // The meeting note is filed like an upload: into quarantine, then scanned.
    const quarantineObjects = ['artists/*', 'library/*'].map(
      (k) => `arn:aws:s3:::${bucket('quarantine')}/${k}`,
    );
    allow('FileTheNote', ['s3:PutObject'], quarantineObjects);
    props.quarantineKey.grant(fn, 'kms:GenerateDataKey');
    // Transcribe reads the recording and writes the transcript as this role.
    this.workBucket.grantReadWrite(fn);
    this.workBucket.grantDelete(fn);
    this.workKey.grant(fn, 'kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey');
    const jobs = `arn:aws:transcribe:${this.region}:${this.account}:transcription-job/${p}-meeting-*`;
    allow(
      'TranscriptionJobs',
      [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
        'transcribe:DeleteTranscriptionJob',
        'transcribe:TagResource',
      ],
      [jobs],
    );
    // The AWS AI services opt-out (blueprint ai opt-out): checked before every job.
    allow('ReadAiOptOut', ['organizations:DescribeEffectivePolicy'], ['*']);
    allow('PublishEvents', ['events:PutEvents'], [props.bus.eventBusArn]);

    // ── The meetings API (Blueprint only), routed by the API stack ──
    this.api = new BmgFunction(this, 'Meetings', {
      entry: 'services/api/src/handlers/meetings.ts',
      description: `BMG ${env} API: meeting notes, transcripts, summaries and plan suggestions`,
      // Matches `<p>-api-*`; listed in DATA_ACCESS_CALLERS (keys stack).
      roleName: `${p}-api-meetings`,
      prod,
      bundleAwsSdk: true,
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        PROJECT: cfg.project,
        BMG_ENV: env,
        ACCOUNT_ID: this.account,
        MAIN_TABLE: props.mainTable.tableName,
        EVENT_BUS: props.bus.eventBusName,
        DATA_ACCESS_ROLE_ARN: dataAccessRoleArn,
        ARTIST_BUCKET: bucket('artist-data'),
        LIBRARY_BUCKET: bucket('org-data'),
        QUARANTINE_BUCKET: bucket('quarantine'),
        QUARANTINE_KEY_ARN: props.quarantineKey.keyArn,
      },
    });
    const api = this.api;
    const allowApi = (sid: string, actions: string[], resources: string[]) =>
      api.addToRolePolicy(new PolicyStatement({ sid, actions, resources }));
    allowApi(
      'MeetingItems',
      [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
      ],
      [main],
    );
    // GSI3 MEETINGS: every meeting, newest first.
    allowApi('MeetingsList', ['dynamodb:Query'], [`${main}/index/GSI3`]);
    allowApi('ArtistSessions', ['sts:AssumeRole', 'sts:TagSession'], [dataAccessRoleArn]);
    allowApi(
      'LibraryMeetingContent',
      ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      [libraryContent],
    );
    props.platformKey.grant(api, 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey');
    allowApi('FileTheNote', ['s3:PutObject'], quarantineObjects);
    props.quarantineKey.grant(api, 'kms:GenerateDataKey');
    allowApi('PublishEvents', ['events:PutEvents'], [props.bus.eventBusArn]);
    acknowledge(
      api.role!,
      'Blueprint-only meeting content lives under meetings/ in org-data; notes are filed into quarantine under artists/ and library/; artist content goes through tagged data-access sessions.',
      ...[libraryContent, ...quarantineObjects].map((r) => `AwsSolutions-IAM5[Resource::${r}]`),
      ...KMS_GRANT_FINDINGS,
    );

    const dlq = new Queue(this, 'MeetingsDeadLetters', {
      queueName: `${p}-meetings-dlq`,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: props.platformKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    acknowledge(dlq, 'This is the dead-letter queue itself.', 'AwsSolutions-SQS3');
    const target = () =>
      new LambdaFunction(fn, {
        deadLetterQueue: dlq,
        retryAttempts: 4,
        maxEventAge: Duration.hours(2),
      });
    new Rule(this, 'RecordingsSettled', {
      description: 'A meeting recording passed (or failed) the malware scan; a retry was asked for',
      eventBus: props.bus,
      eventPattern: {
        source: ['bmg.audit', 'bmg.meetings'],
        detailType: ['file.available', 'file.rejected', 'meeting.transcribe'],
      },
      targets: [target()],
    });
    // Transcribe reports on the account's default bus.
    new Rule(this, 'TranscriptionJobs', {
      description: "This environment's meeting transcription jobs finished or failed",
      eventPattern: {
        source: ['aws.transcribe'],
        detailType: ['Transcribe Job State Change'],
        detail: {
          TranscriptionJobName: [{ prefix: `${p}-meeting-` }],
          TranscriptionJobStatus: ['COMPLETED', 'FAILED'],
        },
      },
      targets: [target()],
    });
    new Alarm(this, 'MeetingsFailures', {
      alarmName: `${p}-meetings-failures`,
      alarmDescription: 'Meeting recordings could not be transcribed or filed (see the DLQ).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));

    acknowledge(
      fn.role!,
      'Transcription jobs are named <project>-<env>-meeting-<space>-<id>-<n>; work objects live under jobs/; library recordings and meeting content are read under their own org-data prefixes; notes go into quarantine under artists/ and library/. DescribeEffectivePolicy has no resource-level permissions.',
      `AwsSolutions-IAM5[Resource::${jobs}]`,
      `AwsSolutions-IAM5[Resource::${libraryRecordings}]`,
      `AwsSolutions-IAM5[Resource::${libraryContent}]`,
      ...quarantineObjects.map((r) => `AwsSolutions-IAM5[Resource::${r}]`),
      'AwsSolutions-IAM5[Resource::*]',
      'AwsSolutions-IAM5[Action::s3:GetObject*]',
      'AwsSolutions-IAM5[Action::s3:GetBucket*]',
      'AwsSolutions-IAM5[Action::s3:List*]',
      'AwsSolutions-IAM5[Action::s3:DeleteObject*]',
      'AwsSolutions-IAM5[Action::s3:Abort*]',
      `AwsSolutions-IAM5[Resource::<${this.getLogicalId(this.workBucket.node.defaultChild as never)}.Arn>/*]`,
      ...KMS_GRANT_FINDINGS,
    );
  }
}
