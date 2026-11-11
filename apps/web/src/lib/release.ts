import type { BuildRelease } from '../../../../packages/config/src/release.ts';

export type { BuildRelease, ReleaseNotes } from '../../../../packages/config/src/release.ts';

/** This build's release: `1.4.2` in production, `beta-1.4.2` on staging, `dev-1.4.2` locally. */
export const RELEASE: BuildRelease =
  typeof __BMG_RELEASE__ === 'undefined'
    ? { version: '0.0.0', label: 'dev', channel: 'dev', notes: [] }
    : __BMG_RELEASE__;

const SEEN_KEY = 'bmg-seen-release';
const OPEN_EVENT = 'bmg:whats-new';

/** The notes for this release, if CHANGELOG.md has them. */
export function currentNotes(release: BuildRelease = RELEASE) {
  return release.notes.find((n) => n.version === release.version);
}

/** Show "What's new" once per release (by version, so beta and prod count separately per device). */
export function shouldShowWhatsNew(release: BuildRelease = RELEASE): boolean {
  if (!currentNotes(release)) return false;
  try {
    return window.localStorage.getItem(SEEN_KEY) !== release.version;
  } catch {
    // Storage unavailable (private mode): don't nag on every visit.
    return false;
  }
}

export function markWhatsNewSeen(release: BuildRelease = RELEASE): void {
  try {
    window.localStorage.setItem(SEEN_KEY, release.version);
  } catch {
    // Storage unavailable: it shows again next visit, which is fine.
  }
}

/** Open the pop-up from anywhere (the version in the menu footer). */
export function openWhatsNew(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenWhatsNew(handler: () => void): () => void {
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

/** "11 Nov 2026" */
export function formatReleaseDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? undefined
    : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
