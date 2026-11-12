#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { accountSetup } from './commands/account.ts';
import { aiOptOut, aiStatus } from './commands/ai.ts';
import { adminCreate } from './commands/admin.ts';
import { bootstrap } from './commands/bootstrap.ts';
import { doctor } from './commands/doctor.ts';
import { e2eSetup } from './commands/e2e.ts';
import { connectorsSetup, connectorsStatus } from './commands/connectors.ts';
import { emailSetup } from './commands/email.ts';
import { githubConnect, githubProtect } from './commands/github.ts';
import { init } from './commands/init.ts';
import { pipelineDeploy } from './commands/pipeline.ts';
import { release, releaseShip, releaseShow } from './commands/release.ts';
import { secretsSet } from './commands/secrets.ts';
import { stacksRepair } from './commands/stacks.ts';
import { status } from './commands/status.ts';
import { verifyIsolation } from './commands/verify.ts';
import { fail, type GlobalOptions } from './lib/runtime.ts';

const program = new Command()
  .name('blueprint')
  .description(
    'One-time setup for the BMG platform. First run, in order:\n' +
      '  init → doctor → bootstrap → account setup → github connect → github protect\n' +
      '  → pipeline deploy → (push to main; wait for Deploy staging; release ship) → secrets set → email setup → admin create → ai opt-out',
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

const email = program.command('email').description('app email through Gmail SMTP');
email
  .command('setup')
  .description('store and verify the Gmail app password for the sender (no Google Cloud)')
  .option('--env <env>', 'staging or prod', 'prod')
  .option('--test-to <address>', 'send a test email after verifying the login')
  .action(wrap((o: { env: string; testTo?: string }) => emailSetup({ ...g(), ...o })));

const connectorsCmd = program
  .command('connectors')
  .description('OAuth apps for the connectors (Google, Meta, Mailchimp, TikTok, LinkedIn)');
connectorsCmd
  .command('setup <provider>')
  .description("store a connector app's client id and secret, and print its redirect URI")
  .option('--env <env>', 'staging or prod', 'prod')
  .action(
    wrap((provider: string, o: { env: string }) => connectorsSetup({ ...g(), ...o, provider })),
  );
connectorsCmd
  .command('status')
  .description('show which connector apps are registered')
  .option('--env <env>', 'staging or prod', 'prod')
  .action(wrap((o: { env: string }) => connectorsStatus({ ...g(), ...o })));

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
  .command('e2e')
  .description('end-to-end tests (docs/e2e.md)')
  .command('setup')
  .description('create or repair the E2E test accounts on staging and store them for the pipeline')
  .option('--email <email>', 'inbox the accounts are plus-addresses of (you@example.com)')
  .option('--env <env>', 'staging only', 'staging')
  .action(wrap((o: { email?: string; env: string }) => e2eSetup({ ...g(), ...o })));

program
  .command('stacks')
  .description('stack maintenance')
  .command('repair')
  .description('remove BMG stacks whose first create failed, so the next deploy can run')
  .action(wrap(() => stacksRepair(g())));

const ai = program.command('ai').description('AWS AI services');
ai.command('opt-out')
  .description(
    'opt the account out of AWS using its content to improve AI services (needed for meeting transcripts)',
  )
  .action(wrap(() => aiOptOut(g())));
ai.command('status')
  .description('show whether meeting transcription is allowed to run (read-only)')
  .action(wrap(() => aiStatus()));

const verify = program.command('verify').description('live security checks');
verify
  .command('isolation')
  .description('prove KMS refuses cross-artist and private-item access (Phase 2 gate)')
  .option('--env <env>', 'only staging has the gate', 'staging')
  .action(wrap((o: { env: 'staging' }) => verifyIsolation(o)));

program
  .command('status')
  .description('stacks, runners, versions and alarms (read-only)')
  .action(wrap(() => status()));

const releaseCmd = program
  .command('release')
  .description('semantic release versions (VERSION file): staging shows beta-X.Y.Z');
releaseCmd
  .command('major')
  .description('breaking or large release: X+1.0.0')
  .action(wrap(() => release('major', g())));
releaseCmd
  .command('minor')
  .description('new features: X.Y+1.0')
  .action(wrap(() => release('minor', g())));
releaseCmd
  .command('hotfix')
  .description('fixes only: X.Y.Z+1')
  .action(wrap(() => release('hotfix', g())));
releaseCmd
  .command('ship')
  .description(
    'send what staging is running to production: tags it vX.Y.Z and starts Release to production',
  )
  .option('--sha <commit>', 'release this commit instead of the one staging is running')
  .action(wrap((o: { sha?: string }) => releaseShip({ ...g(), ...o })));
releaseCmd
  .command('show')
  .description('print the current version and its staging/production labels')
  .action(wrap(() => releaseShow()));

await program.parseAsync(process.argv);
