import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
  Function as CfFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin, HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  ClientAttributes,
  OAuthScope,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  type IUserPool,
} from 'aws-cdk-lib/aws-cognito';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { IEventBus } from 'aws-cdk-lib/aws-events';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction, REPO_ROOT } from './function.ts';

export interface WebStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly userPool: IUserPool;
  /** API Gateway REST API id; its `v1` stage is served under /v1/* on the same origin. */
  readonly restApiId: string;
  /** The quarantine bucket the browser uploads to (presigned POST). */
  readonly uploadOrigin: string;
  /** Where downloads come from (artist-data and org-data buckets): asset thumbnails and previews. */
  readonly downloadOrigins: string[];
  /** AppSync Events domains for realtime inbox nudges. */
  readonly realtime: { httpDns: string; realtimeDns: string };
  /**
   * Social sign-in providers turned on, by Cognito name (identity stack, which
   * deploys first); none means no OAuth on the client.
   */
  readonly socialProviders?: string[];
  /** Text-message codes, when on: the role Cognito sends them with. */
  readonly sms?: { roleArn: string; externalId: string } | undefined;
  /** For the public endpoints (newsletter sign-up, recovery codes). */
  readonly mainTable: ITable;
  readonly platformKey: IKey;
  readonly bus: IEventBus;
}

const WEB_DIST = resolve(REPO_ROOT, 'apps/web/dist');

/**
 * The web app for one environment (design 5, 13.1):
 * - a private S3 bucket behind CloudFront (origin access control);
 * - /v1/* forwarded to API Gateway, so the app and API share one origin and
 *   need no CORS;
 * - strict security headers, including a CSP that only allows this origin
 *   and Cognito;
 * - the public web client (code + PKCE) whose callback is this origin.
 * A custom domain and the edge WAF (us-east-1) follow once DNS for
 * blueprintmusic.group is on AWS.
 */
