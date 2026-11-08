import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@bmg/config';
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
    const [staging, prod] = stacks.environments;
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
