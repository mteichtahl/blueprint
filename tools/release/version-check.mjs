#!/usr/bin/env node
// Version check for pull requests (docs/releases.md).
//
// After a release ships, the next PR must start a new one, so staging's
// beta-X.Y.Z label moves on and `blueprint release ship` has a new version to
// tag. Passes when VERSION is newer than both the version production last
// deployed successfully and the newest vX.Y.Z release tag.
//
// Env: GITHUB_TOKEN (contents: read, deployments: read), GITHUB_REPOSITORY.

import { readFileSync } from 'node:fs';
import { URLSearchParams } from 'node:url';
import { Buffer } from 'node:buffer';

const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
const API = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

async function gh(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) fail(`GitHub API ${path} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Negative, zero or positive, like a sort comparator. */
function compare(a, b) {
  const [, ...x] = SEMVER.exec(a).map(Number);
  const [, ...y] = SEMVER.exec(b).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** VERSION at the commit production last deployed successfully, if any. */
async function productionVersion() {
  const query = new URLSearchParams({ environment: 'production', per_page: '30' });
  for (const d of (await gh(`/deployments?${query}`)) ?? []) {
    const statuses = await gh(`/deployments/${d.id}/statuses?per_page=100`);
    if (!statuses?.some((st) => st.state === 'success')) continue;
    const file = await gh(`/contents/VERSION?ref=${d.sha}`);
    const text = file ? Buffer.from(file.content, 'base64').toString('utf8').trim() : '';
    return SEMVER.test(text) ? { version: text, sha: d.sha } : undefined;
  }
  return undefined;
}

/** The newest vX.Y.Z tag, without the v. */
async function newestReleaseTag() {
  const refs = (await gh('/git/matching-refs/tags/v')) ?? [];
  return refs
    .map((r) => r.ref.replace('refs/tags/v', ''))
    .filter((v) => SEMVER.test(v))
    .sort(compare)
    .at(-1);
}

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) fail('missing GitHub environment');
const version = readFileSync('VERSION', 'utf8').trim();
if (!SEMVER.test(version)) fail(`VERSION "${version}" is not MAJOR.MINOR.PATCH`);

const prod = await productionVersion();
const tag = await newestReleaseTag();
const released = [prod?.version, tag].filter(Boolean).sort(compare).at(-1);

if (released && compare(version, released) <= 0) {
  fail(
    `VERSION is ${version}, but ${released} has already been released` +
      `${prod?.version === released ? ` (production, ${prod.sha.slice(0, 7)})` : ' (release tag)'}. ` +
      'Start the next release in this PR: run `blueprint release minor` (or `major` / `hotfix`), ' +
      'fill in the new CHANGELOG.md section, and commit both files.',
  );
}
console.log(
  `::notice::VERSION ${version} is newer than the last release (${released ?? 'none yet'})`,
);
