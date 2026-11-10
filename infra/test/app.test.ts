import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { names, parseConfig } from '@bmg/config';
import { buildApp } from '../lib/app.ts';
import { REPO_ROOT } from '../lib/function.ts';

const cfg = parseConfig(
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../bmg.config.example.json'), 'utf8')),
);

function synth() {
  const app = new App();
  const stacks = buildApp(app, cfg, { version: 'test' });
  app.synth();
  return stacks;
}

const stacks = synth();
describe('cdk-nag (AwsSolutions)', () => {
  it('synthesizes with no unacknowledged violations', () => {
    expect(() => {
      const app = new App();
      buildApp(app, cfg, { version: 'test' });
      app.synth();
    }).not.toThrow();
  });
});

describe('account guardrails', () => {
  const t = Template.fromStack(stacks.guardrails);

  it('creates the named permission boundary with the key guardrails', () => {
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'bmg-permission-boundary',
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'DenyOutsideAllowedRegions', Effect: 'Deny' }),
          Match.objectLike({ Sid: 'DenyIamUsersAndKeys', Effect: 'Deny' }),
          Match.objectLike({ Sid: 'DenyCrossEnvironmentAccess', Effect: 'Deny' }),
          Match.objectLike({ Sid: 'DenyProdDeployRolesExceptProdPipeline', Effect: 'Deny' }),
        ]),
      },
    });
  });

  it('restricts regions to Sydney, us-east-1 (edge) and Melbourne (backups)', () => {
    const policies = t.findResources('AWS::IAM::ManagedPolicy');
    const doc = JSON.stringify(Object.values(policies));
    expect(doc).toContain('ap-southeast-2');
    expect(doc).toContain('us-east-1');
    expect(doc).toContain('ap-southeast-4');
  });

  it('has a multi-region validated trail into an Object Lock bucket', () => {
    t.hasResourceProperties('AWS::CloudTrail::Trail', {
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
      IncludeGlobalServiceEvents: true,
    });
    t.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: Match.objectLike({ ObjectLockEnabled: 'Enabled' }),
    });
  });

  it('enables GuardDuty, Security Hub standards and Config', () => {
    t.resourceCountIs('AWS::GuardDuty::Detector', 1);
    t.resourceCountIs('AWS::SecurityHub::Standard', 2);
    t.resourceCountIs('AWS::Config::ConfigurationRecorder', 1);
  });

  it('only lets humans assume admin roles with MFA', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bmg-admin',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: Match.objectLike({ Bool: { 'aws:MultiFactorAuthPresent': 'true' } }),
          }),
        ],
      },
    });
  });

  it('can skip services that already exist in the account', () => {
    const app = new App();
    const s = buildApp(app, cfg, {
      skip: { guardDuty: true, securityHub: true, config: true, accessAnalyzer: true },
    });
    const tt = Template.fromStack(s.guardrails);
    tt.resourceCountIs('AWS::GuardDuty::Detector', 0);
    tt.resourceCountIs('AWS::SecurityHub::Hub', 0);
    tt.resourceCountIs('AWS::Config::ConfigurationRecorder', 0);
    tt.resourceCountIs('AWS::AccessAnalyzer::Analyzer', 0);
  });
});

describe('global stack', () => {
  const t = Template.fromStack(stacks.global);
  it('is in us-east-1 with a budget at the configured limit', () => {
    expect(stacks.global.region).toBe('us-east-1');
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 400, Unit: 'USD' } }),
    });
  });
  it('lets CloudFormation name the budget (no clash with leftovers)', () => {
    const budgets = t.findResources('AWS::Budgets::Budget');
    for (const b of Object.values(budgets)) {
      expect(b.Properties.Budget.BudgetName).toBeUndefined();
    }
  });
  it('alarms on root sign-in', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ detail: { userIdentity: { type: ['Root'] } } }),
    });
  });
});

