import type { E2eAccountKey } from '@bmg/config/e2e';
import { call, ok } from './api.ts';

/**
 * Helpers for the API tests that wait on something the app does in the
 * background: a file being scanned, a notification arriving.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks again until `check` returns a value, or gives up after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  { timeoutMs = 60_000, everyMs = 2_000 } = {},
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (Date.now() > until)
      throw new Error(`Gave up waiting for ${what} after ${timeoutMs / 1000}s`);
    await sleep(everyMs);
  }
}

// ── Notifications (the in-app bell) ────────────────────────────────────────

export interface Notice {
  id: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export const notices = async (as: E2eAccountKey) =>
  (await ok<{ notifications: Notice[] }>(as, 'GET', '/notifications')).notifications;

/**
 * Waits for a bell notification whose title or body contains `text` (the
 * test's tagged name), created after `since`. Notifications go through the
 * event bus, so they take a few seconds.
 */
export function noticeFor(as: E2eAccountKey, text: string, since: string, timeoutMs = 60_000) {
  return waitFor(
    `a notification for ${as} about "${text}"`,
    async () =>
      (await notices(as)).find(
        (n) => n.createdAt >= since && `${n.title} ${n.body}`.includes(text),
      ),
    { timeoutMs, everyMs: 3_000 },
  );
}

// ── Files: upload through the presigned form, then wait for the scan ────────

/** The smallest valid PDF and PNG, so uploads are quick and scan cleanly. */
export const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface UploadTarget {
  url: string;
  fields: Record<string, string>;
}

/** Sends the bytes to S3 with the presigned POST the API handed out. */
export async function sendToS3(target: UploadTarget, bytes: Buffer, contentType: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }));
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (res.status >= 300) throw new Error(`S3 upload failed: ${res.status} ${await res.text()}`);
}

export interface FileView {
  fileId: string;
  name: string;
  title: string | null;
  status: string;
  rejectReason: string | null;
  visibility: string | null;
  fileType: { kind: string; ext: string; detected: boolean };
  editAccess: 'owner' | 'chosen' | 'everyone';
  locked: boolean;
  canEdit: boolean;
  canManage: boolean;
  version: number;
  versions: { v: number }[];
  folderId?: string | null;
  inUse?: boolean;
}

export interface UploadOptions {
  name: string;
  title?: string;
  bytes?: Buffer;
  contentType?: string;
  visibility?: 'normal' | 'bmg-only' | 'private';
  editAccess?: 'owner' | 'chosen' | 'everyone';
  folderId?: string;
}

/** Uploads a file to an artist's Library and returns it as the API first saw it (pending). */
export async function startUpload(
  as: E2eAccountKey,
  artistId: string,
  o: UploadOptions,
): Promise<FileView> {
  const bytes = o.bytes ?? PDF_BYTES;
  const contentType = o.contentType ?? 'application/pdf';
  const res = await ok<{ file: FileView; upload: UploadTarget }>(
    as,
    'POST',
    `/artists/${artistId}/files`,
    {
      name: o.name,
      ...(o.title ? { title: o.title } : {}),
      size: bytes.length,
      contentType,
      ...(o.visibility ? { visibility: o.visibility } : {}),
      ...(o.editAccess ? { editAccess: o.editAccess } : {}),
      ...(o.folderId ? { folderId: o.folderId } : {}),
    },
  );
  await sendToS3(res.upload, bytes, contentType);
  return res.file;
}

/** Waits for the malware scan to pass (or fail) and returns the file as its uploader sees it. */
export function scanned(as: E2eAccountKey, artistId: string, fileId: string, version = 1) {
  return waitFor(
    `file ${fileId} v${version} to be scanned`,
    async () => {
      const res = await call<FileView>(as, 'GET', `/artists/${artistId}/files/${fileId}`);
      if (res.status !== 200) return undefined;
      const f = res.data;
      if (f.status === 'rejected') throw new Error(`Upload rejected: ${f.rejectReason}`);
      return f.status === 'available' && f.version >= version ? f : undefined;
    },
    { timeoutMs: 180_000, everyMs: 4_000 },
  );
}

/** Upload and wait: a ready file in the artist's Library. */
export async function upload(as: E2eAccountKey, artistId: string, o: UploadOptions) {
  const f = await startUpload(as, artistId, o);
  return scanned(as, artistId, f.fileId);
}
