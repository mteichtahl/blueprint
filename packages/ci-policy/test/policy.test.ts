import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWorkflow } from '../src/policy.ts';

const SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const label = (p: string) => `codebuild-bmg-${p}-\${{ github.run_id }}-\${{ github.run_attempt }}`;

function wf(body: string): string {
  return `name: t\non: [pull_request]\npermissions:\n  contents: read\n${body}`;
}

describe('workflow policy', () => {
  it('accepts a CodeBuild job with pinned actions', () => {
    const src = wf(
      `jobs:\n  a:\n    runs-on: ${label('ci')}\n    steps:\n      - uses: actions/checkout@${SHA}\n      - run: npm ci\n`,
    );
    expect(checkWorkflow('ok.yml', src)).toEqual([]);
  });

  it('accepts CodeBuild override suffixes', () => {
    const src = wf(
      `jobs:\n  a:\n    runs-on: ${label('ci')}-instance-size:large\n    steps:\n      - run: echo hi\n`,
    );
    expect(checkWorkflow('ok.yml', src)).toEqual([]);
  });

  it.each(['ubuntu-latest', 'macos-14', 'self-hosted', 'codebuild-other-${{ github.run_id }}-1'])(
    'rejects runs-on %s',
    (runsOn) => {
      const src = wf(`jobs:\n  a:\n    runs-on: ${runsOn}\n    steps:\n      - run: echo hi\n`);
      expect(checkWorkflow('bad.yml', src).map((v) => v.rule)).toContain('codebuild-runner');
    },
  );

  it('rejects array runs-on (could fall back to a GitHub runner)', () => {
    const src = wf(`jobs:\n  a:\n    runs-on: [ubuntu-latest]\n    steps:\n      - run: echo\n`);
    expect(checkWorkflow('bad.yml', src).map((v) => v.rule)).toContain('codebuild-runner');
  });

  it('rejects pull_request_target', () => {
    const src = `on:\n  pull_request_target:\npermissions: {}\njobs:\n  a:\n    runs-on: ${label('ci')}\n    steps:\n      - run: echo\n`;
    expect(checkWorkflow('bad.yml', src).map((v) => v.rule)).toContain('no-pull-request-target');
  });

  it('rejects tag-pinned actions', () => {
    const src = wf(
      `jobs:\n  a:\n    runs-on: ${label('ci')}\n    steps:\n      - uses: actions/checkout@v5\n`,
    );
    expect(checkWorkflow('bad.yml', src).map((v) => v.rule)).toContain('sha-pinned');
  });

  it('requires explicit permissions', () => {
    const src = `on: [push]\njobs:\n  a:\n    runs-on: ${label('ci')}\n    steps:\n      - run: echo\n`;
    expect(checkWorkflow('bad.yml', src).map((v) => v.rule)).toContain('explicit-permissions');
  });

  it('binds prod deploys to the production environment and project', () => {
    const noEnv = wf(
      `jobs:\n  d:\n    runs-on: ${label('deploy-prod')}\n    steps:\n      - run: echo\n`,
    );
    expect(checkWorkflow('bad.yml', noEnv).map((v) => v.rule)).toContain('prod-environment');
    const wrongRunner = wf(
      `jobs:\n  d:\n    runs-on: ${label('ci')}\n    environment: production\n    steps:\n      - run: echo\n`,
    );
    expect(checkWorkflow('bad.yml', wrongRunner).map((v) => v.rule)).toContain('prod-environment');
  });

  describe('production starts only from release tags', () => {
    const prodJob = `jobs:\n  d:\n    runs-on: ${label('deploy-prod')}\n    environment: production\n    steps:\n      - run: echo\n`;
    const withOn = (on: string) =>
      `name: t\non:\n${on}\npermissions:\n  contents: read\n${prodJob}`;

    it.each([
      ['tag push', `  push:\n    tags: ['v*.*.*']`],
      ['tag push or by hand', `  push:\n    tags: ['v*.*.*']\n  workflow_dispatch:`],
      ['by hand only', `  workflow_dispatch:`],
    ])('accepts %s', (_name, on) => {
      expect(checkWorkflow('ok.yml', withOn(on))).toEqual([]);
    });

    it.each([
      ['push to main', `  push:\n    branches: [main]`],
      ['branches and tags', `  push:\n    branches: [main]\n    tags: ['v*']`],
      ['any push', `  push:`],
      ['pull requests', `  pull_request:\n  workflow_dispatch:`],
      ['a schedule', `  schedule:\n    - cron: '0 0 * * *'`],
    ])('rejects %s', (_name, on) => {
      expect(checkWorkflow('bad.yml', withOn(on)).map((v) => v.rule)).toContain(
        'prod-release-tags',
      );
    });

    it('leaves workflows without a production job alone', () => {
      const src = `name: t\non:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  s:\n    runs-on: ${label('deploy-staging')}\n    environment: staging\n    steps:\n      - run: echo\n`;
      expect(checkWorkflow('ok.yml', src)).toEqual([]);
    });
  });

  it("passes on the repo's own workflows", () => {
    const dir = resolve(import.meta.dirname, '../../../.github/workflows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(checkWorkflow(f, readFileSync(join(dir, f), 'utf8'))).toEqual([]);
    }
  });
});
