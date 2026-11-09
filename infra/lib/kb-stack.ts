import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule, type IEventBus } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { AccountPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import { CfnVectorBucket } from 'aws-cdk-lib/aws-s3vectors';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface KbStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly mainTable: ITable;
  readonly bus: IEventBus;
  readonly alarmTopic: ITopic;
}

/**
 * Knowledge bases (design 10.3, 10.4), in their own stack:
 * - One S3 Vectors bucket per environment, under its own key. Each knowledge
 *   base (one per opted-in artist, one for BMG) gets its own index there.
 * - `kb-provision` creates an artist's knowledge base when they opt in and
 *   fills it; deletes it when they opt out; and reconciles hourly, so an
 *   opted-out artist is gone within the hour even if an event was lost.
 * - `kb-sync` adds, refreshes or removes one file when it changes.
 * - `ai-retrieve` is the only role that can query a knowledge base, in a
 *   session tagged with the one owner it may query (IAM enforces the match).
 */
export class KbStack extends BmgStack {
  constructor(scope: Construct, id: string, props: KbStackProps) {
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
    const roleArn = (name: string) => `arn:aws:iam::${account}:role/${name}`;
    const kbArn = `arn:aws:bedrock:${home}:${account}:knowledge-base/*`;

    // ── Vector store ──
    const vectorKey = new Key(this, 'VectorKey', {
      alias: `alias/${cfg.project}/${env}/vectors`,
      description: `BMG ${env}: knowledge-base vector indexes`,
      enableKeyRotation: true,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    vectorKey.addToResourcePolicy(
      new PolicyStatement({
        sid: 'S3VectorsIndexing',
        principals: [new ServicePrincipal('indexing.s3vectors.amazonaws.com')],
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': account } },
      }),
    );
    const vectorBucketName = `${p}-vectors`;
    const bucket = new CfnVectorBucket(this, 'Vectors', {
      vectorBucketName,
      encryptionConfiguration: { sseType: 'aws:kms', kmsKeyArn: vectorKey.keyArn },
    });
    const vectorArns = [bucket.attrVectorBucketArn, `${bucket.attrVectorBucketArn}/index/*`];

    // ── The role Bedrock uses for every knowledge base: embed, and read/write vectors ──
    const service = new Role(this, 'KbService', {
      roleName: `${p}-kb-service`,
      description: `BMG ${env}: Bedrock knowledge bases (embeddings and vector index)`,
      assumedBy: new ServicePrincipal('bedrock.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: { 'aws:SourceArn': kbArn },
      }),
    });
    service.addToPolicy(
      new PolicyStatement({
        sid: 'Embed',
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${home}::foundation-model/amazon.titan-embed-text-v2:0`],
      }),
    );
    service.addToPolicy(
      new PolicyStatement({
        sid: 'Vectors',
        actions: [
          's3vectors:GetIndex',
          's3vectors:PutVectors',
          's3vectors:GetVectors',
          's3vectors:DeleteVectors',
          's3vectors:QueryVectors',
          's3vectors:ListVectors',
        ],
        resources: vectorArns,
      }),
    );
    vectorKey.grant(service, 'kms:Decrypt', 'kms:GenerateDataKey');

    // ── Functions (role names match the data-access trust: `<p>-api-*`) ──
    const common = {
      PROJECT: cfg.project,
      BMG_ENV: env,
      ACCOUNT_ID: account,
      MAIN_TABLE: props.mainTable.tableName,
      VECTOR_BUCKET: vectorBucketName,
      KB_SERVICE_ROLE_ARN: service.roleArn,
      DATA_ACCESS_ROLE_ARN: roleArn(`${p}-data-access`),
      ARTIST_BUCKET: names.bucket(cfg, env, 'artist-data'),
      LIBRARY_BUCKET: names.bucket(cfg, env, 'org-data'),
    };
    const provision = new BmgFunction(this, 'KbProvision', {
      entry: 'services/api/src/handlers/kb-provision.ts',
      description: `BMG ${env}: create, fill, delete and reconcile knowledge bases`,
      roleName: `${p}-api-kb-provision`,
      prod,
      bundleAwsSdk: true,
      timeout: Duration.minutes(10),
      memorySize: 1024,
      environment: common,
    });
    const sync = new BmgFunction(this, 'KbSync', {
      entry: 'services/api/src/handlers/kb-sync.ts',
      description: `BMG ${env}: keep a knowledge base in step with its files`,
      roleName: `${p}-api-kb-sync`,
      prod,
      bundleAwsSdk: true,
      timeout: Duration.minutes(2),
      memorySize: 1024,
      environment: common,
    });

    const main = props.mainTable.tableArn;
    for (const f of [provision, sync]) {
      f.addToRolePolicy(
        new PolicyStatement({
          sid: 'Items',
          actions: [
            'dynamodb:GetItem',
            'dynamodb:BatchGetItem',
            'dynamodb:Query',
            'dynamodb:UpdateItem',
          ],
          resources: [main, `${main}/index/GSI1`],
        }),
      );
      f.addToRolePolicy(
        new PolicyStatement({
          sid: 'Documents',
          actions: ['bedrock:IngestKnowledgeBaseDocuments', 'bedrock:DeleteKnowledgeBaseDocuments'],
          resources: [kbArn],
          conditions: { StringEquals: { 'aws:ResourceTag/bmg:env': env } },
        }),
      );
      f.addToRolePolicy(
        new PolicyStatement({
          sid: 'ArtistSessions',
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [roleArn(`${p}-data-access`)],
        }),
      );
      f.addToRolePolicy(
        new PolicyStatement({
          sid: 'LibraryFiles',
          actions: ['s3:GetObject'],
          resources: [`arn:aws:s3:::${names.bucket(cfg, env, 'org-data')}/library/*`],
        }),
      );
      props.platformKey.grant(f, 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey');
    }
    provision.addToRolePolicy(
      new PolicyStatement({
        sid: 'Records',
        actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
        resources: [main],
      }),
    );
    provision.addToRolePolicy(
      new PolicyStatement({
        sid: 'CreateKnowledgeBases',
        actions: ['bedrock:CreateKnowledgeBase', 'bedrock:TagResource'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestTag/bmg:env': env } },
      }),
    );
    provision.addToRolePolicy(
      new PolicyStatement({
        sid: 'ManageKnowledgeBases',
        actions: [
          'bedrock:GetKnowledgeBase',
          'bedrock:DeleteKnowledgeBase',
          'bedrock:CreateDataSource',
          'bedrock:DeleteDataSource',
          'bedrock:GetDataSource',
        ],
        resources: [kbArn],
        conditions: { StringEquals: { 'aws:ResourceTag/bmg:env': env } },
      }),
    );
    provision.addToRolePolicy(
      new PolicyStatement({
        sid: 'PassServiceRole',
        actions: ['iam:PassRole'],
        resources: [service.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'bedrock.amazonaws.com' } },
      }),
    );
    provision.addToRolePolicy(
      new PolicyStatement({
        sid: 'Indexes',
        actions: [
          's3vectors:CreateIndex',
          's3vectors:DeleteIndex',
          's3vectors:GetIndex',
          's3vectors:TagResource',
        ],
        resources: vectorArns,
      }),
    );
    provision.addToRolePolicy(
      new PolicyStatement({
        sid: 'Metrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'BMG/AI' } },
      }),
    );
    vectorKey.grant(provision, 'kms:Decrypt', 'kms:GenerateDataKey');

    new Rule(this, 'ConsentToKnowledgeBases', {
      eventBus: props.bus,
      description: 'Create or delete an artist knowledge base when their AI choice changes',
      eventPattern: { source: ['bmg.identity'], detailType: ['consent.aiChanged'] },
      targets: [
        new LambdaFunction(provision, { retryAttempts: 8, maxEventAge: Duration.hours(1) }),
      ],
    });
    new Rule(this, 'Reconcile', {
      description: 'Hourly: make knowledge bases match AI consent (design 10.4)',
      schedule: Schedule.rate(Duration.hours(1)),
      targets: [new LambdaFunction(provision, { retryAttempts: 2 })],
    });
    new Rule(this, 'FilesToKnowledgeBases', {
      eventBus: props.bus,
      description: 'Keep knowledge bases in step with files',
      eventPattern: {
        source: ['bmg.audit'],
        detailType: ['file.available', 'file.share', 'file.unshare', 'file.delete'],
      },
      targets: [new LambdaFunction(sync, { retryAttempts: 4, maxEventAge: Duration.hours(2) })],
    });

    // ── Retrieval: one owner per session, enforced by IAM tags ──
    const retrieve = new Role(this, 'AiRetrieve', {
      roleName: `${p}-ai-retrieve`,
      description: `BMG ${env}: query one knowledge base, the one tagged like the session`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new AccountPrincipal(account).withSessionTags().withConditions({
        ArnLike: { 'aws:PrincipalArn': roleArn(`${p}-api-ai-tools`) },
        StringLike: { 'aws:RequestTag/artistId': ['art_*', 'bmg'] },
        'ForAllValues:StringEquals': { 'aws:TagKeys': ['artistId'] },
      }),
    });
    retrieve.addToPolicy(
      new PolicyStatement({
        sid: 'RetrieveFromTheTaggedOwnersKnowledgeBase',
        actions: ['bedrock:Retrieve'],
        resources: [kbArn],
        conditions: {
          StringEquals: {
            'aws:ResourceTag/artistId': '${aws:PrincipalTag/artistId}',
            'aws:ResourceTag/bmg:env': env,
          },
        },
      }),
    );

    // ── Alarms ──
    const metric = (name: string) =>
      new Metric({
        namespace: 'BMG/AI',
        metricName: name,
        dimensionsMap: { Environment: env },
        period: Duration.hours(1),
        statistic: 'Maximum',
      });
    new Alarm(this, 'ConsentDriftAlarm', {
      alarmName: `${p}-ai-consent-drift`,
      alarmDescription:
        'Knowledge bases did not match AI consent and were fixed by reconciliation: an event was lost or failed (design 10.4). Check kb-provision logs.',
      metric: metric('ConsentDrift'),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));
    new Alarm(this, 'KnowledgeBaseCountAlarm', {
      alarmName: `${p}-ai-kb-count`,
      alarmDescription:
        'Knowledge bases are near the fixed limit of 100 per Region, shared by staging and prod. Plan the S3 Vectors fallback (decisions.md).',
      metric: metric('KnowledgeBases'),
      threshold: 40,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(props.alarmTopic));

    for (const f of [provision, sync]) {
      acknowledge(
        f.role!,
        "Knowledge bases are created at run time, so their ARNs are only known by pattern; every action on them also requires the bmg:env tag. Index ARNs are per owner under this environment's vector bucket. PutMetricData has no resource scoping and is limited to the BMG/AI namespace.",
        'AwsSolutions-IAM5[Resource::*]',
        ...['aws', '<AWS::Partition>'].flatMap((pt) => [
          `AwsSolutions-IAM5[Resource::arn:${pt}:bedrock:${home}:${account}:knowledge-base/*]`,
          `AwsSolutions-IAM5[Resource::arn:${pt}:s3:::${names.bucket(cfg, env, 'org-data')}/library/*]`,
        ]),
        'AwsSolutions-IAM5[Resource::<Vectors.VectorBucketArn>/index/*]',
        'AwsSolutions-IAM5[Action::kms:GenerateDataKey*]',
        'AwsSolutions-IAM5[Action::kms:ReEncrypt*]',
      );
    }
    acknowledge(
      service,
      "Bedrock writes each knowledge base's vectors to its own index in this environment's vector bucket.",
      'AwsSolutions-IAM5[Resource::<Vectors.VectorBucketArn>/index/*]',
      'AwsSolutions-IAM5[Action::kms:GenerateDataKey*]',
      'AwsSolutions-IAM5[Action::kms:ReEncrypt*]',
    );
    acknowledge(
      retrieve,
      'Retrieval is allowed only on the knowledge base whose artistId tag equals the session tag (and in this environment).',
      ...['aws', '<AWS::Partition>'].map(
        (pt) =>
          `AwsSolutions-IAM5[Resource::arn:${pt}:bedrock:${home}:${account}:knowledge-base/*]`,
      ),
    );
  }
}
