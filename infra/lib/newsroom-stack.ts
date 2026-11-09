import { Duration, type CfnResource } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';
import type { EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface NewsroomStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly mainTable: ITable;
}

/**
 * The weekly newsletter draft (design 10.5, F6): every Sunday at 6:00 am
 * Melbourne, `newsroom-draft` reads the managed industry sites, Blueprint's
 * events and library, and news from artists who opted in to AI, and writes a
 * draft for approval. It never sends anything.
 */
export class NewsroomStack extends BmgStack {
  readonly draftFunction: BmgFunction;

  constructor(scope: Construct, id: string, props: NewsroomStackProps) {
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
    const main = props.mainTable.tableArn;

    this.draftFunction = new BmgFunction(this, 'NewsroomDraft', {
      entry: 'services/api/src/handlers/newsroom-draft.ts',
      description: `BMG ${env}: draft the weekly newsletter for approval`,
      roleName: `${p}-newsroom-draft`,
      prod,
      bundleAwsSdk: true,
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        PROJECT: cfg.project,
        BMG_ENV: env,
        MAIN_TABLE: props.mainTable.tableName,
        SUMMARY_MODEL: cfg.ai.summaryModelProfile,
      },
    });
    const fn = this.draftFunction;
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: 'NewsroomItems',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
        ],
        resources: [main, `${main}/index/GSI1`],
      }),
    );
    props.platformKey.grant(fn, 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey');
    const profile = cfg.ai.summaryModelProfile;
    const base = profile.replace(/^au\./, '');
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: 'SummaryModel',
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${home}:${this.account}:inference-profile/${profile}`,
          ...['ap-southeast-2', 'ap-southeast-4'].map(
            (r) => `arn:aws:bedrock:${r}::foundation-model/${base}`,
          ),
        ],
      }),
    );

    // Sunday 6:00 am Melbourne, through EventBridge Scheduler (it handles daylight saving).
    const schedulerRole = new Role(this, 'NewsroomSchedulerRole', {
      roleName: `${p}-newsroom-scheduler`,
      description: `BMG ${env}: start the weekly newsletter draft`,
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
      }),
    });
    fn.grantInvoke(schedulerRole);
    new CfnSchedule(this, 'WeeklyDraft', {
      name: `${p}-newsroom-weekly`,
      description: 'Draft the weekly newsletter (Sunday 6:00 am Melbourne)',
      scheduleExpression: 'cron(0 6 ? * SUN *)',
      scheduleExpressionTimezone: 'Australia/Melbourne',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    acknowledge(
      fn.role!,
      'Platform-key grants emit KMS action families; the key is this environment’s platform key only.',
      'AwsSolutions-IAM5[Action::kms:GenerateDataKey*]',
      'AwsSolutions-IAM5[Action::kms:ReEncrypt*]',
    );
    acknowledge(
      schedulerRole,
      'grantInvoke covers the function and its versions.',
      `AwsSolutions-IAM5[Resource::<${this.getLogicalId(fn.node.defaultChild as CfnResource)}.Arn>:*]`,
    );
  }
}
