import { Duration } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, type IEventBus } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface OffboardingStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly mainTable: ITable;
  readonly bus: IEventBus;
  readonly userPool: IUserPool;
  readonly alarmTopic: ITopic;
  /** The release, written into each archive's manifest. */
  readonly version?: string;
}

/**
 * Deleting an artist (rev 22), in its own stack because the API stack is at
 * its resource guardrail. The API locks the artist and puts
 * `artist.deleteRequested` on the bus; this worker then:
 * 1. deletes their knowledge base and lists Blueprint documents that mention them;
 * 2. archives their data and files inside their own prefix of the artist bucket
 *    (server-side copies under their own key, tagged for the 7-year lifecycle rule);
 * 3. takes them out of chats, library sharing and staff assignments;
 * 4. deletes their live data and files; 5. deletes their login.
 *
 * Its role name is `<p>-api-offboarding`, the pattern the data-access role
 * trusts, so it can open the artist sessions the copies need.
 */
export class OffboardingStack extends BmgStack {
  readonly worker: BmgFunction;

  constructor(scope: Construct, id: string, props: OffboardingStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;
    const home = cfg.account.homeRegion;
    const account = this.account;
    const main = props.mainTable.tableArn;
    const kbArn = `arn:aws:bedrock:${home}:${account}:knowledge-base/*`;
    const vectorIndexes = `arn:aws:s3vectors:${home}:${account}:bucket/${p}-vectors/index/*`;
    const smtpSecretArn = `arn:aws:secretsmanager:${home}:${account}:secret:${names.smtpSecret(cfg, env)}-*`;
    const webUrlParam = names.ssm(cfg, env, 'web/url');

    this.worker = new BmgFunction(this, 'Offboarding', {
      entry: 'services/api/src/handlers/offboarding.ts',
      description: `BMG ${env}: delete an artist (archive, knowledge base, chats, login)`,
      roleName: `${p}-api-offboarding`,
      prod,
      bundleAwsSdk: true,
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        PROJECT: cfg.project,
        BMG_ENV: env,
        ACCOUNT_ID: account,
        MAIN_TABLE: props.mainTable.tableName,
        EVENT_BUS: props.bus.eventBusName,
        USER_POOL_ID: props.userPool.userPoolId,
        ARTIST_BUCKET: names.bucket(cfg, env, 'artist-data'),
        LIBRARY_BUCKET: names.bucket(cfg, env, 'org-data'),
        VECTOR_BUCKET: `${p}-vectors`,
        DATA_ACCESS_ROLE_ARN: `arn:aws:iam::${account}:role/${p}-data-access`,
        SMTP_SECRET_ID: names.smtpSecret(cfg, env),
        APP_URL_PARAM: webUrlParam,
        APP_ORIGIN: `https://${names.webHost(cfg, env, 'artist')}`,
        ...(props.version ? { BMG_VERSION: props.version } : {}),
      },
    });
    const allow = (
      sid: string,
      actions: string[],
      resources: string[],
      conditions?: Record<string, unknown>,
    ) =>
      this.worker.addToRolePolicy(
        new PolicyStatement({ sid, actions, resources, ...(conditions ? { conditions } : {}) }),
      );

    allow(
      'Items',
      [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:BatchWriteItem',
      ],
      [main],
    );
    allow('PublishEvents', ['events:PutEvents'], [props.bus.eventBusArn]);
    allow(
      'ArtistSessions',
      ['sts:AssumeRole', 'sts:TagSession'],
      [`arn:aws:iam::${account}:role/${p}-data-access`],
    );
    allow(
      'Logins',
      ['cognito-idp:AdminDeleteUser', 'cognito-idp:ListUsersInGroup'],
      [props.userPool.userPoolArn],
    );
    allow(
      'DeleteKnowledgeBases',
      [
        'bedrock:GetKnowledgeBase',
        'bedrock:DeleteKnowledgeBase',
        'bedrock:DeleteDataSource',
        'bedrock:GetDataSource',
      ],
      [kbArn],
      { StringEquals: { 'aws:ResourceTag/bmg:env': env } },
    );
    allow('DeleteIndexes', ['s3vectors:DeleteIndex', 's3vectors:GetIndex'], [vectorIndexes]);
    allow('ReadSmtpSecret', ['secretsmanager:GetSecretValue'], [smtpSecretArn]);
    allow(
      'ReadAppUrl',
      ['ssm:GetParameter'],
      [`arn:aws:ssm:${home}:${account}:parameter${webUrlParam}`],
    );
    props.platformKey.grant(this.worker, 'kms:Decrypt');

    const dlq = new Queue(this, 'OffboardingDeadLetters', {
      queueName: `${p}-offboarding-dlq`,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: props.platformKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    acknowledge(dlq, 'This is the dead-letter queue itself.', 'AwsSolutions-SQS3');
    new Rule(this, 'DeleteRequests', {
      eventBus: props.bus,
      description: 'Delete an artist when an admin asks (rev 22)',
      eventPattern: { source: ['bmg.workspace'], detailType: ['artist.deleteRequested'] },
      // A failed step pauses the deletion (shown to admins with Retry), so the
      // function itself rarely throws; one retry covers a cold-start failure.
      targets: [
        new LambdaFunction(this.worker, {
          deadLetterQueue: dlq,
          retryAttempts: 1,
          maxEventAge: Duration.hours(1),
        }),
      ],
    });
    new Alarm(this, 'OffboardingFailures', {
      alarmName: `${p}-offboarding-failures`,
      alarmDescription: 'A deletion request never reached the worker (see the offboarding DLQ).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));

    acknowledge(
      this.worker.role!,
      'Knowledge bases and their vector indexes are created at run time per artist, so their ARNs are only known by pattern; knowledge-base actions also require the bmg:env tag. The SMTP secret ARN wildcard matches only the random suffix Secrets Manager adds.',
      ...['aws', '<AWS::Partition>'].map(
        (pt) =>
          `AwsSolutions-IAM5[Resource::arn:${pt}:bedrock:${home}:${account}:knowledge-base/*]`,
      ),
      `AwsSolutions-IAM5[Resource::${vectorIndexes}]`,
      `AwsSolutions-IAM5[Resource::${smtpSecretArn}]`,
    );
  }
}
