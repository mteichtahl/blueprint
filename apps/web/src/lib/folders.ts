import { api } from './api.ts';
import type { AppConfig } from './config.ts';

/** Folders and folder permissions (rev 10). */
export type Level = 'none' | 'view' | 'edit' | 'manage';
export const LEVELS: Level[] = ['none', 'view', 'edit', 'manage'];
export const LEVEL_LABEL: Record<Level, string> = {
  none: 'No access',
  view: 'Can view',
  edit: 'Can edit',
  manage: 'Can manage',
};
export const atLeast = (l: Level, min: Level) => LEVELS.indexOf(l) >= LEVELS.indexOf(min);

export interface Folder {
  folderId: string;
  name: string;
  /** null at the top, or when its parent is one you can't open. */
  parentId: string | null;
  /** Given to you deeper than its parents: shown under "Shared with me". */
  sharedWithMe: boolean;
  /** From the top down; folders you can't open are null ("…"). */
  path: ({ folderId: string; name: string } | null)[];
  level: Level;
  customAccess: boolean;
  ownerId: string;
  ownerName: string;
  ownedByMe: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FolderList {
  root: { level: Level };
  folders: Folder[];
}

export type ItemRef = { kind: 'file' | 'folder'; id: string };

export interface AccessEntry {
  key: string;
  label: string;
  level: Level;
  source:
    | { kind: 'here' }
    | { kind: 'inherited'; folderId: string; folderName: string }
    | { kind: 'default' };
}

export interface AccessInfo {
  item: { kind: 'file' | 'folder'; id: string; name: string };
  level: Level;
  canManage: boolean;
  legacySharing: boolean;
  inherit: boolean;
  entries: AccessEntry[];
  candidates: { key: string; label: string; detail: string; sub?: string }[];
}

export interface Change {
  sub: string;
  name: string;
  gains: number;
  loses: number;
}

export interface Summary {
  items?: number;
  files?: number;
  changes: Change[];
  youLoseManage?: boolean;
  deeperOverrides?: number;
}

/** `/library/files` → `/library/folders`; `/artists/x/files` → `/artists/x/folders`. */
export const foldersBase = (collection: string) => collection.replace(/\/files$/, '/folders');

export const listFolders = (cfg: AppConfig, token: string, base: string) =>
  api<FolderList>(cfg, token, 'GET', base);

export const moveItems = (
  cfg: AppConfig,
  token: string,
  base: string,
  items: ItemRef[],
  to: string | null,
  preview: boolean,
) => api<Summary>(cfg, token, 'POST', `${base}/move`, { items, to, preview });

/** What Copy to… made (rev 10). */
export interface CopyResult {
  files: number;
  folders: number;
  skipped: number;
  firstFolderId?: string;
}

export const copyItems = (
  cfg: AppConfig,
  token: string,
  base: string,
  items: ItemRef[],
  to: string | null,
) => api<CopyResult>(cfg, token, 'POST', `${base}/copy`, { items, to });

/** "Saving gives 2 people access to 48 files and removes access for 1 person from 12 files." */
export function describeChanges(s: Summary, noun = 'items'): string {
  const gain = s.changes.filter((c) => c.gains);
  const lose = s.changes.filter((c) => c.loses);
  const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
  const count = (list: Change[], k: 'gains' | 'loses') => Math.max(0, ...list.map((c) => c[k]));
  const parts: string[] = [];
  if (gain.length)
    parts.push(`gives ${people(gain.length)} access to up to ${count(gain, 'gains')} ${noun}`);
  if (lose.length)
    parts.push(
      `removes access for ${people(lose.length)} from up to ${count(lose, 'loses')} ${noun}`,
    );
  return parts.length ? parts.join(' and ') : 'doesn’t change who can open anything';
}

/**
 * One level of a document picker (rev 10: the chat, submit-for-review and
 * add-to-assets pickers browse folders): the folders and files directly in
 * `at`, by name. Files in folders this person can't open show at the top,
 * as in "Shared with me".
 */
export function pickerLevel<F extends { folderId: string | null; displayName: string }>(
  folders: readonly Folder[],
  files: readonly F[],
  at: string | null,
): { folders: Folder[]; files: F[]; here: Folder | undefined } {
  const ids = new Set(folders.map((f) => f.folderId));
  const where = (f: F) => (f.folderId && ids.has(f.folderId) ? f.folderId : null);
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true });
  return {
    here: at ? folders.find((f) => f.folderId === at) : undefined,
    folders: folders.filter((f) => (f.parentId ?? null) === at).sort(byName),
    files: files.filter((f) => where(f) === at),
  };
}
