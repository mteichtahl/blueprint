#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { accountSetup } from './commands/account.ts';
import { adminCreate } from './commands/admin.ts';
import { bootstrap } from './commands/bootstrap.ts';
import { doctor } from './commands/doctor.ts';
import { githubConnect, githubProtect } from './commands/github.ts';
import { googleSetup } from './commands/google.ts';
import { init } from './commands/init.ts';
import { pipelineDeploy } from './commands/pipeline.ts';
import { secretsSet } from './commands/secrets.ts';
import { status } from './commands/status.ts';
import { fail, type GlobalOptions } from './lib/runtime.ts';

const program = new Command()
  .name('bmg')
  .description(
    'One-time setup for the BMG platform. First run, in order:\n' +
      '  init → doctor → bootstrap → account setup → github connect → github protect\n' +
      '  → secrets set → google setup → pipeline deploy → (push to main) → admin create',
  )
  .option('-y, --yes', 'apply without asking for confirmation')
  .option('--dry-run', 'show what would change, change nothing');

const g = (): GlobalOptions => program.opts<GlobalOptions>();
const wrap =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      fail((err as Error).message);
      process.exitCode = 1;
    }
  };

program
  .command('init')
  .description('write bmg.config.json (non-secret settings)')
  .action(wrap(() => init(g())));
program
  .command('doctor')
  .description('check prerequisites (read-only)')
  .action(wrap(() => doctor()));
program
  .command('bootstrap')
  .description('CDK bootstrap: tooling, then staging and prod once the boundary exists')
  .action(wrap(() => bootstrap(g())));

const account = program.command('account').description('account-level guardrails');
account
  .command('setup')
  .description('S3 public block, password policy, EBS encryption, guardrail stacks, env bootstraps')
  .option('--users <names>', 'create IAM admin users, comma separated (e.g. marc,kyra)')
  .action(wrap((o: { users?: string }) => accountSetup({ ...g(), ...o })));

const github = program.command('github').description('GitHub integration');
github
  .command('connect')
  .description('create the CodeConnections link (one console approval)')
  .action(wrap(() => githubConnect(g())));
github
  .command('protect')
  .description(
    'make the repo public and lock it down (branch protection, fork approvals, environments)',
  )
  .action(wrap(() => githubProtect(g())));

const secrets = program.command('secrets').description('Secrets Manager');
secrets
  .command('set <name>')
  .description('store a secret as bmg/<env>/<name> (value is never printed)')
  .option('--env <env>', 'staging or prod', 'prod')
  .option('--from-file <path>', 'read the value from a file instead of a prompt')
  .action(
    wrap((name: string, o: { env: string; fromFile?: string }) =>
      secretsSet(name, { ...g(), ...o }),
    ),
  );

const google = program.command('google').description('Google Workspace email');
google
  .command('setup')
  .description('keyless Gmail send-only setup (Workload Identity Federation)')
  .action(wrap(() => googleSetup(g())));

const pipeline = program.command('pipeline').description('CI/CD');
pipeline
  .command('deploy')
  .description('deploy the CodeBuild runner projects')
  .action(wrap(() => pipelineDeploy(g())));

const admin = program.command('admin').description('app administrators');
admin
  .command('create')
  .description('invite the first bmg-admin user (after Phase 2)')
  .option('--email <email>', 'admin email address')
  .option('--env <env>', 'staging or prod', 'prod')
  .action(wrap((o: { email?: string; env: 'staging' | 'prod' }) => adminCreate({ ...g(), ...o })));

program
  .command('status')
  .description('stacks, runners, versions and alarms (read-only)')
  .action(wrap(() => status()));

await program.parseAsync(process.argv);
