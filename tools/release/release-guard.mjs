#!/usr/bin/env node
// Release guard for the Release to production workflow (docs/releases.md).
//
// Runs before the production approval. A release tag may go to production only if:
//   1. it is a vX.Y.Z tag that matches the VERSION file at that commit,
//   2. the commit is on main (main contains it), and
//   3. that exact commit deployed to staging successfully (GitHub deployment
//      status `success` on the `staging` environment, written by Deploy staging).
//
// It also writes the list of changes since the last successful production
// deployment to the job summary, so the approver can see what the release holds.
//
// Env: GITHUB_TOKEN (contents: read, deployments: read), GITHUB_REPOSITORY,
// GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_SHA, GITHUB_STEP_SUMMARY (optional).

import { appendFileSync, readFileSync } from 'node:fs';
import { URLSearchParams } from 'node:url';

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  GITHUB_REF_TYPE,
  GITHUB_REF_NAME,
  GITHUB_SHA,
  GITHUB_STEP_SUMMARY,
} = process.env;
const API = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function summary(markdown) {
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function gh(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) fail(`GitHub API ${path} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * The newest deployment to `environment` that succeeded (optionally for one sha).
 * Any `success` status counts: GitHub later marks superseded deployments
 * `inactive`, and staging moves on while a release waits.
 */
async function lastSuccessfulDeployment(environment, sha) {
  const query = new URLSearchParams({ environment, per_page: '30' });
  if (sha) query.set('sha', sha);
  const deployments = await gh(`/deployments?${query}`);
  for (const d of deployments) {
    const statuses = await gh(`/deployments/${d.id}/statuses?per_page=100`);
    if (statuses.some((st) => st.state === 'success')) return d;
  }
  return undefined;
}

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_SHA) fail('missing GitHub environment');

// 1. A vX.Y.Z tag that matches VERSION.
if (GITHUB_REF_TYPE !== 'tag') fail('production deploys only from a release tag (vX.Y.Z)');
if (!/^v\d+\.\d+\.\d+$/.test(GITHUB_REF_NAME ?? ''))
  fail(`"${GITHUB_REF_NAME}" is not a release tag (vX.Y.Z)`);
const version = readFileSync('VERSION', 'utf8').trim();
if (GITHUB_REF_NAME !== `v${version}`)
  fail(`tag ${GITHUB_REF_NAME} does not match VERSION ${version} at ${GITHUB_SHA.slice(0, 7)}`);

// 2. The commit is on main.
const onMain = await gh(`/compare/main...${GITHUB_SHA}`);
if (!['identical', 'behind'].includes(onMain.status))
  fail(`${GITHUB_SHA.slice(0, 7)} is not on main (compare status: ${onMain.status})`);

// 3. The same commit passed its staging deploy.
const staged = await lastSuccessfulDeployment('staging', GITHUB_SHA);
if (!staged)
  fail(
    `${GITHUB_SHA.slice(0, 7)} has no successful staging deployment. ` +
      'Let Deploy staging finish for this commit, then re-run.',
  );

console.log(`::notice::${GITHUB_REF_NAME} (${GITHUB_SHA.slice(0, 7)}) passed staging`);
summary(`## Release ${version}\n`);
summary(`Commit \`${GITHUB_SHA.slice(0, 7)}\` passed staging on ${staged.created_at}.\n`);

// What the release holds: commits since the last successful production deploy.
const prod = await lastSuccessfulDeployment('production');
if (!prod) {
  summary('First production release through this workflow.');
} else if (prod.sha === GITHUB_SHA) {
  summary('Production is already on this commit (re-deploy).');
} else {
  const diff = await gh(`/compare/${prod.sha}...${GITHUB_SHA}`);
  if (diff.status === 'behind') {
    summary(
      `**Rollback:** production is on \`${prod.sha.slice(0, 7)}\`, which is ${diff.behind_by} commit(s) newer.`,
    );
  } else {
    summary(
      `Changes since production (\`${prod.sha.slice(0, 7)}\`), ${diff.ahead_by} commit(s):\n`,
    );
    for (const c of diff.commits) summary(`- ${c.commit.message.split('\n')[0]}`);
  }
}
