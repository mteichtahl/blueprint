import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SnsTopic } from 'aws-cdk-lib/aws-events-targets';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { BmgStack, type BmgStackProps } from './common.ts';

/**
 * us-east-1 account items: root sign-in alarm (console sign-in events for the
 * root user are delivered in us-east-1) and the AWS budget with 50/80/100% alerts
 * (design section 21).
 */
export class AccountGlobalStack extends BmgStack {
  constructor(scope: Construct, id: string, props: Omit<BmgStackProps, 'envTag' | 'qualifier'>) {
    super(scope, id, {
      ...props,
      qualifier: props.config.toolingQualifier,
      envTag: 'account',
      applyBoundary: false,
    });
    const cfg = props.config;

    const key = new Key(this, 'AlertsKey', {
      alias: `alias/${cfg.project}/global-alerts`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    key.grant(new ServicePrincipal('events.amazonaws.com'), 'kms:GenerateDataKey*', 'kms:Decrypt');

    const topic = new Topic(this, 'GlobalAlerts', {
      topicName: `${cfg.project}-global-alerts`,
      masterKey: key,
      enforceSSL: true,
    });
    for (const email of cfg.alerts.emails) topic.addSubscription(new EmailSubscription(email));

    new Rule(this, 'RootSignIn', {
      description: 'Alert on any root user console sign-in',
      eventPattern: {
        detailType: ['AWS Console Sign In via CloudTrail'],
        detail: { userIdentity: { type: ['Root'] } },
      },
      targets: [new SnsTopic(topic)],
    });

    new Rule(this, 'ConsoleSignInWithoutMfa', {
      description: 'Alert on IAM user console sign-in without MFA',
      eventPattern: {
        detailType: ['AWS Console Sign In via CloudTrail'],
        detail: {
          userIdentity: { type: ['IAMUser'] },
          additionalEventData: { MFAUsed: ['No'] },
        },
      },
      targets: [new SnsTopic(topic)],
    });

    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${cfg.project}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: cfg.budget.monthlyUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
        notification: {
          comparisonOperator: 'GREATER_THAN',
          notificationType: 'ACTUAL',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: cfg.alerts.emails.map((address) => ({ subscriptionType: 'EMAIL', address })),
      })),
    });
  }
}
