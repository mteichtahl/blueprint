/**
 * Files (design 9.2, 9.3, F2): the record shape, S3 keys, request schemas and
 * the small rules around them. Pure, so they are unit-tested.
 *
 * Two kinds of file:
 * - **Artist files** live in one artist's workspace. They are stored in the
 *   artist-data bucket, encrypted with that artist's own KMS key.
 * - **Library files** are BMG's document library. They are stored in the
 *   org-data bucket under the platform key, and can be shared with all artists
 *   or with named artists.
 *
 * Every upload goes to the quarantine bucket first. Only after GuardDuty finds
 * no threats is it moved to its real home and marked available.
 */
import { z } from 'zod';

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Upload and download URLs live for 5 minutes (design 9.3). */
export const URL_LIFETIME_SECONDS = 300;
/** A pending record whose upload never arrives is removed after a day (main table TTL). */
export const PENDING_TTL_SECONDS = 24 * 3600;

export type FileScope = 'artist' | 'library';
export type FileStatus = 'pending' | 'available' | 'rejected';
/** Artist files: `normal` (artist + BMG), `bmg-only`, or `private` (the artist only, enforced by KMS). */
export type FileVisibility = 'normal' | 'bmg-only' | 'private';
/** Library files: everyone at BMG, plus all artists or the named ones. */
export type LibrarySharing = 'bmg-only' | 'all-artists' | 'selected';

export interface FileRecord {
  fileId: string;
  scope: FileScope;
  /** Artist files only. */
  artistId?: string;
  name: string;
  size: number;
  contentType: string;
  status: FileStatus;
  rejectReason?: string;
  /** Artist files. */
  visibility?: FileVisibility;
  /** Library files. */
  sharing?: LibrarySharing;
  sharedWithArtistIds?: string[];
  uploadedBy: string;
  uploaderRole: 'artist' | 'bmg-admin' | 'bmg-staff';
  createdAt: string;
  availableAt?: string;
}

export const LIBRARY_PK = 'ORG#library';
export const fileSk = (fileId: string) => `FILE#${fileId}`;
export const FILE_ID_PATTERN = /^[a-z0-9]{10,40}$/;
const ARTIST = 'art_[a-z0-9]{10,32}';

/** Where the browser uploads to (quarantine bucket). */
export function quarantineKey(scope: FileScope, fileId: string, artistId?: string): string {
  return scope === 'artist' ? `artists/${artistId}/${fileId}` : `library/${fileId}`;
}

/** Where a clean file is kept (artist-data or org-data bucket). */
export function storedKey(scope: FileScope, fileId: string, artistId?: string): string {
  return scope === 'artist' ? `artists/${artistId}/files/${fileId}` : `library/${fileId}`;
}

export type QuarantineRef =
  { scope: 'artist'; artistId: string; fileId: string } | { scope: 'library'; fileId: string };

/** The inverse of quarantineKey; anything else in the bucket is ignored. */
export function parseQuarantineKey(key: string): QuarantineRef | undefined {
  const artist = new RegExp(`^artists/(${ARTIST})/([a-z0-9]{10,40})$`).exec(key);
  if (artist) return { scope: 'artist', artistId: artist[1]!, fileId: artist[2]! };
  const library = /^library\/([a-z0-9]{10,40})$/.exec(key);
  if (library) return { scope: 'library', fileId: library[1]! };
  return undefined;
}

// ── Requests ──────────────────────────────────────────────────────────────
const FileName = z
  .string()
  .trim()
  .min(1, 'A file name is required')
  .max(200, 'File names are limited to 200 characters')
  .refine(
    // eslint-disable-next-line no-control-regex
    (n) => !/[\u0000-\u001f\u007f/\\]/.test(n),
    'File names cannot contain / \\ or control characters',
  );

const ContentType = z
  .string()
  .max(100)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, 'Unknown file type')
  .transform((t) => t.toLowerCase());

