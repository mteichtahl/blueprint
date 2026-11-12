import { idpRedirect, withProvider } from '../src/commands/social.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { names, parseConfig } from '@bmg/config';
import {
  deployArgs,
  envBootstrap,
  evaluateMailDns,
  githubProtectionRequests,
  normaliseAppPassword,
  nodeVersionOk,
  REQUIRED_CHECKS,
  secretId,
  smtpSecretPayload,
  toolingBootstrap,
  toolingRetainedResources,
  partitionAlarms,
  planShip,
} from '../src/lib/plans.ts';
import { redact } from '../src/lib/runtime.ts';

const cfg = parseConfig(
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../bmg.config.example.json'), 'utf8'),
  ),
);

describe('bootstrap plans', () => {
  it('bootstraps tooling in Sydney and us-east-1 without a boundary', () => {
    const b = toolingBootstrap(cfg);
    expect(b.args).toContain('aws://111111111111/ap-southeast-2');
    expect(b.args).toContain('aws://111111111111/us-east-1');
    expect(b.args).not.toContain('--custom-permissions-boundary');
    expect(b.args).toEqual(
      expect.arrayContaining(['--qualifier', 'bmgtool', '--tags', 'bmg:env=tooling']),
    );
  });

  it('bootstraps each environment with its own qualifier, tag and the boundary', () => {
    const prod = envBootstrap(cfg, 'prod');
    expect(prod.args).toEqual(
      expect.arrayContaining([
        '--qualifier',
        'bmgprd',
        '--tags',
        'bmg:env=prod',
        '--custom-permissions-boundary',
        'bmg-permission-boundary',
        '--toolkit-stack-name',
        'CDKToolkit-bmgprd',
      ]),
    );
    expect(envBootstrap(cfg, 'staging').args).toContain('bmg:env=staging');
  });
});

describe('deploy args', () => {
  it('passes skip flags as CDK context', () => {
    expect(deployArgs(['a'], { guardDuty: true, config: true })).toEqual([
      'deploy',
      'a',
      '--require-approval',
      'broadening',
      '-c',
      'bmg:skipGuardDuty=true',
      '-c',
      'bmg:skipConfig=true',
    ]);
  });
});

