import { CfnOutput, CustomResource, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  AccessLogFormat,
  EndpointType,
  IdentitySource,
  Integration,
  IntegrationType,
  LogGroupLogDestination,
  MethodLoggingLevel,
  RequestAuthorizer,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import {
  AppSyncAuthorizationType,
  AppSyncFieldLogLevel,
  type CfnApi,
  Code,
  EventApi,
} from 'aws-cdk-lib/aws-appsync';
import type { IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule, type IEventBus } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IStateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { names, TAG_ENV, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, KMS_GRANT_FINDINGS, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface ApiStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly userPool: IUserPool;
  readonly mainTable: ITable;
  readonly consentTable: ITable;
  readonly sessionsTable: ITable;
  readonly bus: IEventBus;
  readonly alarmTopic: ITopic;
  readonly onboarding: IStateMachine;
  /** The files stack's quarantine key; the buckets have fixed names (names.bucket). */
  readonly quarantineKey: IKey;
  /** The assistant (AI stack): its runtime and the key that signs "Do it" tokens. */
  readonly agentRuntimeArn: string;
  readonly actionKey: IKey;
  /** The newsroom stack's draft function ("Regenerate"). */
  readonly newsroomDraftArn: string;
}

/**
 * The REST API for one environment (design 7.2). Phase 2 routes:
 *   GET  /me                    who you are, step-up state, latest consent
 *   PATCH /me                   your job title (Blueprint people; artists are "Artist")
 *   GET  /consent, POST /consent  append-only consent ledger (F1 step 4)
 *   POST /step-up/totp/setup|verify   app-level MFA for social sign-ins (6.2)
 *   POST /artists               admin invite → onboarding (F1), fresh step-up
 * A Lambda authorizer verifies the Cognito access token and the step-up
 * state. Regional AWS WAF sits in front; CloudFront arrives with the web app.
 */
/**
 * Realtime subscribe rule (AppSync Events, APPSYNC_JS): a user may only listen
 * on their own inbox channel. Payloads carry ids only; content always comes
 * through the API and its access rules.
 */
const INBOX_HANDLER = `
import { util } from '@aws-appsync/utils';
export function onSubscribe(ctx) {
  const claims = (ctx.identity && ctx.identity.claims) || {};
  const target = ctx.info.channel.segments[1] || '';
  const bmg = claims.role === 'bmg-admin' || claims.role === 'bmg-staff';
  if (target === 'bmg' && bmg) return;
  if (ctx.identity && ctx.identity.sub && target === 'user-' + ctx.identity.sub) return;
  if (claims.role === 'artist' && (target === 'all-artists' || target === 'artist-' + claims.artistId)) return;
  util.unauthorized();
}
export function onPublish(ctx) {
  return ctx.events;
}
`;

/** Largest request body the WAF lets through, except on IMAGE_ROUTES. */
export const BODY_LIMIT_BYTES = 64 * 1024;
/**
 * Routes that carry an image as a data URL in JSON (method, URI path regex).
 * Their handlers cap the image size, so the WAF body limit doesn't apply.
 */
export const IMAGE_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['PUT', '/venues/[^/]+/logo$'], // venue logo
  ['PATCH', '^(/[^/]+)?/me$'], // profile picture (/me, or /<stage>/me)
];

