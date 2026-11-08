import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { names, parseConfig } from '@bmg/config';
import { buildApp } from '../lib/app.ts';

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

  it('uses Plus with threat protection in prod and Essentials in staging (D3)', () => {
    prod!.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTier: 'PLUS',
      UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
    });
    staging!.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTier: 'ESSENTIALS' });
  });

  it('has a public PKCE web client with short-lived tokens and rotation', () => {
    prod!.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AccessTokenValidity: 15,
      IdTokenValidity: 15,
      TokenValidityUnits: Match.objectLike({ AccessToken: 'minutes' }),
      EnableTokenRevocation: true,
      PreventUserExistenceErrors: 'ENABLED',
      RefreshTokenRotation: Match.objectLike({ Feature: 'ENABLED' }),
      CallbackURLs: [`https://app.${cfg.domain.root}/auth/callback`],
      WriteAttributes: ['email'],
    });
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

  it('only lets tagged sessions from the gate and API roles assume the data-access role', () => {
    prod!.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bmg-prod-data-access',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: ['sts:AssumeRole', 'sts:TagSession'],
            Condition: Match.objectLike({
              ArnLike: {
                'aws:PrincipalArn': [
                  `arn:aws:iam::${cfg.account.id}:role/bmg-prod-isolation-gate`,
                  `arn:aws:iam::${cfg.account.id}:role/bmg-prod-api-*`,
                ],
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
