import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BUMPS,
  CHANGELOG_FILE,
  addChangelogSection,
  bumpVersion,
  formatVersion,
  readVersionFile,
  releaseLabel,
  writeVersionFile,
  type Bump,
} from '@bmg/config/release';
import { readConfig } from '../lib/aws.ts';
import { planShip } from '../lib/plans.ts';
import {
  REPO_ROOT,
  executePlan,
  fail,
  heading,
  log,
  ok,
  run,
  warn,
  type GlobalOptions,
} from '../lib/runtime.ts';

/**
 * `blueprint release <major|minor|hotfix>`: bump the VERSION file and add an
 * empty CHANGELOG.md section to fill in (CI fails until it has a summary and
 * bullets). Commit both in the PR that starts the release; Deploy staging then
 * labels staging `beta-X.Y.Z`, and `blueprint release ship` sends it to
 * production as `X.Y.Z`.
 */
export async function release(bump: string, opts: GlobalOptions): Promise<void> {
  if (!(BUMPS as readonly string[]).includes(bump))
    throw new Error(`Unknown release type "${bump}". Use one of: ${BUMPS.join(', ')}`);
  const current = readVersionFile(REPO_ROOT);
  const next = bumpVersion(current, bump as Bump);
  heading(`Release ${bump}: ${formatVersion(current)} → ${formatVersion(next)}`);
  if (opts.dryRun) {
    warn('dry run: VERSION not changed');
    return;
  }
  writeVersionFile(REPO_ROOT, next);
  ok(`VERSION is now ${formatVersion(next)}`);
  const changelog = resolve(REPO_ROOT, CHANGELOG_FILE);
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    changelog,
    addChangelogSection(readFileSync(changelog, 'utf8'), formatVersion(next), today),
  );
  ok(`${CHANGELOG_FILE} has a new ${formatVersion(next)} section`);
  log(
    `  Next: write the summary and bullets in ${CHANGELOG_FILE} (shown in the app's "What's new"),\n` +
      `  commit VERSION and ${CHANGELOG_FILE} with the change, and merge to main.\n` +
      `  Staging will show ${releaseLabel(next, 'beta')}. Later PRs can add to the same release.\n` +
      `  When staging is ready, \`blueprint release ship\` sends it to production as ${releaseLabel(next, 'prod')}.`,
  );
}

/** `blueprint release show`: the current version and its labels. */
export async function releaseShow(): Promise<void> {
  const v = readVersionFile(REPO_ROOT);
  heading(`Release ${formatVersion(v)}`);
  ok(`staging (beta): ${releaseLabel(v, 'beta')}`);
  ok(`production:     ${releaseLabel(v, 'prod')}`);
}

async function git(args: string[]): Promise<string> {
  return (await run('git', args, { capture: true })).stdout.trim();
}

async function ghJson<T>(path: string, jq?: string): Promise<T> {
  const args = ['api', path, '-H', 'Accept: application/vnd.github+json'];
  if (jq) args.push('--jq', jq);
  const out = (await run('gh', args, { capture: true })).stdout.trim();
  return (out ? JSON.parse(out) : undefined) as T;
}

/**
 * The commit of the newest deployment to `environment` that succeeded. Any
 * `success` status counts: GitHub marks superseded deployments `inactive` later.
 */
async function lastSuccessfulDeploy(
  repo: string,
  environment: string,
): Promise<string | undefined> {
  const deployments = await ghJson<{ id: number; sha: string }[]>(
    `repos/${repo}/deployments?environment=${environment}&per_page=30`,
  );
  for (const d of deployments ?? []) {
    const succeeded = await ghJson<boolean>(
      `repos/${repo}/deployments/${d.id}/statuses?per_page=100`,
      'any(.[]; .state == "success")',
    );
    if (succeeded) return d.sha;
  }
  return undefined;
}

/**
 * `blueprint release ship [--sha <commit>]`: send what staging is running to
 * production. Tags the commit staging last deployed successfully as vX.Y.Z (from
 * VERSION at that commit) and pushes the tag, which starts the Release to
 * production workflow. Everything merged since the last release goes out together.
 */
export async function releaseShip(opts: GlobalOptions & { sha?: string }): Promise<void> {
  const cfg = readConfig();
  const repo = `${cfg.github.owner}/${cfg.github.repo}`;
  heading('Ship staging to production');

  await run('git', ['fetch', '--quiet', '--tags', 'origin', 'main'], { capture: true });
  const sha = opts.sha
    ? await git(['rev-parse', '--verify', `${opts.sha}^{commit}`])
    : await lastSuccessfulDeploy(repo, 'staging');
  if (!sha)
    throw new Error(
      'No successful staging deployment found. Merge to main and let Deploy staging finish.',
    );
  if (!opts.sha) ok(`staging is on ${sha.slice(0, 7)}`);

  const prodSha = await lastSuccessfulDeploy(repo, 'production');
  const onMain =
    (
      await run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
        allowFailure: true,
        capture: true,
      })
    ).code === 0;
  const changes =
    prodSha === sha
      ? []
      : prodSha
        ? ((await ghJson<string[]>(
            `repos/${repo}/compare/${prodSha}...${sha}`,
            '[.commits | reverse | .[].commit.message | split("\\n")[0]]',
          )) ?? [])
        : ['(first release through `blueprint release ship`)'];

  const plan = planShip({
    sha,
    versionAtSha: await git(['show', `${sha}:VERSION`]),
    existingTags: (await git(['tag', '--list', 'v*'])).split('\n').filter(Boolean),
    onMain,
    changes,
  });

  log(`  Release ${plan.version} (${plan.tag}) at ${sha.slice(0, 7)}`);
  log(
    `  Production is on ${prodSha ? prodSha.slice(0, 7) : 'no release yet'}. This release holds:`,
  );
  for (const c of changes) log(`    - ${c}`);
  if (plan.problems.length > 0) {
    for (const p of plan.problems) fail(p);
    process.exitCode = 1;
    return;
  }

  const signed =
    (
      await run('git', ['config', '--get', 'user.signingkey'], {
        capture: true,
        allowFailure: true,
      })
    ).stdout.trim() !== '';
  await executePlan(
    `Ship ${plan.tag} to production`,
    [
      {
        description: `Create ${signed ? 'signed ' : ''}tag ${plan.tag} on ${sha.slice(0, 7)}`,
        run: async () => {
          await run('git', [
            'tag',
            signed ? '-s' : '-a',
            plan.tag,
            sha,
            '-m',
            `Release ${plan.version}`,
          ]);
        },
      },
      {
        description: `Push ${plan.tag} (starts Release to production; approve it in GitHub)`,
        run: async () => {
          await run('git', ['push', 'origin', `refs/tags/${plan.tag}`]);
        },
      },
    ],
    opts,
  );
  if (!opts.dryRun) {
    log(
      `\n  Approve the deploy: https://github.com/${repo}/actions/workflows/release-prod.yml\n` +
        '  Staging keeps deploying every merge while you wait.',
    );
    if (!signed) warn('the tag is not signed (no user.signingkey in git config)');
  }
}