export class ApiStack extends BmgStack {
  readonly api: RestApi;
  readonly realtime: EventApi;

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
      timeout?: Duration,
    ) =>
      new BmgFunction(this, name, {
        entry: `services/api/src/handlers/${entry}.ts`,
        description: `BMG ${env} API: ${description}`,
        roleName: `${p}-api-${entry}`,
        prod,
        bundleAwsSdk,
        ...(timeout ? { timeout } : {}),
        environment: { ...common, ...extra },
      });

    const authorizerFn = fn('Authorizer', 'authorizer', 'verify tokens and step-up', {
      USER_POOL_ID: props.userPool.userPoolId,
      WEB_CLIENT_ID_PARAM: names.ssm(cfg, env, 'web/client-id'),
    });
    const me = fn('Me', 'me', 'GET and PATCH /me');
    const consent = fn('Consent', 'consent', 'consent ledger');
    const stepUp = fn('StepUp', 'step-up', 'TOTP step-up for social sign-in', {
      PLATFORM_KEY_ARN: props.platformKey.keyArn,
    });
    // ── To-do reminders: one EventBridge Scheduler one-off per to-do ──
    // It puts `todo.reminder` straight on the env bus; the notifier sends it.
    const reminderGroup = new CfnScheduleGroup(this, 'ReminderGroup', {
      name: `${p}-reminders`,
    });
    const reminderRole = new Role(this, 'ReminderRole', {
      roleName: `${p}-reminder-scheduler`,
      description: `BMG ${env}: EventBridge Scheduler puts to-do reminders on the event bus`,
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          // Scheduler sets SourceArn to the schedule *group*, not the schedule
          // (AWS confused-deputy guidance). Matching the schedule ARN meant the
          // role could never be assumed, so CreateSchedule failed (WP0).
          ArnEquals: {
            'aws:SourceArn': `arn:aws:scheduler:${this.region}:${this.account}:schedule-group/${p}-reminders`,
          },
        },
      }),
    });
    reminderRole.addToPolicy(
      new PolicyStatement({
        sid: 'PutReminderEvents',
        actions: ['events:PutEvents'],
        resources: [props.bus.eventBusArn],
      }),
    );
    const workspace = fn('Workspace', 'workspace', 'artists, plans and to-dos', {
      EVENT_BUS_ARN: props.bus.eventBusArn,
      REMINDER_GROUP: reminderGroup.name!,
      REMINDER_ROLE_ARN: reminderRole.roleArn,
    });
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
    // ── Realtime (AppSync Events): inbox nudges for messages ──
    this.realtime = new EventApi(this, 'Realtime', {
      apiName: `${p}-realtime`,
      authorizationConfig: {
        authProviders: [
          {
            authorizationType: AppSyncAuthorizationType.USER_POOL,
            cognitoConfig: { userPool: props.userPool },
          },
          { authorizationType: AppSyncAuthorizationType.IAM },
        ],
        connectionAuthModeTypes: [AppSyncAuthorizationType.USER_POOL, AppSyncAuthorizationType.IAM],
        defaultPublishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [AppSyncAuthorizationType.USER_POOL],
      },
    });
    // Error logs, set here rather than through `logConfig`, so the log group
    // is owned by this stack with a fixed retention (no log-retention Lambda)
    // and the logging role can only write to it.
    const realtimeLogs = new LogGroup(this, 'RealtimeLogs', {
      logGroupName: `/aws/appsync/apis/${this.realtime.apiId}`,
      retention: prod ? RetentionDays.ONE_YEAR : RetentionDays.ONE_MONTH,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const realtimeLogsRole = new Role(this, 'RealtimeLogsRole', {
      assumedBy: new ServicePrincipal('appsync.amazonaws.com'),
      description: `BMG ${env}: AppSync Events error logs`,
    });
    realtimeLogsRole.addToPolicy(
      new PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${realtimeLogs.logGroupArn}:*`],
      }),
    );
    acknowledge(
      realtimeLogsRole,
      "Log streams are created by AppSync inside this API's own log group.",
      `AwsSolutions-IAM5[Resource::<${this.getLogicalId(realtimeLogs.node.defaultChild as never)}.Arn>:*]`,
    );
    (this.realtime.node.defaultChild as CfnApi).addPropertyOverride('EventConfig.LogConfig', {
      CloudWatchLogsRoleArn: realtimeLogsRole.roleArn,
      LogLevel: AppSyncFieldLogLevel.ERROR,
    });
    this.realtime.addChannelNamespace('inbox', {
      code: Code.fromInline(INBOX_HANDLER),
      authorizationConfig: {
        publishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        subscribeAuthModeTypes: [AppSyncAuthorizationType.USER_POOL],
      },
    });

    const messages = fn('Messages', 'messages', 'chat', {
      PROJECT: cfg.project,
      BMG_ENV: env,
      ACCOUNT_ID: this.account,
      DATA_ACCESS_ROLE_ARN: dataAccessRoleArn,
      PLATFORM_KEY_ARN: props.platformKey.keyArn,
      EVENTS_HTTP_DOMAIN: this.realtime.httpDns,
    });
    // ── Web push: the environment's VAPID key pair, generated once inside AWS ──
    const vapidSecretId = `${cfg.project}/${env}/vapid`;
    const vapid = new Secret(this, 'VapidKeys', {
      secretName: vapidSecretId,
      description: `BMG ${env}: web push (VAPID) key pair`,
      encryptionKey: props.platformKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    acknowledge(
      vapid,
      'VAPID keys must stay stable: rotating them would cancel every device subscription.',
      'AwsSolutions-SMG4',
    );
    const vapidFn = new BmgFunction(this, 'VapidKeysSetup', {
      entry: 'services/api/src/handlers/vapid-keys.ts',
      description: `BMG ${env}: create the web push key pair if missing`,
      timeout: Duration.seconds(30),
      prod,
      environment: {
        VAPID_SECRET_ID: vapidSecretId,
        VAPID_SUBJECT: `mailto:${cfg.email.senderAddress}`,
      },
    });
    // Explicit grants: the secret's key lives in the foundation stack, and
    // Secret.grant* would edit that key's policy (a stack cycle).
    const vapidArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${vapidSecretId}-*`;
    const readVapid = (f: BmgFunction) => {
      f.addToRolePolicy(
        new PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [vapidArn] }),
      );
      props.platformKey.grant(f, 'kms:Decrypt');
      acknowledge(
        f.role!,
        'The Secrets Manager ARN ends in a random suffix, so the secret name is matched with -*.',
        `AwsSolutions-IAM5[Resource::${vapidArn}]`,
      );
    };
    readVapid(vapidFn);
    vapidFn.addToRolePolicy(
      new PolicyStatement({ actions: ['secretsmanager:PutSecretValue'], resources: [vapidArn] }),
    );
    props.platformKey.grant(vapidFn, 'kms:Encrypt', 'kms:GenerateDataKey');
    new CustomResource(this, 'VapidKeysReady', {
      serviceToken: vapidFn.functionArn,
      resourceType: 'Custom::BmgVapidKeys',
    }).node.addDependency(vapid, vapidFn, vapidFn.role!);

    const notifications = fn('Notifications', 'notifications', 'notifications and preferences', {
      VAPID_SECRET_ID: vapidSecretId,
    });
    readVapid(notifications);
    const review = fn('Review', 'review', 'submissions and the review queue', {
      PROJECT: cfg.project,
      BMG_ENV: env,
      ACCOUNT_ID: this.account,
      DATA_ACCESS_ROLE_ARN: dataAccessRoleArn,
    });
    const gigsEvents = fn('Events', 'events', 'artist gigs and Blueprint events');
    // 20 s: "Automatically get logo" fetches the venue's website (8 s budget).
    const addressBook = fn(
      'AddressBook',
      'address-book',
      'shared contacts and venues',
      {},
      false,
      Duration.seconds(20),
    );
    const prompts = fn('Prompts', 'prompts', 'Settings - AI prompts: drafts, versions, publish');
    // ── Assistant (design 10, F4) ──
    const aiChat = new BmgFunction(this, 'AiChat', {
      entry: 'services/api/src/handlers/ai-chat.ts',
      description: `BMG ${env} API: the assistant (consent, prompts, agent, action tokens)`,
      roleName: `${p}-api-ai-chat`,
      prod,
      bundleAwsSdk: true,
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...common,
        AGENT_RUNTIME_ARN: props.agentRuntimeArn,
        ACTION_KEY_ID: props.actionKey.keyArn,
      },
    });
    const aiTools = fn(
      'AiTools',
      'ai-tools',
      "the assistant's read tools",
      { AI_RETRIEVE_ROLE_ARN: `arn:aws:iam::${this.account}:role/${p}-ai-retrieve` },
      true,
    );
    const aiActions = fn('AiActions', 'ai-actions', 'carry out confirmed assistant actions', {
      ACTION_KEY_ID: props.actionKey.keyArn,
    });
    const aiConsent = fn('AiConsent', 'ai-consent', "record each artist's AI choice");
    const newsroom = fn(
      'Newsroom',
      'newsroom',
      'newsletter drafts, settings and industry sites',
      { DRAFT_FUNCTION: props.newsroomDraftArn },
      true,
    );
    const smtpSecretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${names.smtpSecret(cfg, env)}-*`;
    const webUrlParam = names.ssm(cfg, env, 'web/url');
    const artists = fn('Artists', 'artists', 'invite artists', {
      USER_POOL_ID: props.userPool.userPoolId,
      ONBOARDING_STATE_MACHINE_ARN: props.onboarding.stateMachineArn,
      // Invites go out as BMG-branded email through Gmail SMTP (design F1).
      SMTP_SECRET_ID: names.smtpSecret(cfg, env),
      APP_URL_PARAM: webUrlParam,
      APP_ORIGIN: `https://${names.host(cfg, env, 'app')}`,
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
    // The terms and AI summary on ARTIST#id / AI (Artists & access roster).
    allow(consent, 'RecordConsentSummary', ['dynamodb:UpdateItem'], [main]);
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
    allow(
      artists,
      'Invites',
      // BatchGetItem: team names, titles and assignments (Access & permissions).
      ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      [main],
    );
    allow(artists, 'ReadSmtpSecret', ['secretsmanager:GetSecretValue'], [smtpSecretArn]);
    allow(
      artists,
      'ReadAppUrl',
      ['ssm:GetParameter'],
      [`arn:aws:ssm:${this.region}:${this.account}:parameter${webUrlParam}`],
    );
    acknowledge(
      artists.role!,
      'Secrets Manager appends a random suffix to secret ARNs; the wildcard matches only that suffix of the one SMTP secret.',
      `AwsSolutions-IAM5[Resource::${smtpSecretArn}]`,
    );
    allow(
      workspace,
      'WorkspaceItems',
      [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        // Custom plan stages are deleted from the library.
        'dynamodb:DeleteItem',
        'dynamodb:Query',
      ],
      [main],
    );
    // To-do edits are announced on the bus so the notifier can tell the right person.
    putEvents(workspace);
    const reminderSchedules = `arn:aws:scheduler:${this.region}:${this.account}:schedule/${p}-reminders/todo-*`;
    allow(
      workspace,
      'ReminderSchedules',
      ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule'],
      [reminderSchedules],
    );
    allow(workspace, 'PassReminderRole', ['iam:PassRole'], [reminderRole.roleArn]);
    acknowledge(
      workspace.role!,
      "One reminder schedule per to-do, named todo-<artistId>-<todoId>, in this environment's reminder group.",
      `AwsSolutions-IAM5[Resource::${reminderSchedules}]`,
    );
    // Roster (GSI1) and all-artist to-dos (GSI2); GSI3 is the review queue (review function).
    allow(
      workspace,
      'WorkspaceIndexes',
      ['dynamodb:Query'],
      [`${main}/index/GSI1`, `${main}/index/GSI2`],
    );
    allow(
      files,
      'FileRecords',
      [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
      ],
      [main],
    );
    // Deleting a document: the stored library object, or an upload still in quarantine.
    allow(
      files,
      'DeleteFiles',
      ['s3:DeleteObject'],
      [
        ...[objects('quarantine', 'artists/*'), objects('quarantine', 'library/*')],
        objects('org-data', 'library/*'),
      ],
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
      review,
      'SubmissionItems',
      [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
      ],
      [main],
    );
    // GSI3: the review queue, by status then priority and date.
    allow(review, 'ReviewQueue', ['dynamodb:Query'], [`${main}/index/GSI3`]);
    // Notes and feedback are sealed with the artist's key, in a data-access session.
    allow(review, 'ArtistSessions', ['sts:AssumeRole', 'sts:TagSession'], [dataAccessRoleArn]);
    putEvents(review);
    allow(
      gigsEvents,
      'GigAndEventItems',
      [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
      ],
      [main],
    );
    // GSI3 also holds every shared gig (GSI3PK GIGS) for Blueprint's "Artist gigs".
    allow(gigsEvents, 'SharedGigs', ['dynamodb:Query'], [`${main}/index/GSI3`]);
    putEvents(gigsEvents);

    // ── Connectors and Insights (Phase 4) ──
    // Org tokens are sealed under the platform key; artist tokens under the
    // artist's key, in a data-access session (design 9.1).
    const connectorSecretPrefix = names.connectorSecretPrefix(cfg, env);
    const connectorSecrets = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${connectorSecretPrefix}/*`;
    const connectorEnv = {
      ...common,
      PROJECT: cfg.project,
      BMG_ENV: env,
      ACCOUNT_ID: this.account,
      DATA_ACCESS_ROLE_ARN: dataAccessRoleArn,
      PLATFORM_KEY_ARN: props.platformKey.keyArn,
      CONNECTOR_SECRET_PREFIX: connectorSecretPrefix,
      APP_URL_PARAM: webUrlParam,
    };
    // Role names stay under `<p>-api-*`, which the data-access role trusts.
    const connectors = new BmgFunction(this, 'Connectors', {
      entry: 'services/api/src/handlers/connectors.ts',
      description: `BMG ${env} API: connectors, stats and insights`,
      roleName: `${p}-api-connectors`,
      prod,
      // Connecting calls the vendor a few times; API Gateway allows 29 s.
      timeout: Duration.seconds(28),
      environment: connectorEnv,
    });
    const connectorsSync = new BmgFunction(this, 'ConnectorsSync', {
      entry: 'services/api/src/handlers/connectors-sync.ts',
      description: `BMG ${env}: hourly connector sync into daily snapshots`,
      roleName: `${p}-api-connectors-sync`,
      prod,
      timeout: Duration.minutes(5),
      environment: connectorEnv,
    });
    for (const f of [connectors, connectorsSync]) {
      allow(
        f,
        'ConnectorItems',
        [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:PutItem',
          'dynamodb:BatchWriteItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
        ],
        [main],
      );
      // GSI1: roster and the list of connections; GSI3: shared gigs for the calendar.
      allow(
        f,
        'ConnectorIndexes',
        ['dynamodb:Query'],
        [`${main}/index/GSI1`, `${main}/index/GSI3`],
      );
      allow(f, 'ArtistSessions', ['sts:AssumeRole', 'sts:TagSession'], [dataAccessRoleArn]);
      allow(f, 'ReadConnectorApps', ['secretsmanager:GetSecretValue'], [connectorSecrets]);
      allow(
        f,
        'ReadAppUrl',
        ['ssm:GetParameter'],
        [`arn:aws:ssm:${this.region}:${this.account}:parameter${webUrlParam}`],
      );
      putEvents(f);
      props.platformKey.grant(f, 'kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey');
      acknowledge(
        f.role!,
        'One secret per connector OAuth app under bmg/<env>/connectors/; Secrets Manager also appends a random suffix.',
        `AwsSolutions-IAM5[Resource::${connectorSecrets}]`,
      );
    }
    // Admins register the vendor OAuth apps in the app (Connectors → Connector apps).
    allow(
      connectors,
      'WriteConnectorApps',
      [
        'secretsmanager:CreateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:TagResource',
      ],
      [connectorSecrets],
    );
    new Rule(this, 'ConnectorsHourly', {
      description: 'Pull connector stats into daily snapshots',
      schedule: Schedule.rate(Duration.hours(1)),
      targets: [new LambdaFunction(connectorsSync, { retryAttempts: 0 })],
    });
    allow(
      prompts,
      'PromptItems',
      ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
      [main],
    );
    putEvents(prompts);
    allow(
      aiChat,
      'AssistantItems',
      ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem', 'dynamodb:Query'],
      [main],
    );
    allow(
      aiChat,
      'InvokeTheAgent',
      ['bedrock-agentcore:InvokeAgentRuntime'],
      [props.agentRuntimeArn, `${props.agentRuntimeArn}/*`],
    );
    props.actionKey.grant(aiChat, 'kms:GenerateMac');
    acknowledge(
      aiChat.role!,
      'InvokeAgentRuntime is authorised on the runtime and its endpoints (runtime ARN + "/*"); this is the one assistant runtime for this environment.',
      `AwsSolutions-IAM5[Resource::${prod ? 'bmg-prod' : 'bmg-staging'}-ai:ExportsOutputFnGetAttAgent255F68E9AgentRuntimeArn6937379E/*]`,
    );
    putEvents(aiChat);
    allow(
      aiTools,
      'ReadWorkspaces',
      ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query'],
      [main],
    );
    allow(aiTools, 'Roster', ['dynamodb:Query'], [`${main}/index/GSI1`]);
    allow(
      aiTools,
      'RetrieveSessions',
      ['sts:AssumeRole', 'sts:TagSession'],
      [`arn:aws:iam::${this.account}:role/${p}-ai-retrieve`],
    );
    allow(aiActions, 'SingleUseTokens', ['dynamodb:PutItem'], [main]);
    props.actionKey.grant(aiActions, 'kms:VerifyMac');
    putEvents(aiActions);
    allow(aiConsent, 'RecordAiChoice', ['dynamodb:UpdateItem'], [main]);
    allow(
      newsroom,
      'NewsroomItems',
      [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
      ],
      [main],
    );
    allow(newsroom, 'Regenerate', ['lambda:InvokeFunction'], [props.newsroomDraftArn]);
    allow(
      addressBook,
      'AddressBookItems',
      [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
      ],
      [main],
    );
    // Booking counts on venue cards read the shared-gigs index.
    allow(addressBook, 'VenueBookings', ['dynamodb:Query'], [`${main}/index/GSI3`]);
    putEvents(addressBook);
    putEvents(newsroom);
    allow(me, 'RecordAiChoice', ['dynamodb:UpdateItem'], [main]);
    // Job title (rev 7) and profile picture live on USER#<sub> / PROFILE.
    allow(me, 'ReadProfile', ['dynamodb:GetItem'], [main]);
    props.platformKey.grant(me, 'kms:Decrypt');
    new Rule(this, 'AiConsentChanges', {
      eventBus: props.bus,
      description: "Keep each artist's current AI choice in step with the consent ledger",
      eventPattern: { source: ['bmg.identity'], detailType: ['consent.aiChanged'] },
      targets: [
        new LambdaFunction(aiConsent, { retryAttempts: 8, maxEventAge: Duration.hours(6) }),
      ],
    });
    allow(
      messages,
      'ConversationItems',
      [
        'dynamodb:GetItem',
        'dynamodb:BatchGetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:ConditionCheckItem',
      ],
      [main],
    );
    // GSI1: the roster, for the artist directory.
    allow(messages, 'ArtistDirectory', ['dynamodb:Query'], [`${main}/index/GSI1`]);
    // Artist-to-artist keys are wrapped under each artist's key, in an artist session.
    allow(messages, 'ArtistSessions', ['sts:AssumeRole', 'sts:TagSession'], [dataAccessRoleArn]);
    this.realtime.grantPublish(messages);
    acknowledge(
      messages.role!,
      'Publishes inbox nudges (ids only) to channels in this API; channel names are per user.',
      // The partition renders literally or as a token depending on the synth context.
      ...['aws', '<AWS::Partition>'].map(
        (partition) =>
          `AwsSolutions-IAM5[Resource::arn:${partition}:appsync:${this.region}:${this.account}:apis/<${this.getLogicalId(this.realtime.node.defaultChild as never)}.ApiId>/channelNamespace/*]`,
      ),
    );
    allow(
      notifications,
      'OwnNotificationsAndPreferences',
      [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:DeleteItem',
      ],
      [main],
    );
    putEvents(messages);

    // ── Notifications: domain events → in-app items, realtime nudges, email (design 7.4) ──
    const queueOpts = {
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: props.platformKey,
      enforceSSL: true,
    };
    const mailDlq = new Queue(this, 'MailDeadLetters', {
      ...queueOpts,
      queueName: `${p}-mail-dlq`,
      retentionPeriod: Duration.days(14),
    });
    acknowledge(mailDlq, 'This is the dead-letter queue itself.', 'AwsSolutions-SQS3');
    const mailQueue = new Queue(this, 'MailQueue', {
      ...queueOpts,
      queueName: `${p}-mail`,
      visibilityTimeout: Duration.minutes(2),
      deadLetterQueue: { queue: mailDlq, maxReceiveCount: 5 },
    });
    const notifier = new BmgFunction(this, 'Notifier', {
      entry: 'services/api/src/handlers/notifier.ts',
      description: `BMG ${env}: turn domain events into notifications`,
      timeout: Duration.seconds(30),
      prod,
      environment: {
        ...common,
        USER_POOL_ID: props.userPool.userPoolId,
        MAIL_QUEUE_URL: mailQueue.queueUrl,
        VAPID_SECRET_ID: vapidSecretId,
        EVENTS_HTTP_DOMAIN: this.realtime.httpDns,
      },
    });
    allow(
      notifier,
      'FindRecipients',
      ['cognito-idp:ListUsersInGroup'],
      [props.userPool.userPoolArn],
    );
    allow(notifier, 'WriteNotifications', ['dynamodb:PutItem', 'dynamodb:BatchGetItem'], [main]);
    mailQueue.grantSendMessages(notifier);
    acknowledge(
      notifier.role!,
      'CDK queue grant on the encrypted mail queue (platform key).',
      ...KMS_GRANT_FINDINGS,
    );
    this.realtime.grantPublish(notifier);
    props.platformKey.grant(notifier, 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey');
    const notifierDlq = new Queue(this, 'NotifierDeadLetters', {
      ...queueOpts,
      queueName: `${p}-notifier-dlq`,
      retentionPeriod: Duration.days(14),
    });
    acknowledge(notifierDlq, 'This is the dead-letter queue itself.', 'AwsSolutions-SQS3');
    new Rule(this, 'DomainEventsToNotifier', {
      eventBus: props.bus,
      description: 'Workspace events that notify someone',
      eventPattern: {
        source: ['bmg.workspace'],
        detailType: [
          'submission.created',
          'submission.updated',
          'submission.feedbackGiven',
          'message.created',
          'file.rejected',
          'gig.helpRequested',
          'todo.commented',
          'connector.reminder',
          'connector.needsReauth',
        ],
      },
      targets: [
        new LambdaFunction(notifier, {
          deadLetterQueue: notifierDlq,
          retryAttempts: 4,
          maxEventAge: Duration.hours(2),
        }),
      ],
    });

    const mailer = new BmgFunction(this, 'Mailer', {
      entry: 'services/api/src/handlers/mailer.ts',
      description: `BMG ${env}: send notification email through Gmail SMTP`,
      timeout: Duration.seconds(30),
      prod,
      environment: { SMTP_SECRET_ID: names.smtpSecret(cfg, env), APP_URL_PARAM: webUrlParam },
    });
    allow(mailer, 'ReadSmtpSecret', ['secretsmanager:GetSecretValue'], [smtpSecretArn]);
    allow(
      mailer,
      'ReadWebUrl',
      ['ssm:GetParameter'],
      [`arn:aws:ssm:${this.region}:${this.account}:parameter${webUrlParam}`],
    );
    props.platformKey.grant(mailer, 'kms:Decrypt');
    // Two at a time at most (the SQS minimum), one email per message: well inside Gmail's limits.
    mailer.addEventSource(new SqsEventSource(mailQueue, { batchSize: 1, maxConcurrency: 2 }));
    acknowledge(
      mailer.role!,
      'The Secrets Manager ARN ends in a random suffix, so the secret name is matched with -*.',
      `AwsSolutions-IAM5[Resource::${smtpSecretArn}]`,
    );
    acknowledge(
      notifier.role!,
      'Publishes per-user inbox nudges (ids only) to channels in this API.',
      ...['aws', '<AWS::Partition>'].map(
        (partition) =>
          `AwsSolutions-IAM5[Resource::arn:${partition}:appsync:${this.region}:${this.account}:apis/<${this.getLogicalId(this.realtime.node.defaultChild as never)}.ApiId>/channelNamespace/*]`,
      ),
    );
    for (const [id, q] of [
      ['MailFailures', mailDlq],
      ['NotifierFailures', notifierDlq],
    ] as const) {
      new Alarm(this, id, {
        alarmName: `${p}-${id.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
        alarmDescription: 'Notifications could not be delivered (see the DLQ).',
        metric: q.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(props.alarmTopic));
    }

    allow(
      artists,
      'StartOnboarding',
      ['states:StartExecution'],
      [props.onboarding.stateMachineArn],
    );
    allow(
      artists,
      'CreateArtistUsers',
      [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminAddUserToGroup',
        // Resending an invite: check the user is still unconfirmed, then set a new temporary password.
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminSetUserPassword',
        // Access & permissions: the Blueprint team (list, role, on/off, sign out).
        'cognito-idp:ListUsers',
        'cognito-idp:ListUsersInGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminDisableUser',
        'cognito-idp:AdminEnableUser',
        'cognito-idp:AdminUserGlobalSignOut',
      ],
      [props.userPool.userPoolArn],
    );
    putEvents(artists);
    for (const f of [
      authorizerFn,
      me,
      consent,
      artists,
      workspace,
      files,
      review,
      messages,
      notifications,
      gigsEvents,
      prompts,
      aiChat,
      aiTools,
      aiActions,
      aiConsent,
      newsroom,
      addressBook,
    ]) {
      props.platformKey.grant(f, 'kms:Decrypt');
    }
    for (const f of [
      consent,
      stepUp,
      artists,
      workspace,
      files,
      review,
      messages,
      notifications,
      gigsEvents,
      prompts,
      aiChat,
      aiActions,
      aiConsent,
      me,
      newsroom,
      addressBook,
    ]) {
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
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
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
    // One proxy integration and one invoke permission per function, scoped to
    // this API. LambdaIntegration adds two permissions per route, which pushed
    // the stack past CloudFormation's 500-resource limit.
    const integrations = new Map<BmgFunction, Integration>();
    const integrationFor = (handler: BmgFunction) => {
      let i = integrations.get(handler);
      if (!i) {
        handler.addPermission('ApiInvoke', {
          principal: new ServicePrincipal('apigateway.amazonaws.com'),
          sourceArn: this.api.arnForExecuteApi('*', '/*', '*'),
        });
        i = new Integration({
          type: IntegrationType.AWS_PROXY,
          integrationHttpMethod: 'POST',
          uri: `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/functions/${handler.functionArn}/invocations`,
        });
        integrations.set(handler, i);
      }
      return i;
    };
    const route = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      handler: BmgFunction,
    ) => {
      const resource = path
        .split('/')
        .filter(Boolean)
        .reduce((r, part) => r.getResource(part) ?? r.addResource(part), this.api.root);
      resource.addMethod(method, integrationFor(handler), {
        authorizer,
        requestValidator: validator,
      });
    };
    route('GET', '/me', me);
    route('PATCH', '/me', me);
    route('GET', '/consent', consent);
    route('POST', '/consent', consent);
    route('POST', '/step-up/totp/setup', stepUp);
    route('POST', '/step-up/totp/verify', stepUp);
    route('POST', '/artists', artists);
    route('POST', '/artists/{artistId}/invite/resend', artists);
    route('GET', '/artists', workspace);
    route('GET', '/artists/{artistId}', workspace);
    route('GET', '/artists/{artistId}/brand-kit', workspace);
    route('PUT', '/artists/{artistId}/brand-kit', workspace);
    route('GET', '/artists/{artistId}/plan', workspace);
    route('PUT', '/artists/{artistId}/plan', workspace);
    route('GET', '/artists/{artistId}/plan/history', workspace);
    route('GET', '/artists/{artistId}/todos', workspace);
    route('POST', '/artists/{artistId}/todos', workspace);
    route('PATCH', '/artists/{artistId}/todos/{todoId}', workspace);
    route('GET', '/todos', workspace);
    route('GET', '/artists/{artistId}/todos/{todoId}/comments', workspace);
    route('POST', '/artists/{artistId}/todos/{todoId}/comments', workspace);
    route('DELETE', '/artists/{artistId}/todos/{todoId}/comments/{commentId}', workspace);
    route('GET', '/plan-stages', workspace);
    route('POST', '/plan-stages', workspace);
    route('PUT', '/plan-stages/{stageId}', workspace);
    route('DELETE', '/plan-stages/{stageId}', workspace);
    route('POST', '/plan-stages/{stageId}/apply', workspace);
    route('GET', '/artists/{artistId}/files', files);
    route('POST', '/artists/{artistId}/files', files);
    route('GET', '/artists/{artistId}/files/{fileId}', files);
    route('PATCH', '/artists/{artistId}/files/{fileId}', files);
    route('PUT', '/artists/{artistId}/files/{fileId}/asset', files);
    route('DELETE', '/artists/{artistId}/files/{fileId}/asset', files);
    route('POST', '/artists/{artistId}/files/{fileId}/download', files);
    route('DELETE', '/artists/{artistId}/files/{fileId}', files);
    route('GET', '/review-queue', review);
    route('GET', '/artists/{artistId}/submissions', review);
    route('POST', '/artists/{artistId}/submissions', review);
    route('GET', '/artists/{artistId}/submissions/{submissionId}', review);
    route('PATCH', '/artists/{artistId}/submissions/{submissionId}', review);
    route('POST', '/artists/{artistId}/submissions/{submissionId}/feedback', review);
    route('GET', '/gigs', gigsEvents);
    route('GET', '/artists/{artistId}/gigs', gigsEvents);
    route('POST', '/artists/{artistId}/gigs', gigsEvents);
    route('PATCH', '/artists/{artistId}/gigs/{gigId}', gigsEvents);
    route('GET', '/events', gigsEvents);
    route('POST', '/events', gigsEvents);
    route('GET', '/events/{eventId}', gigsEvents);
    route('PATCH', '/events/{eventId}', gigsEvents);
    route('POST', '/events/{eventId}/{part}', gigsEvents);
    route('PATCH', '/events/{eventId}/{part}/{itemId}', gigsEvents);
    route('DELETE', '/events/{eventId}/{part}/{itemId}', gigsEvents);
    route('GET', '/ai/prompts', prompts);
    route('GET', '/ai/prompts/{promptId}', prompts);
    route('PUT', '/ai/prompts/{promptId}/draft', prompts);
    route('DELETE', '/ai/prompts/{promptId}/draft', prompts);
    route('POST', '/ai/prompts/{promptId}/publish', prompts);
    route('POST', '/ai/prompts/{promptId}/rollback', prompts);
    route('POST', '/ai/chat', aiChat);
    route('GET', '/ai/chat/history', aiChat);
    route('POST', '/ai/actions/confirm', aiActions);
    route('GET', '/ai/tools/artists', aiTools);
    route('GET', '/ai/tools/workspace', aiTools);
    route('GET', '/ai/tools/search', aiTools);
    // Newsroom: one function under a proxy resource.
    const newsroomRes = this.api.root.addResource('newsroom');
    newsroomRes.addMethod('GET', integrationFor(newsroom), {
      authorizer,
      requestValidator: validator,
    });
    newsroomRes.addResource('{proxy+}').addMethod('ANY', integrationFor(newsroom), {
      authorizer,
      requestValidator: validator,
    });
    // Access & permissions (settings and the Blueprint team): one proxy route
    // on the artists function, which already manages Cognito users.
    this.api.root
      .addResource('access')
      .addResource('{proxy+}')
      .addMethod('ANY', integrationFor(artists), { authorizer, requestValidator: validator });
    // Contacts (and venues): one function under proxy resources, to keep the stack small.
    for (const root of ['contacts', 'venues']) {
      const res = this.api.root.addResource(root);
      res.addMethod('ANY', integrationFor(addressBook), {
        authorizer,
        requestValidator: validator,
      });
      res
        .addResource('{proxy+}')
        .addMethod('ANY', integrationFor(addressBook), { authorizer, requestValidator: validator });
    }
    route('GET', '/connectors', connectors);
    route('POST', '/connectors/callback', connectors);
    route('GET', '/connectors/apps', connectors);
    route('PUT', '/connectors/apps/{provider}', connectors);
    route('DELETE', '/connectors/apps/{provider}', connectors);
    route('GET', '/connectors/humanitix/events', connectors);
    route('POST', '/connectors/{connectorId}/connect', connectors);
    route('PATCH', '/connectors/{connectorId}', connectors);
    route('DELETE', '/connectors/{connectorId}', connectors);
    route('POST', '/connectors/{connectorId}/sync', connectors);
    route('PUT', '/events/{eventId}/humanitix', connectors);
    route('POST', '/artists/{artistId}/connectors/remind', connectors);
    route('GET', '/artists/{artistId}/connectors', connectors);
    route('POST', '/artists/{artistId}/connectors/{connectorId}/connect', connectors);
    route('PATCH', '/artists/{artistId}/connectors/{connectorId}', connectors);
    route('DELETE', '/artists/{artistId}/connectors/{connectorId}', connectors);
    route('POST', '/artists/{artistId}/connectors/{connectorId}/sync', connectors);
    route('GET', '/artists/{artistId}/stats', connectors);
    route('POST', '/artists/{artistId}/stats', connectors);
    route('POST', '/stats', connectors);
    route('GET', '/insights', connectors);
    route('GET', '/conversations', messages);
    route('POST', '/conversations', messages);
    route('PATCH', '/conversations/{conversationId}', messages);
    route('DELETE', '/conversations/{conversationId}', messages);
    route('PATCH', '/conversations/{conversationId}/me', messages);
    route('POST', '/conversations/{conversationId}/members', messages);
    route('DELETE', '/conversations/{conversationId}/members/{artistId}', messages);
    route('GET', '/conversations/{conversationId}/messages', messages);
    route('POST', '/conversations/{conversationId}/messages', messages);
    route('GET', '/directory', messages);
    route('GET', '/notifications', notifications);
    route('POST', '/notifications/read', notifications);
    route('GET', '/preferences', notifications);
    route('PUT', '/preferences', notifications);
    route('GET', '/push/key', notifications);
    route('POST', '/push/subscriptions', notifications);
    route('POST', '/push/unsubscribe', notifications);
    route('GET', '/library/files', files);
    route('POST', '/library/files', files);
    route('GET', '/library/files/{fileId}', files);
    route('PATCH', '/library/files/{fileId}', files);
    route('POST', '/library/files/{fileId}/download', files);
    route('DELETE', '/library/files/{fileId}', files);

    acknowledge(
      this.api,
      'Access tokens are verified by the Lambda authorizer (aws-jwt-verify) so it can also apply the step-up rule for social sign-ins (design 6.2, 7.2).',
      'AwsSolutions-COG4',
    );

    // ── Regional AWS WAF ──
    /** Matches one method on a URI path (the path regex is matched as given). */
    const wafRoute = (method: string, pathRegex: string) => ({
      andStatement: {
        statements: [
          {
            byteMatchStatement: {
              fieldToMatch: { method: {} },
              positionalConstraint: 'EXACTLY',
              searchString: method,
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          {
            regexMatchStatement: {
              fieldToMatch: { uriPath: {} },
              regexString: pathRegex,
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
        ],
      },
    });
    const managed = (name: string, priority: number, countOnly: string[] = []) => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ...(countOnly.length
            ? {
                ruleActionOverrides: countOnly.map((n) => ({
                  name: n,
                  actionToUse: { count: {} },
                })),
              }
            : {}),
        },
      },
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
      // Inspect up to 64 KB of each body, so BodySizeLimit can enforce 64 KB.
      associationConfig: { requestBody: { API_GATEWAY: { defaultSizeInspectionLimit: 'KB_64' } } },
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
        // The common set blocks any body over 8 KB (SizeRestrictions_BODY), which
        // stopped real saves: venue logos and profile pictures go up as data URLs
        // in JSON, and AI prompts, plans and run sheets can pass 8 KB too. That
        // rule only counts here; BodySizeLimit blocks bodies over 64 KB instead,
        // except the two image routes, whose handlers cap the image themselves
        // (LOGO_MAX_BYTES). Every handler also validates its own field lengths.
        managed('AWSManagedRulesCommonRuleSet', 1, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
        {
          name: 'BodySizeLimit',
          priority: 3,
          action: { block: {} },
          statement: {
            andStatement: {
              statements: [
                {
                  sizeConstraintStatement: {
                    fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
                    comparisonOperator: 'GT',
                    size: BODY_LIMIT_BYTES,
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
                {
                  notStatement: {
                    statement: {
                      orStatement: {
                        statements: IMAGE_ROUTES.map(([method, path]) => wafRoute(method, path)),
                      },
                    },
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: 'BodySizeLimit',
          },
        },
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
    new CfnOutput(this, 'RealtimeEndpoint', { value: this.realtime.realtimeDns });
  }
}