describe('tooling (CodeBuild runners)', () => {
  const t = Template.fromStack(stacks.tooling!);

  it('creates three runner projects triggered only by queued workflow jobs from allowed actors', () => {
    t.resourceCountIs('AWS::CodeBuild::Project', 3);
    for (const name of ['bmg-ci', 'bmg-deploy-staging', 'bmg-deploy-prod']) {
      t.hasResourceProperties('AWS::CodeBuild::Project', {
        Name: name,
        Triggers: {
          Webhook: true,
          FilterGroups: [
            [
              { Type: 'EVENT', Pattern: 'WORKFLOW_JOB_QUEUED' },
              { Type: 'ACTOR_ACCOUNT_ID', Pattern: '^(1000001|49699333)$' },
            ],
          ],
        },
      });
    }
  });

  it('attaches the permission boundary to every runner role', () => {
    const roles = t.findResources('AWS::IAM::Role');
    expect(Object.keys(roles)).toHaveLength(3);
    for (const role of Object.values(roles)) {
      expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(
        'bmg-permission-boundary',
      );
    }
  });

  it('only lets the prod runner assume prod bootstrap roles', () => {
    const roles = t.findResources('AWS::IAM::Policy');
    const byRole = Object.values(roles).map((p) => JSON.stringify(p.Properties));
    const prodPolicies = byRole.filter((p) => p.includes('cdk-bmgprd-deploy-role'));
    expect(prodPolicies).toHaveLength(1);
    expect(prodPolicies[0]).toContain('DeployProdRole');
  });

  it('gives runner roles the connection permissions CodeBuild checks at project creation', () => {
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    for (const action of [
      'codeconnections:GetConnection',
      'codeconnections:GetConnectionToken',
      'codeconnections:UseConnection',
    ]) {
      expect(policies).toContain(action);
    }
  });

  it('names its retained resources the way the CLI cleanup expects', () => {
    t.hasResourceProperties('AWS::ECR::Repository', { RepositoryName: names.agentRepository(cfg) });
    for (const kind of ['ci', 'deploy-staging', 'deploy-prod'] as const) {
      t.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: names.runnerLogGroup(cfg, kind),
      });
    }
  });

  it('tags runner roles with their deploy target for the boundary', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bmg-deploy-prod-runner',
      Tags: Match.arrayWith([{ Key: 'bmg:deploy-target', Value: 'prod' }]),
    });
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bmg-ci-runner',
      Tags: Match.arrayWith([{ Key: 'bmg:deploy-target', Value: 'none' }]),
    });
  });
});

describe('environment foundations', () => {
  it('uses a separate bootstrap qualifier per environment and tags resources', () => {
    const [staging, prod] = stacks.environments.map((e) => e.foundation);
    expect(JSON.stringify(Template.fromStack(staging!).toJSON())).toContain(
      '/cdk-bootstrap/bmgstg/version',
    );
    expect(JSON.stringify(Template.fromStack(prod!).toJSON())).toContain(
      '/cdk-bootstrap/bmgprd/version',
    );
    Template.fromStack(prod!).hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      Tags: Match.arrayWith([{ Key: 'bmg:env', Value: 'prod' }]),
    });
  });
});

describe('environment data (DynamoDB)', () => {
  const [staging, prod] = stacks.environments.map((e) => Template.fromStack(e.data));

  it('creates the four tables with KMS encryption and point-in-time recovery', () => {
    for (const t of [staging!, prod!]) {
      t.resourceCountIs('AWS::DynamoDB::Table', 4);
      t.allResourcesProperties('AWS::DynamoDB::Table', {
        SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: 'KMS' }),
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    }
  });

  it('protects prod tables from deletion', () => {
    prod!.allResourcesProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
  });

  it('never grants update or delete on the consent ledger', () => {
    for (const e of stacks.environments) {
      for (const stack of [e.foundation, e.data, e.identity]) {
        const json = JSON.stringify(Template.fromStack(stack).toJSON());
        expect(json).not.toMatch(/consent[^"]*"[^}]*dynamodb:(UpdateItem|DeleteItem)/);
      }
    }
  });
});

