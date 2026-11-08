import { RemovalPolicy } from 'aws-cdk-lib';
import {
  AttributeType,
  BillingMode,
  StreamViewType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { names, type EnvironmentName, type TableKind } from '@bmg/config';
import { BmgStack, type BmgStackProps } from './common.ts';

export interface DataStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
}

/**
 * DynamoDB tables for one environment (design 8.1). All are on-demand,
 * encrypted with the environment's platform key and have point-in-time
 * recovery. Sensitive artist fields are additionally encrypted per artist in
 * the app (Phase 2b), so the platform key alone never reveals them.
 */
export class DataStack extends BmgStack {
  readonly tables: Record<TableKind, Table>;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';

    const common = {
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.platformKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    };
    const pk = { name: 'PK', type: AttributeType.STRING };
    const sk = { name: 'SK', type: AttributeType.STRING };

    const main = new Table(this, 'Main', {
      ...common,
      tableName: names.table(cfg, env, 'main'),
      partitionKey: pk,
      sortKey: sk,
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
    });
    // GSI1: by owner/status · GSI2: by due date · GSI3: by artist activity (design 8.1).
    for (const n of [1, 2, 3]) {
      main.addGlobalSecondaryIndex({
        indexName: `GSI${n}`,
        partitionKey: { name: `GSI${n}PK`, type: AttributeType.STRING },
        sortKey: { name: `GSI${n}SK`, type: AttributeType.STRING },
      });
    }

    // Append-only: no app role is ever granted UpdateItem or DeleteItem on this table.
    const consent = new Table(this, 'Consent', {
      ...common,
      tableName: names.table(cfg, env, 'consent'),
      partitionKey: pk,
      sortKey: sk,
      stream: StreamViewType.NEW_IMAGE,
    });

    const sessions = new Table(this, 'Sessions', {
      ...common,
      tableName: names.table(cfg, env, 'sessions'),
      partitionKey: pk,
      timeToLiveAttribute: 'expiresAt',
    });

    // Key and TTL attribute names follow Powertools for AWS Lambda idempotency defaults.
    const idempotency = new Table(this, 'Idempotency', {
      ...common,
      tableName: names.table(cfg, env, 'idempotency'),
      partitionKey: { name: 'id', type: AttributeType.STRING },
      timeToLiveAttribute: 'expiration',
    });

    this.tables = { main, consent, sessions, idempotency };
    for (const [kind, table] of Object.entries(this.tables)) {
      new StringParameter(this, `${kind}TableName`, {
        parameterName: names.ssm(cfg, env, `data/${kind}-table`),
        stringValue: table.tableName,
      });
    }
  }
}
