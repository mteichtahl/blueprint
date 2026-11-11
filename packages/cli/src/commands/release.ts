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
import { REPO_ROOT, heading, log, ok, warn, type GlobalOptions } from '../lib/runtime.ts';

/**
 * `blueprint release <major|minor|hotfix>`: bump the VERSION file and add an
 * empty CHANGELOG.md section to fill in (CI fails until it has a summary and
 * bullets). Commit both in the PR that ships the change; the Deploy workflow
 * then labels staging `beta-X.Y.Z` and production `X.Y.Z`.
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
      `  Staging will show ${releaseLabel(next, 'beta')}, production ${releaseLabel(next, 'prod')}.`,
  );
}

/** `blueprint release show`: the current version and its labels. */
export async function releaseShow(): Promise<void> {
  const v = readVersionFile(REPO_ROOT);
  heading(`Release ${formatVersion(v)}`);
  ok(`staging (beta): ${releaseLabel(v, 'beta')}`);
  ok(`production:     ${releaseLabel(v, 'prod')}`);
}