describe('environment identity (Cognito)', () => {
  const [staging, prod] = stacks.environments.map((e) => Template.fromStack(e.identity));

  it('is invite-only with required MFA and passkeys that count as two factors', () => {
    for (const t of [staging!, prod!]) {
      t.hasResourceProperties('AWS::Cognito::UserPool', {
        AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
        MfaConfiguration: 'ON',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        WebAuthnFactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
        WebAuthnUserVerification: 'required',
        Policies: Match.objectLike({
          PasswordPolicy: Match.objectLike({ MinimumLength: 12 }),
          SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] },
        }),
      });
    }
  });

  it("leaves the passkey relying party to Cognito (the login domain doesn't exist at pool creation)", () => {
    for (const t of [staging!, prod!]) {
      const pool = Object.values(t.findResources('AWS::Cognito::UserPool'))[0]!;
      expect(pool.Properties.WebAuthnRelyingPartyID).toBeUndefined();
    }
  });

  it('uses Plus with threat protection in prod and Essentials in staging (D3)', () => {
    prod!.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'PLUS',
      UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
    });
    staging!.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTier: 'ESSENTIALS' });
  });

  it('leaves the web client to the web stack', () => {
    prod!.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
  });

  it('creates the three groups and wires pre token generation V2', () => {
    prod!.resourceCountIs('AWS::Cognito::UserPoolGroup', 3);
    prod!.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: Match.objectLike({
        PreTokenGenerationConfig: Match.objectLike({ LambdaVersion: 'V2_0' }),
      }),
    });
  });

  it('puts the permission boundary on every trigger role', () => {
    const roles = prod!.findResources('AWS::IAM::Role');
    expect(Object.keys(roles).length).toBeGreaterThanOrEqual(3);
    for (const role of Object.values(roles)) {
      expect(role.Properties.PermissionsBoundary).toBeDefined();
    }
  });
});

describe('environment keys (per-artist KMS)', () => {
  const [staging, prod] = stacks.environments.map((e) => Template.fromStack(e.keys));

  it('only lets tagged sessions from the named data roles assume the data-access role', () => {
    prod!.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bmg-prod-data-access',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: ['sts:AssumeRole', 'sts:TagSession'],
            Condition: Match.objectLike({
              ArnEquals: {
                'aws:PrincipalArn': Match.arrayWith([
                  `arn:aws:iam::${cfg.account.id}:role/bmg-prod-api-files`,
                ]),
              },
              Null: { 'aws:RequestTag/artistId': 'false', 'aws:RequestTag/role': 'false' },
              'ForAllValues:StringEquals': { 'aws:TagKeys': ['artistId', 'role'] },
            }),
          }),
        ],
      },
    });
  });

  it('limits data-access KMS use to the key and context of the tagged artist', () => {
    prod!.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'UseOnlyTheTaggedArtistsKey',
            Condition: {
              StringEquals: {
                'aws:ResourceTag/artistId': '${aws:PrincipalTag/artistId}',
                'kms:EncryptionContext:artistId': '${aws:PrincipalTag/artistId}',
              },
            },
          }),
        ]),
      },
    });
  });

  it('only creates keys tagged for its own environment', () => {
    staging!.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'CreateArtistKeysForThisEnvironment',
            Condition: Match.objectLike({ StringEquals: { 'aws:RequestTag/bmg:env': 'staging' } }),
          }),
        ]),
      },
    });
  });

  it('runs the isolation gate on every staging deploy, and not in prod', () => {
    staging!.resourceCountIs('Custom::BmgIsolationGate', 1);
    staging!.hasResource('Custom::BmgIsolationGate', {
      Properties: Match.objectLike({ version: 'test' }),
    });
    prod!.resourceCountIs('Custom::BmgIsolationGate', 0);
  });

  it('logs and traces the onboarding workflow', () => {
    prod!.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'bmg-prod-artist-onboarding',
      TracingConfiguration: { Enabled: true },
      LoggingConfiguration: Match.objectLike({ Level: 'ALL', IncludeExecutionData: false }),
    });
  });
});

