import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addChangelogSection,
  buildRelease,
  bumpVersion,
  channelFor,
  compareVersions,
  formatVersion,
  parseChangelog,
  parseVersion,
  readVersionFile,
  releaseLabel,
} from '../src/release.ts';

describe('release versions', () => {
  it('parses and formats MAJOR.MINOR.PATCH', () => {
    expect(parseVersion(' 1.4.2\n')).toEqual({ major: 1, minor: 4, patch: 2 });
    expect(formatVersion(parseVersion('10.0.31'))).toBe('10.0.31');
  });

  it.each(['1.4', 'v1.4.2', '1.04.2', '1.4.2-beta', 'beta-1.4.2', ''])('rejects %j', (bad) => {
    expect(() => parseVersion(bad)).toThrow(/not a release version/);
  });

  it('bumps major, minor and hotfix', () => {
    const v = parseVersion('1.4.2');
    expect(formatVersion(bumpVersion(v, 'major'))).toBe('2.0.0');
    expect(formatVersion(bumpVersion(v, 'minor'))).toBe('1.5.0');
    expect(formatVersion(bumpVersion(v, 'hotfix'))).toBe('1.4.3');
  });

  it('compares numerically, not as text', () => {
    expect(compareVersions(parseVersion('1.10.0'), parseVersion('1.9.9'))).toBe(1);
    expect(compareVersions(parseVersion('1.0.0'), parseVersion('1.0.0'))).toBe(0);
    expect(compareVersions(parseVersion('0.9.0'), parseVersion('1.0.0'))).toBe(-1);
  });

  it('prefixes beta for staging, nothing for prod, dev elsewhere', () => {
    const v = parseVersion('1.4.2');
    expect(releaseLabel(v, channelFor('prod'))).toBe('1.4.2');
    expect(releaseLabel(v, channelFor('staging'))).toBe('beta-1.4.2');
    expect(releaseLabel(v, channelFor(undefined))).toBe('dev-1.4.2');
  });

  it('the committed VERSION file is a valid release version', () => {
    expect(() => readVersionFile(resolve(import.meta.dirname, '../../..'))).not.toThrow();
  });
});

describe('changelog', () => {
  const md = [
    '# Changelog',
    'Intro text is ignored.',
    '## 1.1.0 — 2026-12-01',
    '',
    'Gig money gets easier.',
    'Second line of summary.',
    '',
    '### New',
    '- Takings by ticket type',
    '### Fixed',
    '* Profit rounding',
    '## 1.0.0',
    '- First release',
  ].join('\n');

  it('parses releases, summaries and grouped bullets, newest first', () => {
    const [latest, first] = parseChangelog(md);
    expect(latest).toEqual({
      version: '1.1.0',
      date: '2026-12-01',
      summary: 'Gig money gets easier. Second line of summary.',
      groups: [
        { title: 'New', items: ['Takings by ticket type'] },
        { title: 'Fixed', items: ['Profit rounding'] },
      ],
    });
    expect(first).toEqual({
      version: '1.0.0',
      summary: '',
      groups: [{ title: '', items: ['First release'] }],
    });
  });

  it('rejects a release heading that is not a version', () => {
    expect(() => parseChangelog('## Next release')).toThrow(/should look like/);
  });

  it('adds an empty section above the newest release, once', () => {
    const out = addChangelogSection(md, '1.2.0', '2026-12-10');
    expect(out.indexOf('## 1.2.0 — 2026-12-10')).toBeLessThan(out.indexOf('## 1.1.0'));
    expect(parseChangelog(out)[0]).toMatchObject({ version: '1.2.0', summary: '', groups: [] });
    expect(addChangelogSection(out, '1.2.0', '2026-12-10')).toBe(out);
  });

  it('every release has notes: VERSION has a changelog section with a summary and bullets', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const build = buildRelease(root, 'prod');
    const notes = build.notes[0];
    expect(notes?.version, `CHANGELOG.md needs a "## ${build.version}" section`).toBe(
      build.version,
    );
    expect(notes!.summary, `write a summary for ${build.version} in CHANGELOG.md`).not.toBe('');
    expect(notes!.groups.flatMap((g) => g.items).length).toBeGreaterThan(0);
  });

  it('labels the build for its environment', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const beta = buildRelease(root, 'staging', '0123456789abcdef');
    expect(beta.label).toBe(`beta-${beta.version}`);
    expect(beta.commit).toBe('0123456');
  });
});
