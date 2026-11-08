import { parse } from 'yaml';

/**
 * Workflow policy for the BMG repo (design sections 16.2 and 16.4):
 *  1. Every job runs on a CodeBuild-hosted runner (`codebuild-bmg-...` label).
 *     Nothing may run on a GitHub-hosted runner.
 *  2. No `pull_request_target` trigger (public repo: it would run fork code with
 *     repository permissions).
 *  3. Every third-party action is pinned to a full 40-character commit SHA.
 *  4. Workflows declare `permissions` explicitly (least privilege token).
 *  5. Production deploys only from the `bmg-deploy-prod` project and only from
 *     jobs bound to the `production` environment.
 */

export interface Violation {
  file: string;
  job?: string;
  rule: string;
  message: string;
}

export const RUNNER_PREFIX = 'codebuild-bmg-';
const ALLOWED_PROJECTS = ['ci', 'deploy-staging', 'deploy-prod'] as const;
/** codebuild-<project>-${{ github.run_id }}-${{ github.run_attempt }}[-overrides] */
const RUNNER_LABEL =
  /^codebuild-bmg-(ci|deploy-staging|deploy-prod)-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}(-[a-z0-9:.-]+)*$/;
const SHA_PINNED = /^[^@\s]+@[0-9a-f]{40}$/;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function triggerNames(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  const rec = asRecord(on);
  return rec ? Object.keys(rec) : [];
}

function environmentName(env: unknown): string | undefined {
  if (typeof env === 'string') return env;
  const rec = asRecord(env);
  return rec && typeof rec.name === 'string' ? rec.name : undefined;
}

export function checkWorkflow(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  const add = (rule: string, message: string, job?: string) =>
    violations.push({ file, rule, message, ...(job ? { job } : {}) });

  let doc: Json | undefined;
  try {
    doc = asRecord(parse(source));
  } catch (err) {
    add('parse', `invalid YAML: ${(err as Error).message}`);
    return violations;
  }
  if (!doc) {
    add('parse', 'workflow is empty or not a mapping');
    return violations;
  }

  if (triggerNames(doc.on).includes('pull_request_target')) {
    add('no-pull-request-target', 'pull_request_target is not allowed in a public repo');
  }
  if (doc.permissions === undefined) {
    add('explicit-permissions', 'set top-level `permissions:` explicitly (least privilege)');
  }

  const jobs = asRecord(doc.jobs);
  if (!jobs || Object.keys(jobs).length === 0) {
    add('jobs', 'workflow has no jobs');
    return violations;
  }

  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = asRecord(rawJob);
    if (!job) continue;

    if (typeof job.uses === 'string') {
      // Reusable workflow call: only local workflows, which are checked themselves.
      if (!job.uses.startsWith('./.github/workflows/')) {
        add('reusable-local-only', `job calls external reusable workflow ${job.uses}`, jobId);
      }
      continue;
    }

    const runsOn = job['runs-on'];
    if (typeof runsOn !== 'string') {
      add('codebuild-runner', 'runs-on must be a single CodeBuild runner label string', jobId);
    } else if (!RUNNER_LABEL.test(runsOn.trim())) {
      add(
        'codebuild-runner',
        `runs-on "${runsOn}" is not a CodeBuild runner label (${RUNNER_PREFIX}{${ALLOWED_PROJECTS.join('|')}}-\${{ github.run_id }}-\${{ github.run_attempt }})`,
        jobId,
      );
    } else {
      const project = RUNNER_LABEL.exec(runsOn.trim())?.[1];
      const env = environmentName(job.environment);
      if (project === 'deploy-prod' && env !== 'production') {
        add('prod-environment', 'deploy-prod jobs must use `environment: production`', jobId);
      }
      if (env === 'production' && project !== 'deploy-prod') {
        add('prod-environment', 'the production environment may only run on deploy-prod', jobId);
      }
      if (project === 'deploy-staging' && env !== 'staging') {
        add('staging-environment', 'deploy-staging jobs must use `environment: staging`', jobId);
      }
    }

    if (job.container !== undefined || job.services !== undefined) {
      add('no-containers', 'job containers/services are not used on CodeBuild runners', jobId);
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const rawStep of steps) {
      const step = asRecord(rawStep);
      if (!step || typeof step.uses !== 'string') continue;
      const uses = step.uses.trim();
      if (uses.startsWith('./') || uses.startsWith('docker://')) {
        if (uses.startsWith('docker://')) {
          add('no-docker-actions', `docker action ${uses} is not allowed`, jobId);
        }
        continue;
      }
      if (!SHA_PINNED.test(uses)) {
        add('sha-pinned', `action ${uses} must be pinned to a full commit SHA`, jobId);
      }
    }
  }

  return violations;
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `${v.file}${v.job ? ` [job ${v.job}]` : ''}: ${v.rule}: ${v.message}`)
    .join('\n');
}
