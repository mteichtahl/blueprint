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
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  CfnManagedLoginBranding,
  ClientAttributes,
  OAuthScope,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  type IUserPool,
} from 'aws-cdk-lib/aws-cognito';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { REPO_ROOT } from './function.ts';

export interface WebStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly userPool: IUserPool;
  readonly loginDomain: string;
  /** API Gateway REST API id; its `v1` stage is served under /v1/* on the same origin. */
  readonly restApiId: string;
  /** The quarantine bucket the browser uploads to (presigned POST). */
  readonly uploadOrigin: string;
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

    const loginOrigin = `https://${props.loginDomain}`;
    const cognitoIdp = `https://cognito-idp.${this.region}.amazonaws.com`;
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
            "img-src 'self' data:",
            `connect-src 'self' ${cognitoIdp} ${loginOrigin} ${props.uploadOrigin}`,
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self' " + loginOrigin,
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
    });

    const apiDomain = `${props.restApiId}.execute-api.${this.region}.amazonaws.com`;
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
        // Settings change per deploy; never cache them.
        '/config.json': {
          origin: S3BucketOrigin.withOriginAccessControl(site),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: headers,
        },
      },
      // Single-page app: unknown paths (e.g. /auth/callback) load index.html.
      errorResponses: [403, 404].map((status) => ({
        httpStatus: status,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });
    const origin = `https://${distribution.distributionDomainName}`;

    const devOrigins = prod ? [] : ['http://localhost:5173'];
    const client = new UserPoolClient(this, 'WebClient', {
      userPool: props.userPool,
      userPoolClientName: `${p}-web-app`,
      generateSecret: false,
      authFlows: { user: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [origin, ...devOrigins].map((o) => `${o}/auth/callback`),
        logoutUrls: [origin, ...devOrigins].map((o) => `${o}/signed-out`),
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      refreshTokenRotationGracePeriod: Duration.seconds(10),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      readAttributes: new ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes('artistId'),
      writeAttributes: new ClientAttributes().withStandardAttributes({ email: true }),
    });
    new CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: props.userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });

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
          loginDomain: props.loginDomain,
          clientId: client.userPoolClientId,
          region: this.region,
          userPoolId: props.userPool.userPoolId,
          apiBase: '/v1',
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