describe('github protection', () => {
  const reqs = githubProtectionRequests(cfg, [42]);
  const find = (p: string) => reqs.find((r) => r.path.endsWith(p));

  it('requires approval for all external contributors before workflows run', () => {
    expect(find('/fork-pr-contributor-approval')?.body).toEqual({
      approval_policy: 'all_external_contributors',
    });
  });

  it('protects main with the CI checks and blocks force pushes', () => {
    const body = find('/branches/main/protection')?.body as Record<string, unknown>;
    expect((body.required_status_checks as { contexts: string[] }).contexts).toEqual(
      REQUIRED_CHECKS,
    );
    expect(body.allow_force_pushes).toBe(false);
    expect(body.required_linear_history).toBe(true);
  });

  it('gates production on the configured reviewers', () => {
    expect(find('/environments/production')?.body).toMatchObject({
      reviewers: [{ type: 'User', id: 42 }],
    });
  });

  it('lets production deploy only from release tags, never from a branch', () => {
    expect(find('/environments/production')?.body).toMatchObject({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    const policy = find('/environments/production/deployment-branch-policies');
    expect(policy?.body).toEqual({ name: 'v*.*.*', type: 'tag' });
    expect(policy?.ensure).toMatchObject({ key: 'name', value: 'v*.*.*', updateExisting: false });
  });

  it('restricts release tags to repository admins, idempotently', () => {
    const ruleset = find('/rulesets');
    expect(ruleset?.body).toMatchObject({
      target: 'tag',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'] } },
      rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
    });
    expect(ruleset?.ensure).toMatchObject({ value: 'Release tags', updateExisting: true });
  });

  it('keeps staging on protected branches (main)', () => {
    expect(find('/environments/staging')?.body).toMatchObject({
      deployment_branch_policy: { protected_branches: true },
    });
  });

  it('makes the repo public (decision O6)', () => {
    expect(reqs[0]?.body).toMatchObject({ visibility: 'public' });
  });

  it('restricts actions and requires SHA pinning', () => {
    expect(find('/actions/permissions')?.body).toMatchObject({
      allowed_actions: 'selected',
      sha_pinning_required: true,
    });
  });
});

describe('gmail smtp', () => {
  it('builds the secret for STARTTLS on 587 as the configured sender', () => {
    expect(smtpSecretPayload(cfg, 'abcd efgh ijkl mnop')).toEqual({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      username: 'kyra@blueprintmusic.group',
      password: 'abcdefghijklmnop',
      from: '"Blueprint Music Group" <kyra@blueprintmusic.group>',
    });
  });
  it('uses implicit TLS on 465', () => {
    const c465 = { ...cfg, email: { ...cfg.email, smtpPort: 465 as const } };
    expect(smtpSecretPayload(c465, 'abcdefghijklmnop').secure).toBe(true);
  });
  it('rejects anything that is not a 16-letter app password', () => {
    expect(normaliseAppPassword('ABCD EFGH IJKL MNOP')).toBe('abcdefghijklmnop');
    expect(() => normaliseAppPassword('my-real-password1')).toThrow(/16 letters/);
  });
  it('evaluates mail DNS records', () => {
    expect(
      evaluateMailDns(
        ['v=spf1 include:_spf.google.com ~all'],
        ['v=DKIM1; k=rsa; p=abc'],
        ['v=DMARC1; p=quarantine'],
      ),
    ).toEqual({ spf: true, dkim: true, dmarc: true });
    expect(evaluateMailDns(['v=spf1 -all'], [], [])).toEqual({
      spf: false,
      dkim: false,
      dmarc: false,
    });
  });
  it('stores credentials under a per-environment secret id', () => {
    expect(names.smtpSecret(cfg, 'prod')).toBe('bmg/prod/gmail-smtp');
  });
});

describe('helpers', () => {
  it('checks the Node version', () => {
    expect(nodeVersionOk('v22.12.0')).toBe(true);
    expect(nodeVersionOk('v22.11.9')).toBe(false);
    expect(nodeVersionOk('v24.0.0')).toBe(true);
  });
  it('validates secret names', () => {
    expect(secretId(cfg, 'prod', 'mailchimp-api-key')).toBe('bmg/prod/mailchimp-api-key');
    expect(() => secretId(cfg, 'prod', 'Bad Name')).toThrow();
  });
  it('redacts credentials but not git SHAs', () => {
    // Fake credentials are assembled at runtime so secret scanners don't flag the test.
    const fakeAwsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const fakeGithubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    expect(redact(`key ${fakeAwsKey} x`)).toBe('key **** x');
    expect(redact(`token: ${fakeGithubToken}`)).not.toContain('ghp_');
    expect(redact('password=hunter2')).toBe('password=****');
    expect(redact('commit d23441a48e516b6c34aea4fa41551a30e30af803')).toContain('d23441a4');
  });
});

describe('stack status', () => {
  it('treats any *_IN_PROGRESS status as busy', async () => {
    const { isBusy } = await import('../src/lib/stacks.ts');
    expect(isBusy('UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS')).toBe(true);
    expect(isBusy('UPDATE_IN_PROGRESS')).toBe(true);
    expect(isBusy('UPDATE_ROLLBACK_COMPLETE')).toBe(false);
    expect(isBusy(undefined)).toBe(false);
    // A change set that failed early validation leaves this forever; never wait on it.
    expect(isBusy('REVIEW_IN_PROGRESS')).toBe(false);
  });
});

describe('existing security services', () => {
  it('skips services that exist outside our stack, but never ones our stack owns', async () => {
    const { externalServices } = await import('../src/lib/plans.ts');
    const existing = {
      guardDuty: ['det-external'],
      securityHub: ['arn:hub'],
      config: [],
      accessAnalyzer: ['arn:analyzer/ours'],
    };
    const owned = new Set(['arn:hub', 'arn:analyzer/ours']);
    expect(externalServices(existing, owned)).toEqual({
      guardDuty: true,
      securityHub: false,
      config: false,
      accessAnalyzer: false,
    });
  });

  it('ignores failed and deleted stack resources when deciding ownership', async () => {
    const { isLiveResourceStatus } = await import('../src/lib/plans.ts');
    expect(isLiveResourceStatus('CREATE_COMPLETE')).toBe(true);
    expect(isLiveResourceStatus('UPDATE_COMPLETE')).toBe(true);
    expect(isLiveResourceStatus('CREATE_FAILED')).toBe(false);
    expect(isLiveResourceStatus('DELETE_COMPLETE')).toBe(false);
    expect(isLiveResourceStatus(undefined)).toBe(false);
  });
});

describe('toolingRetainedResources', () => {
  it('names exactly the retained resources the tooling stack creates', () => {
    expect(toolingRetainedResources(cfg)).toEqual({
      repository: `${cfg.project}-agent`,
      logGroups: ['ci', 'deploy-staging', 'deploy-prod'].map(
        (k) => `/aws/codebuild/${names.runnerProject(cfg, k as 'ci')}`,
      ),
    });
  });
});

describe('isAbandonedCreate', () => {
  it('treats failed and never-executed first creates as removable', async () => {
    const { isAbandonedCreate } = await import('../src/lib/stacks.ts');
    for (const st of ['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED', 'REVIEW_IN_PROGRESS']) {
      expect(isAbandonedCreate(st)).toBe(true);
    }
    for (const st of [
      'CREATE_COMPLETE',
      'UPDATE_ROLLBACK_COMPLETE',
      'UPDATE_COMPLETE',
      undefined,
    ]) {
      expect(isAbandonedCreate(st)).toBe(false);
    }
  });
});

describe('partitionAlarms', () => {
  it('only counts alarms named for this project', () => {
    const { ours, others } = partitionAlarms(
      [
        { name: 'bmg-prod-api-5xx' },
        { name: 'TargetTracking-table/test-AlarmLow-3c0d' },
        { name: 'bmgx-other' },
      ],
      'bmg',
    );
    expect(ours.map((a) => a.name)).toEqual(['bmg-prod-api-5xx']);
    expect(others).toHaveLength(2);
  });
});

describe('release ship', () => {
  const base = {
    sha: 'abc1234def5678',
    versionAtSha: '1.5.0\n',
    existingTags: ['v1.4.0'],
    onMain: true,
    changes: ['Gigs: venue map (#130)', 'Chat: read receipts (#128)'],
  };

  it('tags the staged commit with its VERSION', () => {
    expect(planShip(base)).toEqual({ tag: 'v1.5.0', version: '1.5.0', problems: [] });
  });

  it('refuses a version that was already released', () => {
    const plan = planShip({ ...base, versionAtSha: '1.4.0' });
    expect(plan.problems.join()).toMatch(/v1\.4\.0 has already been released/);
  });

  it('refuses a commit that is not on main', () => {
    expect(planShip({ ...base, onMain: false }).problems.join()).toMatch(/not on main/);
  });

  it('refuses an empty release', () => {
    expect(planShip({ ...base, changes: [] }).problems.join()).toMatch(/nothing to release/);
  });

  it('refuses a version production already runs, even without a tag', () => {
    const plan = planShip({
      ...base,
      versionAtSha: '1.5.1',
      existingTags: [],
      productionVersion: '1.5.1\n',
    });
    expect(plan.problems.join()).toMatch(/production is already on 1\.5\.1/);
  });

  it('allows a version newer than production', () => {
    expect(planShip({ ...base, productionVersion: '1.4.0' }).problems).toEqual([]);
  });

  it('refuses a malformed VERSION', () => {
    expect(planShip({ ...base, versionAtSha: '1.5' }).problems).toHaveLength(1);
  });
});

describe('social sign-in setup', () => {
  it('turns a provider on in bmg.config.json once, keeping the rest', () => {
    const raw = JSON.stringify({
      $schemaVersion: 1,
      environments: { staging: { subdomain: 'staging' }, prod: { socialProviders: ['Google'] } },
    });
    const once = withProvider(raw, 'prod', 'Apple');
    expect(JSON.parse(once).environments.prod.socialProviders).toEqual(['Google', 'Apple']);
    expect(
      JSON.parse(withProvider(once, 'prod', 'Apple')).environments.prod.socialProviders,
    ).toEqual(['Google', 'Apple']);
    expect(JSON.parse(once).environments.staging).toEqual({ subdomain: 'staging' });
    expect(once.endsWith('\n')).toBe(true);
  });

  it('gives providers Cognito’s own redirect address', () => {
    expect(idpRedirect('bmg-prod.auth.ap-southeast-2.amazoncognito.com')).toBe(
      'https://bmg-prod.auth.ap-southeast-2.amazoncognito.com/oauth2/idpresponse',
    );
  });
});
