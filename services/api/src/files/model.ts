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
import { guessFileType, type FileTypeInfo } from './type.ts';

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
  /** The original file name (kept for downloads). */
  name: string;
  /** The name the uploader gave it; shown instead of the file name in lists. */
  title?: string;
  /** What the file really is, from its bytes (set after the scan). */
  fileType?: FileTypeInfo;
  /** A small preview image made by the browser at upload, stored and scanned like the file. */
  thumb?: ThumbRecord;
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
  /**
   * The document's owner (rev 8). The uploader, until they hand it to someone
   * else. Older records have none, so `ownerOf` falls back to the uploader.
   */
  ownerId?: string;
  ownerRole?: 'artist' | 'bmg-admin' | 'bmg-staff';
  /** Who else can rename it and upload new versions (rev 8). See `editAccessOf`. */
  editAccess?: EditAccess;
  /** With `editAccess: 'chosen'`: the people (Cognito subs) who can edit. */
  editorIds?: string[];
  createdAt: string;
  availableAt?: string;
  /** Set when the file is part of the artist's asset library. */
  asset?: AssetMeta;
}

/**
 * Who can edit a document (rev 8), chosen by its owner:
 * - `owner`: only the owner (locked);
 * - `chosen`: the owner and the people in `editorIds`;
 * - `everyone`: everyone who can see it and can change files there.
 */
export const EDIT_ACCESS = ['owner', 'chosen', 'everyone'] as const;
export type EditAccess = (typeof EDIT_ACCESS)[number];
type Role = FileRecord['uploaderRole'];

// ── Assets (screens doc "Assets") ────────────────────────────────────────
/**
 * An asset is an artist file with a little more about it: what kind of asset
 * it is, a credit, and what it is approved for. It is stored, scanned and
 * protected exactly like any other artist file.
 */
export const ASSET_CATEGORIES = [
  'press-photo',
  'artwork',
  'logo',
  'video',
  'audio',
  'other',
] as const;
export const ASSET_USES = ['press', 'social', 'website'] as const;
export const ASSET_STATUSES = ['draft', 'in-review', 'approved'] as const;

export const AssetMetaSchema = z
  .object({
    category: z.enum(ASSET_CATEGORIES),
    title: z.string().trim().min(1).max(120),
    credit: z.string().trim().max(120).optional(),
    approvedFor: z.array(z.enum(ASSET_USES)).max(ASSET_USES.length).default([]),
    status: z.enum(ASSET_STATUSES).default('draft'),
    width: z.number().int().min(1).max(100_000).optional(),
    height: z.number().int().min(1).max(100_000).optional(),
    durationSeconds: z.number().min(0).max(86_400).optional(),
  })
  .strict();
export type AssetMeta = z.infer<typeof AssetMetaSchema> & {
  updatedBy?: string;
  updatedAt?: string;
};

/** The category an upload most likely belongs to, from its type (the person can change it). */
export function guessCategory(contentType: string): (typeof ASSET_CATEGORIES)[number] {
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'image/svg+xml') return 'logo';
  if (contentType.startsWith('image/')) return 'press-photo';
  return 'other';
}

// ── Thumbnails ────────────────────────────────────────────────────────────
/**
 * The browser draws a small preview (an image, a video frame or a PDF's first
 * page) and uploads it next to the file. It goes through the same quarantine
 * and malware scan, and is stored next to the file with the same encryption,
 * so a private file's preview is as private as the file.
 */
export const THUMB_MAX_BYTES = 64 * 1024;
export const THUMB_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export interface ThumbRecord {
  status: 'pending' | 'available' | 'rejected';
  size: number;
  contentType: (typeof THUMB_TYPES)[number];
}
export const ThumbUpload = z
  .object({
    size: z.number().int().min(1).max(THUMB_MAX_BYTES, 'The preview is too large'),
    contentType: z.enum(THUMB_TYPES),
  })
  .strict();
const THUMB_SUFFIX = '.thumb';

