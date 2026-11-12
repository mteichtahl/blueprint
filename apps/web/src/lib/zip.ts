import { zip, type Zippable } from 'fflate';
import { api } from './api.ts';
import type { AppConfig } from './config.ts';
import type { FileItem } from './files.ts';
import type { Folder, ItemRef } from './folders.ts';

/**
 * Download as ZIP (rev 10). Built in the browser from the same short-lived
 * download links a single download uses, so every file is checked by the
 * API (and private files by KMS) exactly as if it were downloaded on its
 * own. Nothing new is stored. Files are stored, not recompressed: most are
 * already compressed (audio, video, images, Office files).
 */

export const ZIP_MAX_FILES = 200;
export const ZIP_MAX_BYTES = 500 * 1024 * 1024;

export interface ZipEntry {
  fileId: string;
  /** Where it goes in the ZIP: folder names, then the file's own name. */
  path: string;
  size: number;
}

/** Keeps every name unique in the ZIP: "rider.pdf", then "rider (2).pdf". */
function unique(path: string, taken: Set<string>): string {
  if (!taken.has(path.toLowerCase())) {
    taken.add(path.toLowerCase());
    return path;
  }
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  for (let i = 2; ; i++) {
    const next = `${stem} (${i})${ext}`;
    if (!taken.has(next.toLowerCase())) {
      taken.add(next.toLowerCase());
      return next;
    }
  }
}

/** Names that are safe as ZIP path parts on every system. */
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'untitled';

/**
 * What goes in the ZIP for the chosen files and folders: each folder with
 * everything inside it that this person can see, files at the top. Files
 * still being scanned (or not kept) are left out and counted.
 */
export function zipEntries(
  items: readonly ItemRef[],
  folders: readonly Folder[],
  files: readonly FileItem[],
): { entries: ZipEntry[]; skipped: number } {
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  const children = (id: string) => folders.filter((f) => f.parentId === id);
  const taken = new Set<string>();
  const entries: ZipEntry[] = [];
  let skipped = 0;
  const add = (f: FileItem, dir: string) => {
    if (f.status !== 'available') {
      skipped++;
      return;
    }
    entries.push({ fileId: f.fileId, path: unique(`${dir}${safe(f.name)}`, taken), size: f.size });
  };
  const walk = (folderId: string, dir: string) => {
    for (const f of files.filter((x) => x.folderId === folderId)) add(f, dir);
    for (const c of children(folderId)) walk(c.folderId, `${dir}${safe(c.name)}/`);
  };
  for (const it of items) {
    if (it.kind === 'file') {
      const f = files.find((x) => x.fileId === it.id);
      if (f) add(f, '');
      continue;
    }
    const folder = byId.get(it.id);
    if (folder) walk(folder.folderId, `${safe(folder.name)}/`);
  }
  return { entries, skipped };
}

/** Why a ZIP can't be made, or null. */
export function zipTooBig(entries: readonly ZipEntry[]): string | null {
  if (entries.length === 0) return 'There are no files to download.';
  if (entries.length > ZIP_MAX_FILES) {
    return `That’s ${entries.length} files. Download up to ${ZIP_MAX_FILES} at a time.`;
  }
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > ZIP_MAX_BYTES) {
    return `That’s ${Math.round(total / 1024 / 1024)} MB. Download up to ${ZIP_MAX_BYTES / 1024 / 1024} MB at a time.`;
  }
  return null;
}

/** Fetches each file through its download link, zips them and saves the ZIP. */
export async function downloadZip(
  cfg: AppConfig,
  token: string,
  collection: string,
  entries: readonly ZipEntry[],
  zipName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const tooBig = zipTooBig(entries);
  if (tooBig) throw new Error(tooBig);
  const files: Zippable = {};
  let done = 0;
  for (const e of entries) {
    const { url } = await api<{ url: string }>(
      cfg,
      token,
      'POST',
      `${collection}/${e.fileId}/download`,
    );
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`Couldn’t download “${e.path}”. Try again.`);
    files[e.path] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
    onProgress?.(++done, entries.length);
  }
  const data = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out))),
  );
  const blob = new Blob([data as BlobPart], { type: 'application/zip' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = `${safe(zipName).replace(/\.zip$/i, '')}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

// ── This folder / Everywhere search (rev 10) ────────────────────────────────
export type SearchScope = 'here' | 'everywhere';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();

/**
 * Files and folders whose name matches every word typed. "This folder"
 * searches the open folder and everything inside it; "Everywhere" the whole
 * library this person can see.
 */
export function searchLibrary(
  query: string,
  scope: SearchScope,
  at: string | null,
  folders: readonly Folder[],
  files: readonly FileItem[],
): { folders: Folder[]; files: FileItem[] } {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { folders: [], files: [] };
  const hit = (...names: (string | null | undefined)[]) => {
    const text = norm(names.filter(Boolean).join(' '));
    return words.every((w) => text.includes(w));
  };
  const inside = (folderId: string | null): boolean => {
    if (scope === 'everywhere' || at === null) return true;
    const byId = new Map(folders.map((f) => [f.folderId, f]));
    for (let id = folderId; id; id = byId.get(id)?.parentId ?? null) {
      if (id === at) return true;
    }
    return false;
  };
  return {
    folders: folders.filter((f) => f.folderId !== at && inside(f.parentId) && hit(f.name)),
    files: files.filter((f) => inside(f.folderId) && hit(f.displayName, f.name)),
  };
}
