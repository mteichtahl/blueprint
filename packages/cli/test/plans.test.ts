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
    expect(redact('key AKIAABCDEFGHIJKLMNOP x')).toBe('key **** x');
    expect(redact('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789')).not.toContain('ghp_');
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
  });
});
