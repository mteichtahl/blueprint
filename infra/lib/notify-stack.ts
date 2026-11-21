import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { EventApi } from 'aws-cdk-lib/aws-appsync';
import type { IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, type IEventBus } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import { FilterCriteria, FilterRule, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface NotifyStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly mainTable: ITable;
  /** Contact lookup for artists who have no CONTACT record yet. */
  readonly userPool: IUserPool;
  readonly bus: IEventBus;
  readonly alarmTopic: ITopic;
  /** The API's AppSync Events API, for live-update nudges (rev 17). */
  readonly realtime: EventApi;
}

/** Partition-key prefixes that can change what a screen shows (services/api/src/live/model.ts). */
export const LIVE_PK_PREFIXES = ['ARTIST#', 'ORG#', 'EVENT#', 'INVITE#', 'REVIEW#'];

/** To-do events that become branded emails (services/notify). */
export const NOTIFY_DETAIL_TYPES = [
  'todo.updated',
  'todo.reminder',
  // Submission events go to the API stack's notifier (bell, preferences, quiet hours),
  // so an artist gets one email per change, not two.
];

/**
 * Notifications (design 7.3): workspace events on the environment's bus go to
 * one Lambda that sends BMG-branded email through Gmail SMTP. It reads only
 * the to-do, submission title and contact record it needs. Failed sends are
 * retried for 6 hours, then parked on an encrypted dead-letter queue with an
 * alarm.
 */
export class NotifyStack extends BmgStack {
  constructor(scope: Construct, id: string, props: NotifyStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;
    const webUrlParam = names.ssm(cfg, env, 'web/url');
    const smtpSecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${names.smtpSecret(cfg, env)}-*`;

    const notifier = new BmgFunction(this, 'Notifier', {
      entry: 'services/notify/src/handler.ts',
      description: `BMG ${env}: branded email for to-do changes, reminders and review updates`,
      prod,
      timeout: Duration.seconds(30),
      environment: {
        MAIN_TABLE: props.mainTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        SMTP_SECRET_ID: names.smtpSecret(cfg, env),
        APP_URL_PARAM: webUrlParam,
        APP_ORIGIN: `https://${names.webHost(cfg, env, 'artist')}`,
        ADMIN_ORIGIN: `https://${names.webHost(cfg, env, 'admin')}`,
        BMG_NOTIFY_ADDRESS: cfg.email.senderAddress,
      },
    });
    notifier.addToRolePolicy(
      new PolicyStatement({
        sid: 'ReadWorkspaceItems',
        // UpdateItem: saves a contact found in the user pool (artists invited before contacts existed).
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [props.mainTable.tableArn],
      }),
    );
    notifier.addToRolePolicy(
      new PolicyStatement({
        sid: 'FindArtistContact',
        actions: ['cognito-idp:ListUsersInGroup'],
        resources: [props.userPool.userPoolArn],
      }),
    );
    notifier.addToRolePolicy(
      new PolicyStatement({
        sid: 'ReadSmtpSecret',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [smtpSecretArn],
      }),
    );
    notifier.addToRolePolicy(
      new PolicyStatement({
        sid: 'ReadAppUrl',
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${webUrlParam}`],
      }),
    );
    // The main table and the SMTP secret are both under the platform key.
    props.platformKey.grant(notifier, 'kms:Decrypt');
    acknowledge(
      notifier.role!,
      'Secrets Manager appends a random suffix to secret ARNs; the wildcard matches only that suffix of the one SMTP secret.',
      `AwsSolutions-IAM5[Resource::${smtpSecretArn}]`,
    );

    const dlqKey = new Key(this, 'NotifyKey', {
      alias: `alias/${cfg.project}/${env}/notify`,
      description: `BMG ${env}: notification dead-letter queue`,
      enableKeyRotation: true,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    // EventBridge writes failed events to the queue, so it must be able to use the key.
    dlqKey.grant(
      new ServicePrincipal('events.amazonaws.com'),
      'kms:GenerateDataKey',
      'kms:Decrypt',
    );
    const dlq = new Queue(this, 'NotifyDeadLetters', {
      queueName: `${p}-notify-dlq`,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: dlqKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    acknowledge(dlq, 'This is the dead-letter queue itself.', 'AwsSolutions-SQS3');

    new Rule(this, 'WorkspaceEventsToNotifier', {
      eventBus: props.bus,
      description: 'To-do changes, reminders and review updates to branded email',
      eventPattern: { source: ['bmg.workspace'], detailType: NOTIFY_DETAIL_TYPES },
      targets: [
        new LambdaFunction(notifier, {
          deadLetterQueue: dlq,
          retryAttempts: 8,
          maxEventAge: Duration.hours(6),
        }),
      ],
    });

    new Alarm(this, 'NotifyDeliveryFailures', {
      alarmName: `${p}-notify-delivery-failures`,
      alarmDescription: 'Notification emails could not be sent (see the DLQ).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));

    // ── Live updates (rev 17): table changes → realtime nudges, so open screens refresh ──
    const live = new BmgFunction(this, 'Live', {
      entry: 'services/api/src/handlers/live.ts',
      description: `BMG ${env}: live-update nudges (topic and artist id only) from main-table changes`,
      prod,
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: { EVENTS_HTTP_DOMAIN: props.realtime.httpDns },
    });
    // Reading the stream needs the table's key; the handler reads keys only, never item content.
    live.addEventSource(
      new DynamoEventSource(props.mainTable, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 100,
        retryAttempts: 2,
        filters: [
          FilterCriteria.filter({
            dynamodb: {
              Keys: { PK: { S: LIVE_PK_PREFIXES.flatMap((p) => FilterRule.beginsWith(p)) } },
            },
          }),
        ],
      }),
    );
    props.platformKey.grant(live, 'kms:Decrypt');
    // Publish only, and only to the inbox namespace (the per-person channels).
    live.addToRolePolicy(
      new PolicyStatement({
        sid: 'PublishLiveNudges',
        actions: ['appsync:EventPublish'],
        resources: [`${props.realtime.apiArn}/channelNamespace/inbox`],
      }),
    );
  }
}
