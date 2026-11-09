import { CfnOutput, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import {
  AccessLogFormat,
  EndpointType,
  IdentitySource,
  LambdaIntegration,
  LogGroupLogDestination,
  MethodLoggingLevel,
  RequestAuthorizer,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import type { IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { IEventBus } from 'aws-cdk-lib/aws-events';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IStateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { names, TAG_ENV, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface ApiStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly userPool: IUserPool;
  readonly mainTable: ITable;
  readonly consentTable: ITable;
  readonly sessionsTable: ITable;
  readonly bus: IEventBus;
  readonly onboarding: IStateMachine;
  /** The files stack's quarantine key; the buckets have fixed names (names.bucket). */
  readonly quarantineKey: IKey;
}

/**
 * The REST API for one environment (design 7.2). Phase 2 routes:
 *   GET  /me                    who you are, step-up state, latest consent
 *   GET  /consent, POST /consent  append-only consent ledger (F1 step 4)
 *   POST /step-up/totp/setup|verify   app-level MFA for social sign-ins (6.2)
 *   POST /artists               admin invite → onboarding (F1), fresh step-up
 * A Lambda authorizer verifies the Cognito access token and the step-up
 * state. Regional AWS WAF sits in front; CloudFront arrives with the web app.
 */
export class ApiStack extends BmgStack {
  readonly api: RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;

    const common = {
      MAIN_TABLE: props.mainTable.tableName,
      CONSENT_TABLE: props.consentTable.tableName,
      SESSIONS_TABLE: props.sessionsTable.tableName,
      EVENT_BUS: props.bus.eventBusName,
    };
    // Role names match `<p>-api-*`, the pattern the data-access role trusts (keys stack).
    const fn = (
      name: string,
      entry: string,
      description: string,
      extra: Record<string, string> = {},
      bundleAwsSdk = false,
    ) =>
      new BmgFunction(this, name, {
        entry: `services/api/src/handlers/${entry}.ts`,
        description: `BMG ${env} API: ${description}`,
        roleName: `${p}-api-${entry}`,
        prod,
        bundleAwsSdk,
        environment: { ...common, ...extra },
      });

    const authorizerFn = fn('Authorizer', 'authorizer', 'verify tokens and step-up', {
      USER_POOL_ID: props.userPool.userPoolId,
      WEB_CLIENT_ID_PARAM: names.ssm(cfg, env, 'web/client-id'),
    });
    const me = fn('Me', 'me', 'GET /me');
    const consent = fn('Consent', 'consent', 'consent ledger');
    const stepUp = fn('StepUp', 'step-up', 'TOTP step-up for social sign-in', {
      PLATFORM_KEY_ARN: props.platformKey.keyArn,
    });
    const workspace = fn('Workspace', 'workspace', 'artists, plans and to-dos');
    const dataAccessRoleArn = `arn:aws:iam::${this.account}:role/${p}-data-access`;
    const bucket = (kind: 'quarantine' | 'artist-data' | 'org-data') =>
      names.bucket(cfg, env, kind);
    const objects = (kind: 'quarantine' | 'org-data', prefix: string) =>
      `arn:aws:s3:::${bucket(kind)}/${prefix}`;
    const files = fn(
      'Files',
      'files',
      'file uploads, sharing and downloads',
      {
        QUARANTINE_BUCKET: bucket('quarantine'),
        ARTIST_BUCKET: bucket('artist-data'),
        LIBRARY_BUCKET: bucket('org-data'),
        DATA_ACCESS_ROLE_ARN: dataAccessRoleArn,
      },
      // The S3 presigners aren't guaranteed to be in the Lambda runtime.
      true,
    );
    const artists = fn('Artists', 'artists', 'invite artists', {
      USER_POOL_ID: props.userPool.userPoolId,
      ONBOARDING_STATE_MACHINE_ARN: props.onboarding.stateMachineArn,
    });

    const allow = (f: BmgFunction, sid: string, actions: string[], resources: string[]) =>
      f.addToRolePolicy(new PolicyStatement({ sid, actions, resources }));
    const main = props.mainTable.tableArn;
    const consentTable = props.consentTable.tableArn;
    const sessions = props.sessionsTable.tableArn;
    const putEvents = (f: BmgFunction) =>
      allow(f, 'PublishEvents', ['events:PutEvents'], [props.bus.eventBusArn]);

    allow(authorizerFn, 'ReadStepUpSessions', ['dynamodb:GetItem'], [sessions]);
    allow(
      authorizerFn,
      'ReadWebClientId',
      ['ssm:GetParameter'],
      [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${names.ssm(cfg, env, 'web/client-id')}`,
      ],
    );
    allow(me, 'ReadOwnConsent', ['dynamodb:Query'], [consentTable]);
    // The consent ledger is append-only: Put and Query, never Update or Delete.
    allow(consent, 'AppendConsent', ['dynamodb:PutItem', 'dynamodb:Query'], [consentTable]);
    allow(consent, 'ReadAssignments', ['dynamodb:GetItem'], [main]);
    putEvents(consent);
    allow(
      stepUp,
      'TotpRecords',
      ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      [main],
    );
    allow(
      stepUp,
      'StepUpSessions',
      ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      [sessions],
    );
    putEvents(stepUp);
    allow(artists, 'Invites', ['dynamodb:GetItem', 'dynamodb:PutItem'], [main]);
    allow(
      workspace,
      'WorkspaceItems',
      [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
      ],
      [main],
    );
    // Roster (GSI1) and all-artist to-dos (GSI2) only; GSI3 isn't used yet.
    allow(
      workspace,
      'WorkspaceIndexes',
      ['dynamodb:Query'],
      [`${main}/index/GSI1`, `${main}/index/GSI2`],
    );
    allow(
      files,
      'FileRecords',
      ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
      [main],
    );
    // Signs presigned POSTs: S3 checks the signer may put the object and use the quarantine key.
    const uploadPrefixes = [objects('quarantine', 'artists/*'), objects('quarantine', 'library/*')];
    allow(files, 'SignUploads', ['s3:PutObject'], uploadPrefixes);
    props.quarantineKey.grant(files, 'kms:GenerateDataKey');
    // Library downloads are signed with this role (platform key); artist
    // downloads with a data-access session for the artist.
    const libraryObjects = objects('org-data', 'library/*');
    allow(files, 'SignLibraryDownloads', ['s3:GetObject'], [libraryObjects]);
    allow(files, 'ArtistSessions', ['sts:AssumeRole', 'sts:TagSession'], [dataAccessRoleArn]);
    putEvents(files);
    acknowledge(
      files.role!,
      'Uploads are signed for the artists/ and library/ prefixes of the quarantine bucket; library downloads for library/ in org-data.',
      ...[...uploadPrefixes, libraryObjects].map((r) => `AwsSolutions-IAM5[Resource::${r}]`),
    );
    allow(
      artists,
      'StartOnboarding',
      ['states:StartExecution'],
      [props.onboarding.stateMachineArn],
    );
    allow(
      artists,
      'CreateArtistUsers',
      ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup'],
      [props.userPool.userPoolArn],
    );
    putEvents(artists);
    for (const f of [authorizerFn, me, consent, artists, workspace, files]) {
      props.platformKey.grant(f, 'kms:Decrypt');
    }
    for (const f of [consent, stepUp, artists, workspace, files]) {
      props.platformKey.grant(f, 'kms:Encrypt', 'kms:GenerateDataKey');
    }
    props.platformKey.grant(stepUp, 'kms:Decrypt');

    // ── REST API ──
    const accessLogs = new LogGroup(this, 'AccessLogs', {
      retention: prod ? RetentionDays.ONE_YEAR : RetentionDays.ONE_MONTH,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const appOrigin = `https://${names.host(cfg, env, 'app')}`;
    this.api = new RestApi(this, 'Api', {
      restApiName: `${p}-api`,
      description: `BMG ${env} API`,
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      // API Gateway's CloudWatch role is one per account. Staging creates and
      // keeps it; prod (always deployed after staging) reuses it.
      cloudWatchRole: !prod,
      ...(prod ? {} : { cloudWatchRoleRemovalPolicy: RemovalPolicy.RETAIN }),
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        metricsEnabled: true,
        // ERROR only: execution logs at INFO would include request details.
        loggingLevel: MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        accessLogDestination: new LogGroupLogDestination(accessLogs),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: false,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: prod ? [appOrigin] : [appOrigin, 'http://localhost:5173'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH'],
        allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
        maxAge: Duration.hours(1),
      },
    });
    if (!prod) {
      // The shared account-level role must write to both environments' log
      // groups, so it carries no bmg:env tag (the boundary's cross-env rule
      // only applies when both sides are tagged).
      const cwRole = this.api.node.tryFindChild('CloudWatchRole');
      if (cwRole) Tags.of(cwRole).remove(TAG_ENV);
      if (cwRole) {
        acknowledge(
          cwRole,
          'AWS-managed policy required by API Gateway account-level logging.',
          'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs]',
        );
      }
    }

    const authorizer = new RequestAuthorizer(this, 'TokenAuthorizer', {
      handler: authorizerFn,
      identitySources: [IdentitySource.header('Authorization')],
      // Step-up changes a session's rights, so decisions aren't cached.
      resultsCacheTtl: Duration.seconds(0),
    });
    const validator = this.api.addRequestValidator('Validate', {
      requestValidatorName: `${p}-validate`,
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    const route = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH',
      path: string,
      handler: BmgFunction,
    ) => {
      const resource = path
        .split('/')
        .filter(Boolean)
        .reduce((r, part) => r.getResource(part) ?? r.addResource(part), this.api.root);
      resource.addMethod(method, new LambdaIntegration(handler), {
        authorizer,
        requestValidator: validator,
      });
    };
    route('GET', '/me', me);
    route('GET', '/consent', consent);
    route('POST', '/consent', consent);
    route('POST', '/step-up/totp/setup', stepUp);
    route('POST', '/step-up/totp/verify', stepUp);
    route('POST', '/artists', artists);
    route('GET', '/artists', workspace);
    route('GET', '/artists/{artistId}', workspace);
    route('GET', '/artists/{artistId}/plan', workspace);
    route('PUT', '/artists/{artistId}/plan', workspace);
    route('GET', '/artists/{artistId}/todos', workspace);
    route('POST', '/artists/{artistId}/todos', workspace);
    route('PATCH', '/artists/{artistId}/todos/{todoId}', workspace);
    route('GET', '/todos', workspace);
    route('GET', '/artists/{artistId}/files', files);
    route('POST', '/artists/{artistId}/files', files);
    route('GET', '/artists/{artistId}/files/{fileId}', files);
    route('PATCH', '/artists/{artistId}/files/{fileId}', files);
    route('POST', '/artists/{artistId}/files/{fileId}/download', files);
    route('GET', '/library/files', files);
    route('POST', '/library/files', files);
    route('GET', '/library/files/{fileId}', files);
    route('PATCH', '/library/files/{fileId}', files);
    route('POST', '/library/files/{fileId}/download', files);

    acknowledge(
      this.api,
      'Access tokens are verified by the Lambda authorizer (aws-jwt-verify) so it can also apply the step-up rule for social sign-ins (design 6.2, 7.2).',
      'AwsSolutions-COG4',
    );

    // ── Regional AWS WAF ──
    const managed = (name: string, priority: number) => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: name,
      },
    });
    const waf = new CfnWebACL(this, 'Waf', {
      name: `${p}-api`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: `${p}-api`,
      },
      rules: [
        {
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: 1000, aggregateKeyType: 'IP' } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'RateLimitPerIp',
          },
        },
        managed('AWSManagedRulesCommonRuleSet', 1),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
      ],
    });
    new CfnWebACLAssociation(this, 'WafAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: waf.attrArn,
    });

    new StringParameter(this, 'ApiUrl', {
      parameterName: names.ssm(cfg, env, 'api/url'),
      stringValue: this.api.url,
    });
    new CfnOutput(this, 'ApiEndpoint', { value: this.api.url });
  }
}
