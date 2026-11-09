import { api } from './api.ts';
import type { AppConfig } from './config.ts';

export interface FileItem {
  fileId: string;
  scope: 'artist' | 'library';
  artistId: string | null;
  name: string;
  size: number;
  contentType: string;
  status: 'pending' | 'available' | 'rejected';
  rejectReason: string | null;
  visibility: 'normal' | 'bmg-only' | 'private' | null;
  sharing: 'bmg-only' | 'all-artists' | 'selected' | null;
  sharedWithArtistIds: string[];
  uploadedByMe: boolean;
  uploaderRole: 'artist' | 'bmg-admin' | 'bmg-staff';
  createdAt: string;
  availableAt: string | null;
}

/** Matches the API limit (services/api/src/files/model.ts). */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/**
 * Upload in two steps (design 9.3): the API records the file and returns a
 * presigned POST for the quarantine bucket, then the browser sends the file
 * straight to S3. The malware scan runs next; poll `waitUntilScanned`.
 */
export async function uploadFile(
  cfg: AppConfig,
  token: string,
  collection: string,
  file: File,
  extra: Record<string, unknown>,
): Promise<FileItem> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Files are limited to 500 MB');
  const res = await api<{
    file: FileItem;
    upload: { url: string; fields: Record<string, string> };
  }>(cfg, token, 'POST', collection, {
    name: file.name,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    ...extra,
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(res.upload.fields)) form.append(k, v);
  // S3 requires the file to be the last field.
  form.append('file', file);
  const sent = await fetch(res.upload.url, { method: 'POST', body: form });
  if (!sent.ok) throw new Error('The upload didn’t go through. Please try again.');
  return res.file;
}

/** Polls the file until the malware scan has settled it (or ~3 minutes pass). */
export async function waitUntilScanned(
  cfg: AppConfig,
  token: string,
  path: string,
): Promise<FileItem | undefined> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const f = await api<FileItem>(cfg, token, 'GET', path);
    if (f.status !== 'pending') return f;
  }
  return undefined;
}

/**
 * Opens a short-lived download link. The tab is opened during the click (so
 * it isn't blocked as a pop-up) and pointed at the link once it arrives.
 */
export async function download(cfg: AppConfig, token: string, path: string): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const { url } = await api<{ url: string }>(cfg, token, 'POST', `${path}/download`);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
