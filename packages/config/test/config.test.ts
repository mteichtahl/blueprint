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
    expect(names.host(cfg, 'prod', 'api')).toBe(`api.${cfg.domain.root}`);
    expect(names.host(cfg, 'staging', 'auth')).toBe(`auth.staging.${cfg.domain.root}`);
  });
  it('gives the web app an artist and an admin address, -beta in staging', () => {
    const plain = parseConfig({
      ...example,
      environments: {
        staging: { ...example.environments.staging, hosts: undefined },
        prod: { ...example.environments.prod, hosts: undefined },
      },
    });
    expect(names.webHosts(plain, 'prod')).toEqual([
      `artist.${cfg.domain.root}`,
      `admin.${cfg.domain.root}`,
    ]);
    expect(names.webHost(plain, 'staging', 'admin')).toBe(`admin-beta.${cfg.domain.root}`);
  });
  it('takes the hosts and certificate from the config', () => {
    const custom = parseConfig({
      ...example,
      environments: {
        ...example.environments,
        staging: {
          ...example.environments.staging,
          hosts: { artist: 'try', admin: 'team-try' },
          certificateArn:
            'arn:aws:acm:us-east-1:123456789012:certificate/0a1b2c3d-1111-2222-3333-444455556666',
        },
      },
    });
    expect(names.webHost(custom, 'staging', 'artist')).toBe(`try.${cfg.domain.root}`);
    expect(names.customDomains(custom, 'staging')).toBe(true);
    expect(names.customDomains(custom, 'prod')).toBe(false);
  });
  it('only takes certificates from us-east-1', () => {
    expect(() =>
      parseConfig({
        ...example,
        environments: {
          ...example.environments,
          prod: {
            ...example.environments.prod,
            certificateArn:
              'arn:aws:acm:ap-southeast-2:123456789012:certificate/0a1b2c3d-1111-2222-3333-444455556666',
          },
        },
      }),
    ).toThrow();
  });
  it('names tables per environment', () => {
    expect(names.table(cfg, 'staging', 'consent')).toBe('bmg-staging-consent');
  });
  it('makes a globally unique Cognito domain prefix', () => {
    expect(names.cognitoDomainPrefix(cfg, 'prod')).toBe(`bmg-prod-${cfg.account.id}`);
  });
});