export const LIBRARY_PK = 'ORG#library';
export const fileSk = (fileId: string) => `FILE#${fileId}`;
export const FILE_ID_PATTERN = /^[a-z0-9]{10,40}$/;
const ARTIST = 'art_[a-z0-9]{10,32}';

/** Which object: the file itself, or its preview. */
export type FilePart = 'file' | 'thumb';
const suffix = (part: FilePart) => (part === 'thumb' ? THUMB_SUFFIX : '');

/** Where the browser uploads to (quarantine bucket). */
export function quarantineKey(
  scope: FileScope,
  fileId: string,
  artistId?: string,
  part: FilePart = 'file',
): string {
  return (
    (scope === 'artist' ? `artists/${artistId}/${fileId}` : `library/${fileId}`) + suffix(part)
  );
}

/** Where a clean file (or its preview) is kept (artist-data or org-data bucket). */
export function storedKey(
  scope: FileScope,
  fileId: string,
  artistId?: string,
  part: FilePart = 'file',
): string {
  return (
    (scope === 'artist' ? `artists/${artistId}/files/${fileId}` : `library/${fileId}`) +
    suffix(part)
  );
}

export type QuarantineRef = (
  { scope: 'artist'; artistId: string; fileId: string } | { scope: 'library'; fileId: string }
) & { part: FilePart };

/** The inverse of quarantineKey; anything else in the bucket is ignored. */
export function parseQuarantineKey(key: string): QuarantineRef | undefined {
  const artist = new RegExp(`^artists/(${ARTIST})/([a-z0-9]{10,40})(\\.thumb)?$`).exec(key);
  if (artist)
    return {
      scope: 'artist',
      artistId: artist[1]!,
      fileId: artist[2]!,
      part: artist[3] ? 'thumb' : 'file',
    };
  const library = /^library\/([a-z0-9]{10,40})(\.thumb)?$/.exec(key);
  if (library)
    return { scope: 'library', fileId: library[1]!, part: library[2] ? 'thumb' : 'file' };
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

/** The name shown in lists (optional; the file name is used when it's blank). */
const Title = z
  .string()
  .trim()
  .max(200, 'Names are limited to 200 characters')
  .refine(
    // eslint-disable-next-line no-control-regex
    (n) => !/[\u0000-\u001f\u007f]/.test(n),
    'Names cannot contain control characters',
  )
  .optional();

const ContentType = z
  .string()
  .max(100)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, 'Unknown file type')
  .transform((t) => t.toLowerCase());

/** A person, by their Cognito sub. */
export const SUB_PATTERN = /^[0-9a-f-]{36}$/;
const Sub = z.string().regex(SUB_PATTERN, 'Unknown person');
const EditorIds = z
  .array(Sub)
  .max(100)
  .transform((ids) => [...new Set(ids)]);

