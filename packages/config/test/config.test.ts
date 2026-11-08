import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { names, parseConfig } from '../src/index.ts';

const example = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../bmg.config.example.json'), 'utf8'),
);

describe('bmg config', () => {
  it('accepts the example config', () => {
    const cfg = parseConfig(example);
    expect(cfg.account.homeRegion).toBe('ap-southeast-2');
    expect(cfg.environments.prod.qualifier).toBe('bmgprd');
  });

  it('rejects a bad account id with a readable message', () => {
    expect(() => parseConfig({ ...example, account: { id: '123' } })).toThrow(/account\.id/);
  });

  it('requires at least one allowed GitHub actor (public repo protection)', () => {
    const bad = structuredClone(example);
    bad.github.allowedActorIds = [];
    expect(() => parseConfig(bad)).toThrow(/allowedActorIds/);
  });

  it('only allows us-east-1 as the edge region', () => {
    const bad = structuredClone(example);
    bad.account.edgeRegion = 'ap-southeast-2';
    expect(() => parseConfig(bad)).toThrow(/edgeRegion/);
  });

  it('builds consistent names', () => {
    const cfg = parseConfig(example);
    expect(names.cdkRole('bmgprd', 'deploy', cfg)).toBe(
      'cdk-bmgprd-deploy-role-111111111111-ap-southeast-2',
    );
    expect(names.runnerProject(cfg, 'deploy-prod')).toBe('bmg-deploy-prod');
  });
});

describe('names', () => {
  const cfg = parseConfig(example);
  it('puts staging hosts under the staging subdomain and prod at the root', () => {
    expect(names.host(cfg, 'prod', 'app')).toBe(`app.${cfg.domain.root}`);
    expect(names.host(cfg, 'staging', 'auth')).toBe(`auth.staging.${cfg.domain.root}`);
  });
  it('names tables per environment', () => {
    expect(names.table(cfg, 'staging', 'consent')).toBe('bmg-staging-consent');
  });
  it('makes a globally unique Cognito domain prefix', () => {
    expect(names.cognitoDomainPrefix(cfg, 'prod')).toBe(`bmg-prod-${cfg.account.id}`);
  });
});
