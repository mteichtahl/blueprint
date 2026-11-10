import { api } from './api.ts';
import type { AppConfig } from './config.ts';
import { makeThumbnail, THUMB_MAX_BYTES } from './thumbnail.ts';

export type FileKind =
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'text'
  | 'design'
  | 'other';

/** What the file is: detected from its bytes after the scan, guessed from its name before. */
export interface FileTypeInfo {
  kind: FileKind;
  /** "PDF", "Word document", "PNG image"… */
  label: string;
  ext: string;
  mime: string;
  detected: boolean;
}

export interface FileItem {
  fileId: string;
  scope: 'artist' | 'library';
  artistId: string | null;
  /** The original file name (downloads keep it). */
  name: string;
  /** The name given at upload, if any. */
  title: string | null;
  /** What to show in lists and tables: the given name, else the file name. */
  displayName: string;
  fileType: FileTypeInfo;
  hasThumbnail: boolean;
  /** A short-lived link to the preview image (5 minutes), when there is one. */
  thumbnailUrl: string | null;
  size: number;
  contentType: string;
  status: 'pending' | 'available' | 'rejected';
  rejectReason: string | null;
  visibility: 'normal' | 'bmg-only' | 'private' | null;
  sharing: 'bmg-only' | 'all-artists' | 'selected' | null;
  sharedWithArtistIds: string[];
  uploadedByMe: boolean;
  uploaderRole: 'artist' | 'bmg-admin' | 'bmg-staff';
  /** The owner (rev 8): the uploader, until they hand it on. */
  ownerId: string;
  ownerRole: 'artist' | 'bmg-admin' | 'bmg-staff';
  ownerName: string;
  ownerJobTitle: string;
  ownedByMe: boolean;
  /** Who else can rename it and upload new versions. */
  editAccess: EditAccess;
  /** The chosen editors (shown to the owner only). */
  editorIds: string[];
  locked: boolean;
  /** What you can do with it (the API checks again). */
  canEdit: boolean;
  canManage: boolean;
  createdAt: string;
  availableAt: string | null;
  /** Set when the file is in the artist's asset library. */
  asset: AssetMeta | null;
}

export type EditAccess = 'owner' | 'chosen' | 'everyone';

export const EDIT_ACCESS_LABEL: Record<EditAccess, string> = {
  owner: 'Only me (locked)',
  chosen: 'Me and chosen people',
  everyone: 'Everyone who can see it',
};

/** Someone who can be given edit access or ownership of a document. */
export interface Person {
  sub: string;
  displayName: string;
  jobTitle: string;
  isArtist: boolean;
}

export type AssetCategory = 'press-photo' | 'artwork' | 'logo' | 'video' | 'audio' | 'other';
export type AssetUse = 'press' | 'social' | 'website';
export interface AssetMeta {
  category: AssetCategory;
  title: string;
  credit?: string;
  approvedFor: AssetUse[];
  status: 'draft' | 'in-review' | 'approved';
  width?: number;
  height?: number;
  durationSeconds?: number;
  updatedAt?: string;
}

/** A short-lived link to show or download the file (5 minutes). */
export async function linkFor(cfg: AppConfig, token: string, path: string): Promise<string> {
  const { url } = await api<{ url: string }>(cfg, token, 'POST', `${path}/download`);
  return url;
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
  opts: {
    /** The name to show in lists instead of the file name. */
    title?: string;
    /** A preview already made (e.g. shown in the form); null for none. Made here if left out. */
    thumbnail?: Blob | null;
  } = {},
): Promise<FileItem> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Files are limited to 500 MB');
  const thumb = opts.thumbnail === undefined ? await makeThumbnail(file) : opts.thumbnail;
  const usableThumb = thumb && thumb.size <= THUMB_MAX_BYTES ? thumb : null;
  const title = opts.title?.trim();
  const res = await api<{
    file: FileItem;
    upload: { url: string; fields: Record<string, string> };
    thumbUpload?: { url: string; fields: Record<string, string> } | null;
  }>(cfg, token, 'POST', collection, {
    name: file.name,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    ...(title && title !== file.name ? { title } : {}),
    ...(usableThumb
      ? { thumbnail: { size: usableThumb.size, contentType: usableThumb.type } }
      : {}),
    ...extra,
  });
  await postToS3(res.upload, file);
  // The preview is a nicety: if it doesn't go through, the list shows the type's tile.
  if (usableThumb && res.thumbUpload) await postToS3(res.thumbUpload, usableThumb).catch(() => {});
  return res.file;
}

async function postToS3(target: { url: string; fields: Record<string, string> }, body: Blob) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target.fields)) form.append(k, v);
  // S3 requires the file to be the last field.
  form.append('file', body);
  const sent = await fetch(target.url, { method: 'POST', body: form });
  if (!sent.ok) throw new Error('The upload didn’t go through. Please try again.');
}

const EXT_LABEL: Record<string, [FileKind, string]> = {
  pdf: ['pdf', 'PDF'],
  png: ['image', 'PNG image'],
  jpg: ['image', 'JPEG image'],
  jpeg: ['image', 'JPEG image'],
  gif: ['image', 'GIF image'],
  webp: ['image', 'WebP image'],
  heic: ['image', 'HEIC photo'],
  svg: ['image', 'SVG image'],
  tif: ['image', 'TIFF image'],
  tiff: ['image', 'TIFF image'],
  psd: ['design', 'Photoshop file'],
  ai: ['design', 'Illustrator file'],
  mp4: ['video', 'MP4 video'],
  mov: ['video', 'QuickTime video'],
  webm: ['video', 'WebM video'],
  mp3: ['audio', 'MP3 audio'],
  wav: ['audio', 'WAV audio'],
  aif: ['audio', 'AIFF audio'],
  aiff: ['audio', 'AIFF audio'],
  flac: ['audio', 'FLAC audio'],
  m4a: ['audio', 'M4A audio'],
  doc: ['document', 'Word document'],
  docx: ['document', 'Word document'],
  pages: ['document', 'Pages document'],
  rtf: ['document', 'Rich text'],
  xls: ['spreadsheet', 'Excel spreadsheet'],
  xlsx: ['spreadsheet', 'Excel spreadsheet'],
  numbers: ['spreadsheet', 'Numbers spreadsheet'],
  csv: ['spreadsheet', 'CSV'],
  ppt: ['presentation', 'PowerPoint'],
  pptx: ['presentation', 'PowerPoint'],
  key: ['presentation', 'Keynote'],
  zip: ['archive', 'ZIP archive'],
  txt: ['text', 'Text'],
  md: ['text', 'Markdown'],
};

/** The type of a file picked in the browser (before upload; the server confirms it). */
export function fileTypeOf(file: { name: string; type: string }): FileTypeInfo {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const hit = EXT_LABEL[ext];
  if (hit) return { kind: hit[0], label: hit[1], ext, mime: file.type, detected: false };
  const top = file.type.split('/')[0] ?? '';
  const kind: FileKind =
    top === 'image' || top === 'video' || top === 'audio' ? top : top === 'text' ? 'text' : 'other';
  return {
    kind,
    label:
      kind === 'other'
        ? ext
          ? `${ext.toUpperCase()} file`
          : 'File'
        : top[0]!.toUpperCase() + top.slice(1),
    ext,
    mime: file.type,
    detected: false,
  };
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