const Size = z
  .number()
  .int()
  .min(1, 'The file is empty')
  .max(MAX_UPLOAD_BYTES, `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);

export const ArtistUpload = z.object({
  name: FileName,
  size: Size,
  contentType: ContentType.default('application/octet-stream'),
  visibility: z.enum(['normal', 'bmg-only', 'private']).default('normal'),
});

const ArtistIds = z.array(z.string().regex(new RegExp(`^${ARTIST}$`))).max(200);

export const LibraryUpload = z.object({
  name: FileName,
  size: Size,
  contentType: ContentType.default('application/octet-stream'),
  sharing: z.enum(['bmg-only', 'all-artists', 'selected']).default('bmg-only'),
  sharedWithArtistIds: ArtistIds.default([]),
});

export const ArtistFilePatch = z.object({
  /** Private can't be switched on or off after upload: it decides how the file was encrypted. */
  visibility: z.enum(['normal', 'bmg-only']),
});

export const LibraryPatch = z.object({
  sharing: z.enum(['bmg-only', 'all-artists', 'selected']),
  sharedWithArtistIds: ArtistIds.default([]),
});

/** Which visibilities each side may choose for an artist file. */
export function visibilityAllowed(role: FileRecord['uploaderRole'], v: FileVisibility): boolean {
  if (v === 'private') return role === 'artist';
  if (v === 'bmg-only') return role !== 'artist';
  return true;
}

/** The authz resource for a library file (per-file sharing). */
export function librarySharing(rec: Pick<FileRecord, 'sharing' | 'sharedWithArtistIds'>) {
  return {
    kind: 'org-shared' as const,
    visibility: rec.sharing === 'all-artists' ? ('normal' as const) : ('bmg-only' as const),
    sharedWithArtistIds: rec.sharing === 'selected' ? (rec.sharedWithArtistIds ?? []) : [],
  };
}

// ── Scan results ──────────────────────────────────────────────────────────
export type ScanOutcome = { promote: true } | { promote: false; reason: string };

/** Only a clean scan is promoted; anything GuardDuty couldn't vouch for is rejected. */
export function scanOutcome(status: string | undefined): ScanOutcome {
  switch (status) {
    case 'NO_THREATS_FOUND':
      return { promote: true };
    case 'THREATS_FOUND':
      return { promote: false, reason: 'The malware scan found a threat' };
    case 'UNSUPPORTED':
      return {
        promote: false,
        reason: 'The file couldn’t be scanned (for example, it is password protected)',
      };
    default:
      return { promote: false, reason: 'The malware scan didn’t complete' };
  }
}

// ── Downloads ─────────────────────────────────────────────────────────────
/**
 * Media the browser can show safely opens inline; everything else (including
 * SVG and HTML, which can carry script) downloads as an attachment
 * (design 13, "Malicious upload or link").
 */
export function isInlineSafe(contentType: string): boolean {
  if (contentType === 'image/svg+xml') return false;
  return /^(image|audio|video)\//.test(contentType);
}

export function contentDisposition(name: string, contentType: string): string {
  const kind = isInlineSafe(contentType) ? 'inline' : 'attachment';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** What the client sees: no S3 keys, no internal fields. */
export function publicFile(f: FileRecord & { uploadedBy: string }, viewerSub: string) {
  return {
    fileId: f.fileId,
    scope: f.scope,
    artistId: f.artistId ?? null,
    name: f.name,
    size: f.size,
    contentType: f.contentType,
    status: f.status,
    rejectReason: f.rejectReason ?? null,
    visibility: f.visibility ?? null,
    sharing: f.sharing ?? null,
    sharedWithArtistIds: f.sharedWithArtistIds ?? [],
    uploadedByMe: f.uploadedBy === viewerSub,
    uploaderRole: f.uploaderRole,
    createdAt: f.createdAt,
    availableAt: f.availableAt ?? null,
  };
}