export class WebStack extends BmgStack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;

    const logs = new Bucket(this, 'WebAccessLogs', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // CloudFront standard logs are delivered with ACLs.
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(prod ? 365 : 30) }],
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !prod,
    });
    const site = new Bucket(this, 'Site', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: logs,
      serverAccessLogsPrefix: 'site/',
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !prod,
    });

    // Sign-in runs on the app's own screens against Cognito's user-pool API
    // (no hosted UI), so the browser only talks to cognito-idp.
    const cognitoIdp = `https://cognito-idp.${this.region}.amazonaws.com`;
    // Social sign-in (design D2) goes through Cognito's domain: the browser
    // is sent there to pick the provider, and swaps the code for tokens there.
    const social = props.socialProviders ?? [];
    const loginHost = `${names.cognitoDomainPrefix(cfg, env)}.auth.${this.region}.amazoncognito.com`;
    const headers = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${p}-web-security`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "font-src 'self'",
            `img-src 'self' data: blob: ${props.downloadOrigins.join(' ')}`,
            // blob: lets the browser read a picked video locally to draw its preview.
            `media-src 'self' blob: ${props.downloadOrigins.join(' ')}`,
            // Download origins: the app reads images itself (brand kit PDF, profile pictures).
            `connect-src 'self' ${cognitoIdp}${social.length ? ` https://${loginHost}` : ''} ${props.uploadOrigin} ${props.downloadOrigins.join(' ')} wss://${props.realtime.realtimeDns}`,
            // Venue details show the address on an embedded Google map.
            'frame-src https://www.google.com',
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "object-src 'none'",
          ].join('; '),
        },
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: false,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: HeadersFrameOption.DENY },
        referrerPolicy: { override: true, referrerPolicy: HeadersReferrerPolicy.NO_REFERRER },
      },
      // Phase 6 review (finding W2): turn off browser features the app never
      // uses, and keep other sites' windows from holding a reference to ours.
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value:
              'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()',
            override: true,
          },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
        ],
      },
    });

    const apiDomain = `${props.restApiId}.execute-api.${this.region}.amazonaws.com`;
    // Single-page app routing at the edge, for the site only: paths without a
    // file extension (e.g. /auth/callback) load index.html. Distribution-level
    // error responses would also rewrite the API's own 403/404 answers into
    // index.html, hiding its problem+json errors from the app.
    const spaRouting = new CfFunction(this, 'SpaRouting', {
      functionName: `${p}-spa-routing`,
      runtime: FunctionRuntime.JS_2_0,
      comment: 'Serve index.html for app routes',
      code: FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
      ),
    });
    // ── Public endpoints (no sign-in): newsletter sign-up and recovery codes ──
    const publicFn = new BmgFunction(this, 'Public', {
      entry: 'services/api/src/handlers/public.ts',
      description: `BMG ${env}: public endpoints (newsletter sign-up, recovery codes)`,
      prod,
      timeout: Duration.seconds(15),
      environment: {
        MAIN_TABLE: props.mainTable.tableName,
        EVENT_BUS: props.bus.eventBusName,
        USER_POOL_ID: props.userPool.userPoolId,
      },
    });
    publicFn.addToRolePolicy(
      new PolicyStatement({
        sid: 'SignupsRecoveryAndRateLimits',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
        ],
        resources: [props.mainTable.tableArn],
      }),
    );
    publicFn.addToRolePolicy(
      new PolicyStatement({
        sid: 'RecoveryCodes',
        actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminSetUserMFAPreference'],
        resources: [props.userPool.userPoolArn],
      }),
    );
    publicFn.addToRolePolicy(
      new PolicyStatement({
        sid: 'TellThePerson',
        actions: ['events:PutEvents'],
        resources: [props.bus.eventBusArn],
      }),
    );
    // Opens Blueprint's Mailchimp token (sealed under the platform key).
    props.platformKey.grant(publicFn, 'kms:Decrypt');
    const publicUrl = publicFn.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

    const distribution = new Distribution(this, 'Distribution', {
      comment: `BMG ${env} web app`,
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_ALL,
      enableLogging: true,
      logBucket: logs,
      logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [
          { function: spaRouting, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/v1/*': {
          origin: new HttpOrigin(apiDomain, { protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
        // The public endpoints (newsletter sign-up, recovery codes): this
        // function's URL, signed by CloudFront (origin access control).
        '/public/*': {
          origin: FunctionUrlOrigin.withOriginAccessControl(publicUrl),
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
        // Settings change per deploy; never cache them.
        '/config.json': {
          origin: S3BucketOrigin.withOriginAccessControl(site),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: headers,
        },
      },
    });
    const origin = `https://${distribution.distributionDomainName}`;

    const client = new UserPoolClient(this, 'WebClient', {
      userPool: props.userPool,
      userPoolClientName: `${p}-web-app`,
      generateSecret: false,
      // Choice-based sign-in (passkey or password, then the authenticator code)
      // from the app's own screens. No OAuth, so Cognito's hosted UI can't be used.
      authFlows: { user: true },
      // OAuth (code + PKCE) only for social sign-in; the app's own screens
      // still do every other sign-in. Without providers it stays off.
      ...(social.length
        ? {
            oAuth: {
              flows: { authorizationCodeGrant: true },
              scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
              callbackUrls: [`https://${distribution.distributionDomainName}/auth/callback`],
              logoutUrls: [`https://${distribution.distributionDomainName}/`],
            },
          }
        : { disableOAuth: true }),
      supportedIdentityProviders: [
        UserPoolClientIdentityProvider.COGNITO,
        ...social.map((name) => UserPoolClientIdentityProvider.custom(name)),
      ],
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      refreshTokenRotationGracePeriod: Duration.seconds(10),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      readAttributes: new ClientAttributes()
        .withStandardAttributes({
          email: true,
          emailVerified: true,
          phoneNumber: !!props.sms,
          phoneNumberVerified: !!props.sms,
        })
        .withCustomAttributes('artistId'),
      writeAttributes: new ClientAttributes().withStandardAttributes({
        email: true,
        // Text-message codes: people add and verify their own number.
        phoneNumber: !!props.sms,
      }),
    });
    // Passkeys belong to the address people sign in on: the app itself, not
    // Cognito's domain. The relying party is set with SetUserPoolMfaConfig
    // (the same MFA settings as the identity stack, plus the RP id), because
    // the app's address only exists once this distribution does. It is
    // re-applied on every deploy, after the identity stack's own update.
    const rpId = distribution.distributionDomainName;
    const mfaConfig = {
      service: 'CognitoIdentityServiceProvider',
      action: 'setUserPoolMfaConfig',
      parameters: {
        UserPoolId: props.userPool.userPoolId,
        MfaConfiguration: 'ON',
        SoftwareTokenMfaConfiguration: { Enabled: true },
        // Text-message codes, when on (kept in step with the identity stack).
        ...(props.sms
          ? {
              SmsMfaConfiguration: {
                SmsConfiguration: {
                  SnsCallerArn: props.sms.roleArn,
                  ExternalId: props.sms.externalId,
                },
              },
            }
          : {}),
        WebAuthnConfiguration: {
          RelyingPartyId: rpId,
          UserVerification: 'required',
          FactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
        },
      },
      physicalResourceId: PhysicalResourceId.of(`passkey-rp-${process.env.GITHUB_SHA ?? 'local'}`),
    };
    const passkeyRp = new AwsCustomResource(this, 'PasskeyRelyingParty', {
      functionName: `${p}-passkey-rp`,
      onCreate: mfaConfig,
      onUpdate: mfaConfig,
      installLatestAwsSdk: false,
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [props.userPool.userPoolArn] }),
    });
    // The handler is aws-cdk-lib's singleton; it can only call SetUserPoolMfaConfig on this pool.
    const passkeyRpHandler = this.node.tryFindChild('AWS679f53fac002430cb0da5b7982bd2287');
    if (passkeyRpHandler) {
      acknowledge(
        passkeyRpHandler,
        "aws-cdk-lib's AwsCustomResource handler: sets the passkey relying party on this environment's user pool.",
        'AwsSolutions-L1',
        'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      );
    }
    void passkeyRp;

    // CI builds apps/web before deploying (BMG_REQUIRE_WEB_BUILD=1); unit tests use a placeholder.
    const built = existsSync(resolve(WEB_DIST, 'index.html'));
    if (!built && process.env.BMG_REQUIRE_WEB_BUILD) {
      throw new Error('apps/web/dist is missing: run `npm run build -w @bmg/web` before deploying');
    }
    new BucketDeployment(this, 'DeploySite', {
      destinationBucket: site,
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
      sources: [
        built
          ? Source.asset(WEB_DIST, { exclude: ['config.json'] })
          : Source.data('index.html', '<!doctype html><title>BMG</title><p>Web app not built.</p>'),
        Source.jsonData('config.json', {
          clientId: client.userPoolClientId,
          region: this.region,
          userPoolId: props.userPool.userPoolId,
          apiBase: '/v1',
          // Social sign-in buttons (design D2) and text-message codes.
          loginDomain: loginHost,
          socialProviders: social,
          smsMfa: !!props.sms,
          realtime: { http: props.realtime.httpDns, ws: props.realtime.realtimeDns },
        }),
      ],
    });

    // CDK's own BucketDeployment Lambda (one per stack): its runtime, managed
    // policy and S3 wildcards come from aws-cdk-lib and only touch this site
    // bucket and the CDK assets bucket.
    const deployer = this.node.children.find((c) =>
      c.node.id.startsWith('Custom::CDKBucketDeployment'),
    );
    if (deployer) {
      const qualifier = cfg.environments[env].qualifier;
      acknowledge(
        deployer,
        "aws-cdk-lib's BucketDeployment handler: copies the built site into this bucket and invalidates CloudFront.",
        'AwsSolutions-L1',
        'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        'AwsSolutions-IAM5[Action::s3:Abort*]',
        'AwsSolutions-IAM5[Action::s3:DeleteObject*]',
        'AwsSolutions-IAM5[Action::s3:GetBucket*]',
        'AwsSolutions-IAM5[Action::s3:GetObject*]',
        'AwsSolutions-IAM5[Action::s3:List*]',
        'AwsSolutions-IAM5[Resource::*]',
        `AwsSolutions-IAM5[Resource::<${this.getLogicalId(site.node.defaultChild as never)}.Arn>/*]`,
        // The partition renders as a token or literally, depending on how the stack env is set.
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-${qualifier}-assets-${this.account}-${this.region}/*]`,
        `AwsSolutions-IAM5[Resource::arn:aws:s3:::cdk-${qualifier}-assets-${this.account}-${this.region}/*]`,
      );
    }

    new StringParameter(this, 'ClientId', {
      parameterName: names.ssm(cfg, env, 'web/client-id'),
      stringValue: client.userPoolClientId,
    });
    new StringParameter(this, 'Url', {
      parameterName: names.ssm(cfg, env, 'web/url'),
      stringValue: origin,
    });
    new CfnOutput(this, 'WebUrl', { value: origin });

    acknowledge(
      distribution,
      'The edge WAF (us-east-1) and geo rules arrive with the custom domain; the API behind /v1 already has a regional WAF. The default CloudFront certificate is used until DNS for blueprintmusic.group is on AWS.',
      'AwsSolutions-CFR1',
      'AwsSolutions-CFR2',
      'AwsSolutions-CFR4',
    );
  }
}