const Size = z
  .number()
  .int()
  .min(1, 'The file is empty')
  .max(MAX_UPLOAD_BYTES, `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);

export const ArtistUpload = z.object({
  name: FileName,
  title: Title,
  /** Send this to get a second upload target for the preview image. */
  thumbnail: ThumbUpload.optional(),
  size: Size,
  contentType: ContentType.default('application/octet-stream'),
  visibility: z.enum(['normal', 'bmg-only', 'private']).default('normal'),
  /** Who else can edit it (rev 8). Artist files default to only the owner. */
  editAccess: z.enum(EDIT_ACCESS).optional(),
  editorIds: EditorIds.default([]),
  /** Upload straight into the asset library. */
  asset: AssetMetaSchema.optional(),
  /**
   * Other artists who can open it: the artists in the chat it was sent to
   * (rev 7). Set by the uploader at upload time.
   */
  sharedWithArtistIds: z
    .array(z.string().regex(new RegExp(`^${ARTIST}$`)))
    .max(200)
    .default([]),
});

const ArtistIds = z.array(z.string().regex(new RegExp(`^${ARTIST}$`))).max(200);

export const LibraryUpload = z.object({
  name: FileName,
  title: Title,
  thumbnail: ThumbUpload.optional(),
  size: Size,
  contentType: ContentType.default('application/octet-stream'),
  sharing: z.enum(['bmg-only', 'all-artists', 'selected']).default('bmg-only'),
  sharedWithArtistIds: ArtistIds.default([]),
  /** Who else can edit it (rev 8). Library documents default to the whole Blueprint team. */
  editAccess: z.enum(EDIT_ACCESS).optional(),
  editorIds: EditorIds.default([]),
});

/** A new name; an empty one goes back to showing the file name. */
const Rename = z
  .string()
  .trim()
  .max(200, 'Names are limited to 200 characters')
  .refine(
    // eslint-disable-next-line no-control-regex
    (n) => !/[\u0000-\u001f\u007f]/.test(n),
    'Names cannot contain control characters',
  );

/** Owner-only changes (rev 8): who can edit, and handing the document to someone else. */
const OwnerFields = {
  editAccess: z.enum(EDIT_ACCESS).optional(),
  /** Replaces the list of chosen editors. */
  editorIds: EditorIds.optional(),
  /** Transfer ownership to this person. */
  ownerId: Sub.optional(),
};

const somethingToChange = (v: Record<string, unknown>) =>
  Object.values(v).some((x) => x !== undefined);

export const ArtistFilePatch = z
  .object({
    /** Private can't be switched on or off after upload: it decides how the file was encrypted. */
    visibility: z.enum(['normal', 'bmg-only']).optional(),
    /** Rename: the name shown in lists ('' shows the file name again). */
    title: Rename.optional(),
    ...OwnerFields,
  })
  .strict()
  .refine(somethingToChange, 'Nothing to change');

export const LibraryPatch = z
  .object({
    sharing: z.enum(['bmg-only', 'all-artists', 'selected']).optional(),
    sharedWithArtistIds: ArtistIds.default([]),
    title: Rename.optional(),
    ...OwnerFields,
  })
  .strict()
  .refine(
    (v) =>
      v.sharing !== undefined ||
      v.title !== undefined ||
      v.editAccess !== undefined ||
      v.editorIds !== undefined ||
      v.ownerId !== undefined,
    'Nothing to change',
  );

/** Which visibilities each side may choose for an artist file. */
export function visibilityAllowed(role: FileRecord['uploaderRole'], v: FileVisibility): boolean {
  if (v === 'private') return role === 'artist';
  if (v === 'bmg-only') return role !== 'artist';
  return true;
}

// ── Owner and who can edit (rev 8) ─────────────────────────────────────────
type Viewer = { sub: string; role: Role };
type Owned = Pick<
  FileRecord,
  'scope' | 'uploadedBy' | 'uploaderRole' | 'ownerId' | 'ownerRole' | 'editAccess' | 'editorIds'
>;

/** The owner: whoever uploaded it, until it's handed to someone else. */
export function ownerOf(f: Owned): Viewer {
  return { sub: f.ownerId ?? f.uploadedBy, role: f.ownerRole ?? f.uploaderRole };
}

/**
 * New library documents are open to the whole Blueprint team (as renaming
 * was before rev 8); everything else starts locked to its owner.
 */
export function defaultEditAccess(scope: FileScope): EditAccess {
  return scope === 'library' ? 'everyone' : 'owner';
}

export function editAccessOf(f: Owned): EditAccess {
  return f.editAccess ?? defaultEditAccess(f.scope);
}

export const isOwner = (p: Viewer, f: Owned) => ownerOf(f).sub === p.sub;

/**
 * Who manages a document: its sharing, who can edit it, ownership and
 * deleting. The owner, plus a Blueprint admin for documents owned by the
 * Blueprint team (for when someone leaves). Nobody overrides an artist's
 * own documents.
 */
export function manageAllowed(p: Viewer, f: Owned): string | undefined {
  if (isOwner(p, f)) return undefined;
  const owner = ownerOf(f);
  if (p.role === 'bmg-admin' && owner.role !== 'artist') return undefined;
  if (owner.role === 'artist') {
    return p.role === 'artist'
      ? 'Only the owner can change this document'
      : 'Only the artist who owns this document can change that';
  }
  return 'Only the owner or an admin can change that';
}

/**
 * Who may rename it or upload a new version (on top of write access to
 * where it lives). The owner always; others as the owner chose. A lock is
 * a lock: an admin can't edit an artist's locked document.
 */
export function editAllowed(p: Viewer, f: Owned): string | undefined {
  if (!manageAllowed(p, f)) return undefined;
  if (f.scope === 'library' && p.role === 'artist') {
    return 'Only Blueprint can change library documents';
  }
  switch (editAccessOf(f)) {
    case 'everyone':
      return undefined;
    case 'chosen':
      return (f.editorIds ?? []).includes(p.sub)
        ? undefined
        : 'The owner hasn’t given you edit access to this document';
    case 'owner':
      return 'This document is locked by its owner';
  }
}

/** Deleting is the owner's call (or an admin's, for Blueprint's documents). */
export function deleteAllowed(p: Viewer, f: Owned): string | undefined {
  if (!manageAllowed(p, f)) return undefined;
  return ownerOf(f).role === 'artist'
    ? 'Only the artist who owns this document can delete it'
    : 'Only the owner or an admin can delete this document';
}

/**
 * Who can be given edit access or ownership: people who can already see the
 * document and change files where it lives.
 * - Library documents: the Blueprint team.
 * - Artist files: that artist and the Blueprint people on their workspace;
 *   Blueprint only for a BMG-only file; nobody else for a private one (only
 *   the artist can open it).
 */
export function canBeEditor(
  person: { role: Role; artistId?: string; assignedArtistIds?: string[] },
  f: Pick<FileRecord, 'scope' | 'visibility' | 'artistId'>,
): boolean {
  const bmg =
    person.role === 'bmg-admin' ||
    (person.role === 'bmg-staff' &&
      (f.scope === 'library' || (person.assignedArtistIds ?? []).includes(f.artistId ?? '')));
  if (f.scope === 'library') return bmg;
  if (f.visibility === 'private') return false;
  if (person.role === 'artist')
    return f.visibility !== 'bmg-only' && person.artistId === f.artistId;
  return bmg;
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
export function publicFile(f: FileRecord & { uploadedBy: string }, viewer: Viewer) {
  const viewerSub = viewer.sub;
  const owner = ownerOf(f);
  const access = editAccessOf(f);
  return {
    fileId: f.fileId,
    scope: f.scope,
    artistId: f.artistId ?? null,
    name: f.name,
    title: f.title || null,
    /** What lists and tables show: the given name, else the file name. */
    displayName: f.title || f.name,
    /** Detected from the bytes once scanned; a guess from the name until then. */
    fileType: f.fileType ?? guessFileType(f.name, f.contentType),
    hasThumbnail: f.thumb?.status === 'available',
    size: f.size,
    contentType: f.contentType,
    status: f.status,
    rejectReason: f.rejectReason ?? null,
    visibility: f.visibility ?? null,
    sharing: f.sharing ?? null,
    sharedWithArtistIds: f.sharedWithArtistIds ?? [],
    uploadedByMe: f.uploadedBy === viewerSub,
    uploaderRole: f.uploaderRole,
    /** The owner (rev 8); `ownerName` is filled in by the API. */
    ownerId: owner.sub,
    ownerRole: owner.role,
    ownedByMe: owner.sub === viewerSub,
    editAccess: access,
    /** Only the owner (and whoever manages it) sees who the chosen editors are. */
    editorIds: access === 'chosen' && !manageAllowed(viewer, f) ? (f.editorIds ?? []) : [],
    locked: access === 'owner',
    /** What this viewer can do (the API checks again on every change). */
    canEdit: !editAllowed(viewer, f),
    canManage: !manageAllowed(viewer, f),
    createdAt: f.createdAt,
    availableAt: f.availableAt ?? null,
    asset: f.asset ?? null,
  };
}
