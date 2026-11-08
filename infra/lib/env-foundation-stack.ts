import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { BmgStack, type BmgStackProps } from './common.ts';

export interface EnvFoundationStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  /** Git commit being deployed, recorded for `bmg status`. */
  readonly version?: string;
}

/**
 * Per-environment foundation (staging, prod). Phase 1 keeps it small so the
 * pipeline can prove end to end that it deploys each environment with its own
 * bootstrap roles. Later phases add identity, data, API, files and AI stacks
 * that build on the platform key and alarm topic created here.
 */
export class EnvFoundationStack extends BmgStack {
  readonly platformKey: Key;
  readonly alarmTopic: Topic;

  constructor(scope: Construct, id: string, props: EnvFoundationStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;

    this.platformKey = new Key(this, 'PlatformKey', {
      alias: `alias/${cfg.project}/${env}/platform`,
      description: `BMG ${env}: platform data key (org data, tables, secrets of BMG itself)`,
      enableKeyRotation: true,
      removalPolicy: env === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.platformKey.grant(
      new ServicePrincipal('cloudwatch.amazonaws.com'),
      'kms:GenerateDataKey*',
      'kms:Decrypt',
    );

    this.alarmTopic = new Topic(this, 'Alarms', {
      topicName: `${cfg.project}-${env}-alarms`,
      masterKey: this.platformKey,
      enforceSSL: true,
    });
    for (const email of cfg.alerts.emails)
      this.alarmTopic.addSubscription(new EmailSubscription(email));

    new StringParameter(this, 'Version', {
      parameterName: names.ssm(cfg, env, 'foundation/version'),
      stringValue: props.version ?? 'unknown',
      description: 'Git commit of the last foundation deploy',
    });
    new CfnOutput(this, 'DeployedVersion', { value: props.version ?? 'unknown' });
    new StringParameter(this, 'PlatformKeyArn', {
      parameterName: names.ssm(cfg, env, 'foundation/platform-key-arn'),
      stringValue: this.platformKey.keyArn,
    });
    new StringParameter(this, 'AlarmTopicArn', {
      parameterName: names.ssm(cfg, env, 'foundation/alarm-topic-arn'),
      stringValue: this.alarmTopic.topicArn,
    });
  }
}