describe('environment audit trail', () => {
  const [staging, prod] = stacks.environments.map((e) => Template.fromStack(e.audit));

  it('archives audit events in an Object Lock bucket', () => {
    prod!.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: Match.objectLike({
        Rule: { DefaultRetention: Match.objectLike({ Mode: cfg.audit.objectLockMode }) },
      }),
    });
    prod!.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { source: ['bmg.audit'] },
      Targets: [Match.objectLike({ DeadLetterConfig: Match.anyValue() })],
    });
  });

  it('lets the writer add objects but never read or delete them', () => {
    const json = JSON.stringify(staging!.toJSON());
    expect(json).toContain('WriteAuditObjectsOnly');
    expect(json).not.toMatch(
      /"s3:(DeleteObject|GetObject|PutObjectRetention|BypassGovernanceRetention)/,
    );
  });
});

describe('environment files', () => {
  const [staging] = stacks.environments.map((e) => Template.fromStack(e.files));

  it('lets the app read artist and library images (GET only) in the browser', () => {
    for (const bucket of ['artist-data', 'org-data'] as const) {
      staging!.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: names.bucket(cfg, 'staging', bucket),
        CorsConfiguration: {
          CorsRules: [Match.objectLike({ AllowedMethods: ['GET', 'HEAD'] })],
        },
      });
    }
  });

  it('keeps uploads in a 7-day quarantine under its own key, open to browser POSTs only', () => {
    staging!.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: names.bucket(cfg, 'staging', 'quarantine'),
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 7 })] },
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ['POST'] })] },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ],
      },
    });
  });

  it('scans the quarantine bucket with GuardDuty and tags the result', () => {
    staging!.hasResourceProperties('AWS::GuardDuty::MalwareProtectionPlan', {
      Actions: { Tagging: { Status: 'ENABLED' } },
      ProtectedResource: { S3Bucket: { BucketName: Match.anyValue() } },
    });
    staging!.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.guardduty'],
        'detail-type': ['GuardDuty Malware Protection Object Scan Result'],
      }),
    });
  });

  it('only lets data-access sessions touch artist objects, always with SSE-KMS', () => {
    const json = JSON.stringify(staging!.toJSON());
    expect(json).toContain('ArtistObjectsOnlyThroughDataAccessSessions');
    expect(json).toContain('ArtistObjectsUseKms');
    expect(json).toContain('artists/${aws:PrincipalTag/artistId}/*');
    staging!.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: names.bucket(cfg, 'staging', 'artist-data'),
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [Match.objectLike({ BucketKeyEnabled: false })],
      },
    });
  });

  it('lets only the scanner and the promoter read unscanned uploads', () => {
    expect(JSON.stringify(staging!.toJSON())).toContain('OnlyScannerAndPromoterRead');
  });
});

