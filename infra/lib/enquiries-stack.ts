import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  AccessLogFormat,
  AuthorizationType,
  EndpointType,
  IdentitySource,
  Integration,
  IntegrationType,
  LogGroupLogDestination,
  MethodLoggingLevel,
  RequestAuthorizer,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import type { IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { IEventBus } from 'aws-cdk-lib/aws-events';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { Function as LambdaFn } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { names, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';
import { directRateLimit, originVerifyValue } from './origin-verify.ts';

export interface EnquiriesStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly mainTable: ITable;
  readonly bus: IEventBus;
  readonly userPool: IUserPool;
  /** The API stack's token authorizer, so sign-in works the same on both APIs. */
  readonly authorizerFunctionArn: string;
}

/** The public form's path as the WAF sees it on the stage (with or without the stage name). */
export const PUBLIC_FORM_PATH_REGEX = '^/(v1/)?public/enquiries/?$';
/** The largest form a person can send (two 2,000-character answers, in any script). */
export const ENQUIRY_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Consultation requests (rev 21): the public form and the Blueprint team's
 * Enquiries pages, on their own small REST API because the main API stack is
 * at its resource guardrail.
 *
 * CloudFront sends `/v1/enquiries*` (signed in, the same token authorizer as
 * the main API) and `/public/enquiries` (no sign-in) here. The API's own
 * regional WAF puts an AWS WAF CAPTCHA in front of the public form: a send
 * without a solved puzzle never reaches Lambda. The CAPTCHA's API key for the
 * web page is made once per environment with `blueprint enquiries captcha-key`.
 */
export class EnquiriesStack extends BmgStack {
  readonly api: RestApi;
  readonly fn: BmgFunction;
  readonly waf: CfnWebACL;

  constructor(scope: Construct, id: string, props: EnquiriesStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;
    const main = props.mainTable.tableArn;

    // ── The function: public form and the team's routes ──
    this.fn = new BmgFunction(this, 'Enquiries', {
      entry: 'services/api/src/handlers/enquiries.ts',
      description: `BMG ${env}: consultation requests (public form and the team's Enquiries)`,
      prod,
      timeout: Duration.seconds(20),
      environment: {
        MAIN_TABLE: props.mainTable.tableName,
        EVENT_BUS: props.bus.eventBusName,
        PLATFORM_KEY_ARN: props.platformKey.keyArn,
        USER_POOL_ID: props.userPool.userPoolId,
        BMG_ENV: env,
        // The API stack's mail queue: the "we've got your request" email.
        MAIL_QUEUE_URL: `https://sqs.${this.region}.amazonaws.com/${this.account}/${p}-mail`,
      },
    });
    this.fn.addToRolePolicy(
      new PolicyStatement({
        sid: 'EnquiriesAndRateLimits',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:BatchGetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:Query',
        ],
        resources: [main],
      }),
    );
    this.fn.addToRolePolicy(
      new PolicyStatement({
        sid: 'TeamNames',
        actions: ['cognito-idp:ListUsersInGroup'],
        resources: [props.userPool.userPoolArn],
      }),
    );
    this.fn.addToRolePolicy(
      new PolicyStatement({
        sid: 'TellTheTeam',
        actions: ['events:PutEvents'],
        resources: [props.bus.eventBusArn],
      }),
    );
    this.fn.addToRolePolicy(
      new PolicyStatement({
        sid: 'Acknowledge',
        actions: ['sqs:SendMessage'],
        resources: [`arn:aws:sqs:${this.region}:${this.account}:${p}-mail`],
      }),
    );
    // Seals and opens personal details (data keys under the platform key), and
    // writes to the mail queue, which is encrypted with the same key.
    props.platformKey.grant(this.fn, 'kms:GenerateDataKey', 'kms:Decrypt');

    // ── REST API ──
    const accessLogs = new LogGroup(this, 'AccessLogs', {
      retention: prod ? RetentionDays.ONE_YEAR : RetentionDays.ONE_MONTH,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.api = new RestApi(this, 'Api', {
      restApiName: `${p}-enquiries`,
      description: `BMG ${env} consultation requests API`,
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      // The account's API Gateway CloudWatch role is the main API stack's.
      cloudWatchRole: false,
      deployOptions: {
        // The same stage name as the main API, so CloudFront passes /v1/enquiries as it is.
        stageName: 'v1',
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
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
    });
    const authorizerFn = LambdaFn.fromFunctionAttributes(this, 'AuthorizerFunction', {
      functionArn: props.authorizerFunctionArn,
      sameEnvironment: true,
    });
    const authorizer = new RequestAuthorizer(this, 'TokenAuthorizer', {
      handler: authorizerFn,
      identitySources: [IdentitySource.header('Authorization')],
      resultsCacheTtl: Duration.seconds(0),
    });
    const validator = this.api.addRequestValidator('Validate', {
      requestValidatorName: `${p}-enquiries-validate`,
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    this.fn.addPermission('ApiInvoke', {
      principal: new ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: this.api.arnForExecuteApi('*', '/*', '*'),
    });
    const integration = new Integration({
      type: IntegrationType.AWS_PROXY,
      integrationHttpMethod: 'POST',
      uri: `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/functions/${this.fn.functionArn}/invocations`,
    });

    const enquiries = this.api.root.addResource('enquiries');
    enquiries.addMethod('GET', integration, { authorizer, requestValidator: validator });
    enquiries
      .addResource('{proxy+}')
      .addMethod('ANY', integration, { authorizer, requestValidator: validator });
    // The public form: no sign-in. The WAF's CAPTCHA rule guards it.
    const publicForm = this.api.root
      .addResource('public')
      .addResource('enquiries')
      .addMethod('POST', integration, {
        authorizationType: AuthorizationType.NONE,
        requestValidator: validator,
      });
    acknowledge(
      publicForm,
      'The public consultation form needs no sign-in by design. A regional WAF CAPTCHA, rate limits, a honeypot and size limits protect it (rev 21).',
      'AwsSolutions-APIG4',
      'AwsSolutions-COG4',
    );
    acknowledge(
      this.api,
      'Access tokens are verified by the shared Lambda authorizer (aws-jwt-verify), as on the main API (design 6.2, 7.2).',
      'AwsSolutions-COG4',
    );

    // ── Regional AWS WAF, with the CAPTCHA on the public form ──
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName,
    });
    const publicFormRequest = {
      andStatement: {
        statements: [
          {
            byteMatchStatement: {
              fieldToMatch: { method: {} },
              positionalConstraint: 'EXACTLY',
              searchString: 'POST',
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          {
            regexMatchStatement: {
              fieldToMatch: { uriPath: {} },
              regexString: PUBLIC_FORM_PATH_REGEX,
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
        ],
      },
    };
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
      visibilityConfig: visibility(name),
    });
    this.waf = new CfnWebACL(this, 'Waf', {
      name: `${p}-enquiries`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`${p}-enquiries`),
      // Tokens from the CAPTCHA are issued for the app's own addresses; the
      // request reaches this API through CloudFront with another Host.
      tokenDomains: [...names.webHosts(cfg, env), cfg.domain.root],
      captchaConfig: { immunityTimeProperty: { immunityTime: 300 } },
      rules: [
        {
          // Direct calls only (security review M1); CloudFront's WAF limits visitors.
          name: 'RateLimitPerIp',
          priority: 0,
          action: { block: {} },
          statement: directRateLimit(500, originVerifyValue(cfg, env)),
          visibilityConfig: visibility('RateLimitPerIp'),
        },
        managed('AWSManagedRulesCommonRuleSet', 1, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
        managed('AWSManagedRulesAmazonIpReputationList', 3),
        {
          name: 'BodySizeLimit',
          priority: 4,
          action: { block: {} },
          statement: {
            sizeConstraintStatement: {
              fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
              comparisonOperator: 'GT',
              size: ENQUIRY_BODY_LIMIT_BYTES,
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          visibilityConfig: visibility('BodySizeLimit'),
        },
        {
          // A send without a solved puzzle (or with an expired token) is stopped here.
          name: 'PublicFormCaptcha',
          priority: 5,
          action: { captcha: {} },
          statement: publicFormRequest,
          visibilityConfig: visibility('PublicFormCaptcha'),
        },
      ],
    });
    new CfnWebACLAssociation(this, 'WafAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: this.waf.attrArn,
    });

    new StringParameter(this, 'WebAclName', {
      parameterName: names.ssm(cfg, env, 'enquiries/web-acl'),
      stringValue: `${this.waf.name}|${this.waf.attrId}`,
    });
    new CfnOutput(this, 'EnquiriesApiId', { value: this.api.restApiId });
    new CfnOutput(this, 'EnquiriesWebAclArn', { value: this.waf.attrArn });
  }
}
