import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const INFRA_DIR = resolve(REPO_ROOT, 'infra');

export interface GlobalOptions {
  yes?: boolean;
  dryRun?: boolean;
}

// ---- Logging (secrets redacted) ---------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /ASIA[0-9A-Z]{16}/g,
  // AWS secret keys (40 chars, not a plain hex git SHA)
  /(?<=["'=:\s]|^)(?=[A-Za-z0-9/+]*[g-zG-Z/+])[A-Za-z0-9/+]{40}(?=["'\s]|$)/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /(?<=(password|secret|token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '****'), text);
}

const LOG_FILE = resolve(REPO_ROOT, '.bmg', `cli-${new Date().toISOString().slice(0, 10)}.log`);

export function log(message: string): void {
  const line = `${new Date().toISOString()} ${redact(message)}`;
  console.log(redact(message));
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Logging must never break setup.
  }
}

export const ok = (msg: string) => log(`  ✔ ${msg}`);
export const warn = (msg: string) => log(`  ! ${msg}`);
export const fail = (msg: string) => log(`  ✘ ${msg}`);
export const heading = (msg: string) => log(`\n== ${msg}`);

// ---- Plans: show what will change, then confirm -----------------------------------

export interface PlanStep {
  description: string;
  run: () => Promise<void>;
}

export async function executePlan(
  title: string,
  steps: PlanStep[],
  opts: GlobalOptions,
): Promise<void> {
  heading(title);
  steps.forEach((s, i) => log(`  ${i + 1}. ${s.description}`));
  if (opts.dryRun) {
    log('\n(dry run: nothing was changed)');
    return;
  }
  if (!opts.yes) {
    const go = await confirm({ message: `Apply these ${steps.length} step(s)?`, default: false });
    if (!go) {
      log('Cancelled. Nothing was changed.');
      return;
    }
  }
  for (const [i, step] of steps.entries()) {
    log(`\n[${i + 1}/${steps.length}] ${step.description}`);
    await step.run();
  }
  log(`\nDone: ${title}`);
}

// ---- Child processes ---------------------------------------------------------------

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Capture stdout instead of streaming it. */
  capture?: boolean;
  /** Do not throw on non-zero exit. */
  allowFailure?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...process.env, ...opts.env },
      stdio: [
        opts.input !== undefined ? 'pipe' : 'inherit',
        opts.capture ? 'pipe' : 'inherit',
        'pipe',
      ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (!opts.capture) process.stderr.write(d);
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !opts.allowFailure) {
        reject(
          new Error(
            `${cmd} ${args.join(' ')} exited with ${result.code}\n${redact(stderr.trim())}`,
          ),
        );
      } else {
        resolvePromise(result);
      }
    });
  });
}

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const r = await run(cmd, ['--version'], { capture: true, allowFailure: true });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Run the CDK CLI from the infra workspace. */
export function cdk(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run('npx', ['--no-install', 'cdk', ...args], { cwd: INFRA_DIR, ...opts });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
