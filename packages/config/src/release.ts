import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Release versions (semantic versioning, MAJOR.MINOR.PATCH).
 *
 * The single source of truth is the `VERSION` file at the repo root. It is
 * bumped with `blueprint release major|minor|hotfix` in the PR that ships the
 * change. The label people see depends on where the build is deployed:
 *
 *   prod     1.4.2
 *   staging  beta-1.4.2     (the beta environment)
 *   local    dev-1.4.2      (`npm run dev`, tests, CI builds)
 *
 * Shared by the CLI, the CDK app and the web build (vite.config.ts), so it
 * must stay dependency-free apart from node:fs.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** major: breaking/large release · minor: new features · hotfix: fixes only (patch). */
export const BUMPS = ['major', 'minor', 'hotfix'] as const;
export type Bump = (typeof BUMPS)[number];

export type ReleaseChannel = 'prod' | 'beta' | 'dev';

const NUM = '(0|[1-9]\\d*)';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);

export function parseVersion(text: string): SemVer {
  const m = SEMVER.exec(text.trim());
  if (!m)
    throw new Error(
      `"${text.trim()}" is not a release version (expected MAJOR.MINOR.PATCH, e.g. 1.4.2)`,
    );
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function bumpVersion(v: SemVer, bump: Bump): SemVer {
  switch (bump) {
    case 'major':
      return { major: v.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case 'hotfix':
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

/** -1, 0 or 1. */
export function compareVersions(a: SemVer, b: SemVer): number {
  return Math.sign(a.major - b.major || a.minor - b.minor || a.patch - b.patch);
}

/** Deployment environment → release channel. Anything that isn't deployed is `dev`. */
export function channelFor(env: string | undefined): ReleaseChannel {
  if (env === 'prod') return 'prod';
  if (env === 'staging' || env === 'beta') return 'beta';
  return 'dev';
}

/** The label shown in the app and recorded at deploy: `1.4.2`, `beta-1.4.2`, `dev-1.4.2`. */
export function releaseLabel(v: SemVer, channel: ReleaseChannel): string {
  const core = formatVersion(v);
  return channel === 'prod' ? core : `${channel}-${core}`;
}

export const VERSION_FILE = 'VERSION';

export function readVersionFile(repoRoot: string): SemVer {
  return parseVersion(readFileSync(resolve(repoRoot, VERSION_FILE), 'utf8'));
}

export function writeVersionFile(repoRoot: string, v: SemVer): void {
  writeFileSync(resolve(repoRoot, VERSION_FILE), `${formatVersion(v)}\n`);
}

// ── Changelog (CHANGELOG.md): the release summary log and the in-app "What's new" ──
//
//   ## 1.4.0 — 2026-11-20
//
//   One or two sentences summarising the release (top of the pop-up).
//
//   ### New
//   - A bullet per change, written for artists and the Blueprint team.
//   ### Fixed
//   - …
//
// Newest release first. Everything above the first `## ` heading is ignored.

export const CHANGELOG_FILE = 'CHANGELOG.md';

export interface ChangeGroup {
  /** "New", "Improved", "Fixed"…; '' for bullets before any `###` heading. */
  title: string;
  items: string[];
}

export interface ReleaseNotes {
  version: string;
  /** ISO date (YYYY-MM-DD), when given in the heading. */
  date?: string;
  summary: string;
  groups: ChangeGroup[];
}

const RELEASE_HEADING = /^##\s+\[?(\d+\.\d+\.\d+)\]?(?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

export function parseChangelog(markdown: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = [];
  let current: ReleaseNotes | undefined;
  let summary: string[] = [];
  const finish = () => {
    if (!current) return;
    current.summary = summary.join(' ').replace(/\s+/g, ' ').trim();
    current.groups = current.groups.filter((g) => g.items.length > 0);
    releases.push(current);
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      finish();
      const m = RELEASE_HEADING.exec(line);
      if (!m)
        throw new Error(`${CHANGELOG_FILE}: "${line}" should look like "## 1.4.0 — 2026-11-20"`);
      parseVersion(m[1]!);
      current = { version: m[1]!, ...(m[2] ? { date: m[2] } : {}), summary: '', groups: [] };
      summary = [];
      continue;
    }
    if (!current) continue;
    if (line.startsWith('### ')) {
      current.groups.push({ title: line.slice(4).trim(), items: [] });
    } else if (/^[-*]\s+/.test(line)) {
      if (current.groups.length === 0) current.groups.push({ title: '', items: [] });
      current.groups.at(-1)!.items.push(line.replace(/^[-*]\s+/, ''));
    } else if (line && !line.startsWith('<!--') && current.groups.length === 0) {
      summary.push(line);
    }
  }
  finish();
  return releases;
}

export function readChangelog(repoRoot: string): ReleaseNotes[] {
  return parseChangelog(readFileSync(resolve(repoRoot, CHANGELOG_FILE), 'utf8'));
}

/** A new, empty section for `version`, inserted above the newest release. */
export function addChangelogSection(markdown: string, version: string, date: string): string {
  if (parseChangelog(markdown).some((r) => r.version === version)) return markdown;
  const section =
    `## ${version} — ${date}\n\n` +
    `<!-- One or two sentences for the top of the in-app "What's new" pop-up. -->\n\n` +
    `### New\n\n- \n\n`;
  const at = markdown.search(/^## /m);
  return at === -1
    ? `${markdown.trimEnd()}\n\n${section}`
    : markdown.slice(0, at) + section + markdown.slice(at);
}

/** What the web build embeds: the label, and notes for this and recent releases. */
export interface BuildRelease {
  version: string;
  label: string;
  channel: ReleaseChannel;
  commit?: string;
  notes: ReleaseNotes[];
}

export function buildRelease(
  repoRoot: string,
  env: string | undefined,
  commit?: string,
  recent = 5,
): BuildRelease {
  const v = readVersionFile(repoRoot);
  const version = formatVersion(v);
  const all = readChangelog(repoRoot);
  // This release first, then the ones before it (never notes for unreleased versions).
  const from = all.findIndex((r) => r.version === version);
  const notes = from === -1 ? [] : all.slice(from, from + recent);
  const channel = channelFor(env);
  return {
    version,
    label: releaseLabel(v, channel),
    channel,
    ...(commit ? { commit: commit.slice(0, 7) } : {}),
    notes,
  };
}