describe('environment API', () => {
  const [staging, prod] = stacks.environments.map((e) => Template.fromStack(e.api));

  it('protects every route with the token authorizer', () => {
    const methods = prod!.findResources('AWS::ApiGateway::Method');
    const routed = Object.values(methods).filter((m) => m.Properties.HttpMethod !== 'OPTIONS');
    expect(routed.length).toBe(115);
    for (const m of routed) expect(m.Properties.AuthorizationType).toBe('CUSTOM');
  });

  it('lets Scheduler assume the reminder role from the reminder schedule group (WP0)', () => {
    const roles = Object.values(prod!.findResources('AWS::IAM::Role')).filter((r) =>
      r.Properties.AssumeRolePolicyDocument.Statement.some(
        (st: { Principal?: { Service?: string } }) =>
          st.Principal?.Service === 'scheduler.amazonaws.com',
      ),
    );
    expect(roles).toHaveLength(1);
    const cond = roles[0]!.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
    expect(cond.ArnEquals['aws:SourceArn']).toMatch(/:schedule-group\/bmg-prod-reminders$/);
    expect(JSON.stringify(cond)).not.toContain(':schedule/');
  });

  it('limits realtime subscribers to their own inbox channel and publishing to IAM', () => {
    const ns = Object.values(prod!.findResources('AWS::AppSync::ChannelNamespace'))[0]!;
    expect(ns.Properties.CodeHandlers).toContain('util.unauthorized()');
    expect(ns.Properties.PublishAuthModes).toEqual([{ AuthType: 'AWS_IAM' }]);
    expect(ns.Properties.SubscribeAuthModes).toEqual([{ AuthType: 'AMAZON_COGNITO_USER_POOLS' }]);
  });

  it('puts a regional WAF with rate limiting in front', () => {
    prod!.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'RateLimitPerIp', Action: { Block: {} } }),
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
      ]),
    });
    prod!.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('lets venue logo saves past the 8 KB WAF body limit, and only those', () => {
    prod!.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesCommonRuleSet',
          Statement: {
            ManagedRuleGroupStatement: Match.objectLike({
              RuleActionOverrides: [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }],
            }),
          },
        }),
        Match.objectLike({
          Name: 'BodySizeLimit',
          Action: { Block: {} },
        }),
      ]),
    });
    const acl = Object.values(prod!.findResources('AWS::WAFv2::WebACL'))[0]!;
    const rule = acl.Properties.Rules.find((r: { Name: string }) => r.Name === 'BodySizeLimit');
    const [size, exempt] = rule.Statement.AndStatement.Statements;
    expect(size.SizeConstraintStatement).toMatchObject({ ComparisonOperator: 'GT', Size: 8192 });
    const regex = new RegExp(
      exempt.NotStatement.Statement.AndStatement.Statements[1].RegexMatchStatement.RegexString,
    );
    expect(regex.test('/v1/venues/abc123/logo')).toBe(true);
    expect(regex.test('/v1/venues/abc123')).toBe(false);
    expect(regex.test('/v1/venues/logo-lookup')).toBe(false);
  });

  it('names API roles so the data-access role can trust them', () => {
    const names = Object.values(prod!.findResources('AWS::IAM::Role'))
      .map((r) => r.Properties.RoleName)
      .filter(Boolean);
    expect(names).toEqual(
      expect.arrayContaining(['bmg-prod-api-authorizer', 'bmg-prod-api-artists']),
    );
  });

  it('keeps the consent ledger append-only', () => {
    const json = JSON.stringify(prod!.toJSON());
    expect(json).toContain('AppendConsent');
    const policies = Object.values(prod!.findResources('AWS::IAM::Policy'));
    for (const policy of policies) {
      for (const st of policy.Properties.PolicyDocument.Statement as Array<{
        Sid?: string;
        Action: string | string[];
      }>) {
        if (st.Sid === 'AppendConsent') {
          expect(st.Action).toEqual(['dynamodb:PutItem', 'dynamodb:Query']);
        }
      }
    }
  });

  it('owns the account-level API Gateway logging role in staging only', () => {
    staging!.resourceCountIs('AWS::ApiGateway::Account', 1);
    prod!.resourceCountIs('AWS::ApiGateway::Account', 0);
  });
});

