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

  it("passes on the repo's own workflows", () => {
    const dir = resolve(import.meta.dirname, '../../../.github/workflows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(checkWorkflow(f, readFileSync(join(dir, f), 'utf8'))).toEqual([]);
    }
  });
});