describe('environment web app', () => {
  const [staging, prod] = stacks.environments.map((e) => Template.fromStack(e.web));

  it('routes app paths at the edge without rewriting API errors', () => {
    prod!.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionCode: Match.stringLikeRegexp('/index.html'),
    });
    const dist = Object.values(prod!.findResources('AWS::CloudFront::Distribution'))[0]!;
    expect(dist.Properties.DistributionConfig.CustomErrorResponses).toBeUndefined();
  });

  it('serves the site privately through CloudFront with the API on the same origin', () => {
    prod!.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/v1/*', ViewerProtocolPolicy: 'https-only' }),
        ]),
      }),
    });
    prod!.hasResourceProperties('AWS::CloudFront::OriginAccessControl', Match.anyValue());
  });

  it('sends a strict content security policy', () => {
    const policy = Object.values(prod!.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0]!;
    const csp: string =
      policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy
        .ContentSecurityPolicy;
    expect(JSON.stringify(csp)).toContain("frame-ancestors 'none'");
    expect(JSON.stringify(csp)).not.toContain('unsafe-inline');
    // Only Google Maps may be framed (venue details), nothing else.
    expect(JSON.stringify(csp)).toMatch(/frame-src https:\/\/www\.google\.com;/);
  });

  it('owns the web client: our own sign-in, with no hosted UI', () => {
    for (const t of [staging!, prod!]) {
      const client = Object.values(t.findResources('AWS::Cognito::UserPoolClient'))[0]!.Properties;
      // No OAuth flows, callbacks or managed login: Cognito's hosted pages can't sign anyone in.
      expect(client.AllowedOAuthFlows).toBeUndefined();
      expect(client.CallbackURLs).toBeUndefined();
      // Refresh tokens rotate, so refreshing uses GetTokensFromRefreshToken, not a flow.
      expect(client.ExplicitAuthFlows).toEqual(['ALLOW_USER_AUTH']);
      t.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 0);
    }
    prod!.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AccessTokenValidity: 15,
      IdTokenValidity: 15,
      EnableTokenRevocation: true,
      PreventUserExistenceErrors: 'ENABLED',
      RefreshTokenRotation: Match.objectLike({ Feature: 'ENABLED' }),
      WriteAttributes: ['email'],
    });
  });

  it('binds passkeys to the app address and keeps MFA required', () => {
    const json = JSON.stringify(prod!.toJSON());
    expect(json).toContain('setUserPoolMfaConfig');
    expect(json).toContain('MULTI_FACTOR_WITH_USER_VERIFICATION');
    expect(json).toContain('\\"MfaConfiguration\\":\\"ON\\"');
  });

  it('only lets the page talk to the Cognito API for sign-in', () => {
    const csp = JSON.stringify(prod!.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(csp).not.toContain('amazoncognito.com');
    expect(csp).toContain("form-action 'self';");
  });
});

describe('environment notifications and branded email', () => {
  const [staging, prod] = stacks.environments.map((e) => Template.fromStack(e.notify));

  it('sends to-do events to the notifier with retries and a dead-letter queue', () => {
    for (const t of [staging!, prod!]) {
      // Submission events go only to the API stack's notifier, so nobody is emailed twice.
      t.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['bmg.workspace'],
          'detail-type': ['todo.updated', 'todo.reminder'],
        },
        Targets: [
          Match.objectLike({
            RetryPolicy: { MaximumRetryAttempts: 8, MaximumEventAgeInSeconds: 21600 },
            DeadLetterConfig: Match.anyValue(),
          }),
        ],
      });
      t.resourceCountIs('AWS::SQS::Queue', 1);
    }
  });

  it('only reads the SMTP secret of its own environment', () => {
    const json = JSON.stringify(prod!.toJSON());
    expect(json).toContain(`secret:${names.smtpSecret(cfg, 'prod')}-*`);
    expect(json).not.toContain(names.smtpSecret(cfg, 'staging'));
  });

  it('brands every Cognito email with a custom message trigger', () => {
    for (const e of stacks.environments) {
      Template.fromStack(e.identity).hasResourceProperties('AWS::Cognito::UserPool', {
        LambdaConfig: Match.objectLike({ CustomMessage: Match.anyValue() }),
      });
    }
  });
});

describe('environment assistant (AI stack)', () => {
  const [staging] = stacks.environments.map((e) => Template.fromStack(e.ai));

  it('runs the agent as code on Node 22, callable only with IAM (the API)', () => {
    staging!.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeArtifact: { CodeConfiguration: Match.objectLike({ Runtime: 'NODE_22' }) },
      EnvironmentVariables: Match.objectLike({ MODEL_ID: Match.stringLikeRegexp('^au\\.') }),
    });
    const runtime = Object.values(staging!.findResources('AWS::BedrockAgentCore::Runtime'))[0] as {
      Properties: Record<string, unknown>;
    };
    expect(runtime.Properties.AuthorizerConfiguration).toBeUndefined();
  });

  it('lets the agent apply its guardrail in every Australian destination Region', () => {
    const json = JSON.stringify(staging!.toJSON());
    for (const region of ['ap-southeast-2', 'ap-southeast-4']) {
      expect(json).toContain(`:bedrock:${region}:`);
      expect(json).toMatch(
        new RegExp(`bedrock:${region}:[^"]*:guardrail-profile/au\\.guardrail\\.v1:0`),
      );
    }
  });

  it('gives AgentCore a .js entry point, marked as an ES module', () => {
    // NODE_22 rejects any other extension ("Entrypoint file type does not match").
    staging!.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeArtifact: {
        CodeConfiguration: Match.objectLike({ EntryPoint: ['server.js'] }),
      },
    });
    const dir = join(REPO_ROOT, 'infra', '.agent-build', 'staging');
    expect(existsSync(join(dir, 'server.js'))).toBe(true);
    expect(existsSync(join(dir, 'server.mjs'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).type).toBe('module');
  });

  it('guards against prompt attacks through the Sydney-only guardrail profile', () => {
    staging!.hasResourceProperties('AWS::Bedrock::Guardrail', {
      CrossRegionConfig: {
        GuardrailProfileArn: Match.stringLikeRegexp('guardrail-profile/au\\.guardrail\\.v1:0$'),
      },
      ContentPolicyConfig: Match.objectLike({
        FiltersConfig: Match.arrayWith([
          Match.objectLike({ Type: 'PROMPT_ATTACK', InputStrength: 'HIGH' }),
        ]),
      }),
    });
  });

  it('signs action tokens with an HMAC key', () => {
    staging!.hasResourceProperties('AWS::KMS::Key', {
      KeySpec: 'HMAC_256',
      KeyUsage: 'GENERATE_VERIFY_MAC',
    });
  });
});

describe('environment knowledge bases (KB stack)', () => {
  const [staging] = stacks.environments.map((e) => Template.fromStack(e.kb));

  it('keeps vectors in a bucket under its own key', () => {
    staging!.hasResourceProperties('AWS::S3Vectors::VectorBucket', {
      VectorBucketName: 'bmg-staging-vectors',
      EncryptionConfiguration: Match.objectLike({ SseType: 'aws:kms' }),
    });
  });

  it('lets a retrieval session query only the knowledge base tagged like it', () => {
    staging!.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'RetrieveFromTheTaggedOwnersKnowledgeBase',
            Action: 'bedrock:Retrieve',
            Condition: {
              StringEquals: {
                'aws:ResourceTag/artistId': '${aws:PrincipalTag/artistId}',
                'aws:ResourceTag/bmg:env': 'staging',
              },
            },
          }),
        ]),
      },
    });
  });

  it('reconciles knowledge bases with consent every hour', () => {
    staging!.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 hour)' });
    staging!.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'bmg-staging-ai-consent-drift',
    });
  });
});

describe('environment newsroom', () => {
  const [staging] = stacks.environments.map((e) => Template.fromStack(e.newsroom));

  it('drafts the newsletter on Sunday at 6 am Melbourne time', () => {
    staging!.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 6 ? * SUN *)',
      ScheduleExpressionTimezone: 'Australia/Melbourne',
    });
  });
});

describe('connectors', () => {
  const prod = Template.fromStack(stacks.environments[1]!.api);

  it('syncs every hour with a role the data-access role trusts', () => {
    prod.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 hour)',
    });
    prod.hasResourceProperties('AWS::IAM::Role', { RoleName: 'bmg-prod-api-connectors-sync' });
    prod.hasResourceProperties('AWS::IAM::Role', { RoleName: 'bmg-prod-api-connectors' });
  });

  it('keeps the API stacks well under the 500-resource limit', () => {
    for (const env of stacks.environments) {
      const count = Object.keys(Template.fromStack(env.api).toJSON().Resources).length;
      // CloudFormation's hard limit is 500. Rev 7 (contacts, venues, to-do
      // threads, plan PDF) takes it into the 430s; past 460, split routes into
      // a second stack rather than raising this again.
      expect(count).toBeLessThan(460);
    }
    // One invoke permission per function, not two per route.
    const perms = Object.keys(prod.findResources('AWS::Lambda::Permission')).length;
    expect(perms).toBeLessThan(40);
  });

  it('reads only the connector app secrets', () => {
    const policies = Object.values(prod.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Sid?: string; Resource: unknown }[],
    );
    const apps = statements.filter((s) => s.Sid === 'ReadConnectorApps');
    expect(apps).toHaveLength(2);
    expect(JSON.stringify(apps[0]!.Resource)).toContain(':secret:bmg/prod/connectors/*');
  });
});

describe('Phase 6 policy review', () => {
  const policiesOf = (t: Template) =>
    Object.values(t.findResources('AWS::IAM::Policy')) as {
      Properties: { PolicyDocument: { Statement: Record<string, unknown>[] }; Roles: unknown[] };
    }[];
  const roleNames = (t: Template) =>
    Object.fromEntries(
      Object.entries(t.findResources('AWS::IAM::Role')).map(([id, r]) => [
        id,
        r.Properties.RoleName,
      ]),
    );

  it.each(['staging', 'prod'] as const)(
    'lets exactly the roles that open artist data assume data-access (%s, finding I1)',
    (envName) => {
      const env = stacks.environments[envName === 'staging' ? 0 : 1]!;
      const p = `bmg-${envName}`;
      const callers = new Set<string>();
      for (const stack of Object.values(env)) {
        const t = Template.fromStack(stack);
        const names = roleNames(t);
        for (const pol of policiesOf(t)) {
          const assumes = pol.Properties.PolicyDocument.Statement.some(
            (st) =>
              JSON.stringify(st.Action).includes('sts:AssumeRole') &&
              /role\/bmg-\w+-data-access|"DataAccess[0-9A-F]+"/.test(JSON.stringify(st.Resource)),
          );
          if (!assumes) continue;
          for (const r of pol.Properties.Roles) {
            callers.add(String(names[(r as { Ref: string }).Ref]));
          }
        }
      }
      const role = Object.values(
        Template.fromStack(env.keys).findResources('AWS::IAM::Role', {
          Properties: { RoleName: `${p}-data-access` },
        }),
      )[0]!;
      const trusted = role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.ArnEquals[
        'aws:PrincipalArn'
      ].map((a: string) => a.split(':role/')[1]);
      expect(new Set(trusted)).toEqual(callers);
      expect(trusted.join()).not.toContain('*');
    },
  );

  it('refreshes existing artist key policies on every environment (finding K1)', () => {
    for (const env of stacks.environments) {
      Template.fromStack(env.keys).resourceCountIs('Custom::BmgKeyPolicyRefresh', 1);
    }
  });
});

describe('Phase 6 web headers', () => {
  it('sends Permissions-Policy and COOP from CloudFront (finding W2)', () => {
    const web = Template.fromStack(stacks.environments[1]!.web);
    web.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            Match.objectLike({ Header: 'Permissions-Policy' }),
            Match.objectLike({ Header: 'Cross-Origin-Opener-Policy', Value: 'same-origin' }),
          ]),
        },
      }),
    });
  });
});
