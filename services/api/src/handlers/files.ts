import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authorize, type Principal } from '@bmg/authz';
import { DataAccessSessions, isArtistId } from '@bmg/crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { z } from 'zod';
import {
  archivedKey,
  currentVersion,
  nextVersion,
  DownloadBody,
  VersionRestore,
  VersionUpload,
  versionBlocked,
  ArtistFilePatch,
  AssetMetaSchema,
  ArtistUpload,
  canBeEditor,
  contentDisposition,
  defaultEditAccess,
  deleteAllowed,
  editAccessOf,
  editAllowed,
  inUseMessage,
  FILE_ID_PATTERN,
  fileSk,
  LIBRARY_PK,
  LibraryPatch,
  LibraryUpload,
  manageAllowed,
  ownerOf,
  PENDING_TTL_SECONDS,
  publicFile,
  quarantineKey,
  storedKey,
  URL_LIFETIME_SECONDS,
  visibilityAllowed,
  type FileRecord,
} from '../files/model.ts';
import { namesFor, people, type Person } from '../files/people.ts';
import { can, fileAccess, folderAccess, rootAccess } from '../files/access.ts';
import {
  folderManaged,
  folderMap,
  folderSk,
  type FolderMap,
  type Level,
} from '../files/folders.ts';
import { folderRoutes } from '../files/folder-routes.ts';
import { loadFolders } from '../files/folder-store.ts';
import { libraryRoute } from '../files/library-route.ts';
import { usesOf } from '../files/usage.ts';
import { BRAND_SK } from '../brand/model.ts';
import { gigSk, type Gig } from '../events/model.ts';
import {
  counterSk,
  countByKind,
  MAX_MEDIA_NUMBER,
  mediaFolderLabel,
  mediaFolderPath,
  MediaUpload,
  numberFiles,
  pathFolderId,
  reservedNumbers,
  walkFolderPath,
  type MediaKind,
} from '../gigs/media.ts';
import { artistPk, newId } from '../workspace/model.ts';
import {
  audit,
  authContext,
  db,
  env,
  handle,
  HttpError,
  json,
  parseBody,
  principalFor,
} from '../lib.ts';

const s3 = new S3Client({});
const sessions = new DataAccessSessions();
const table = () => env('MAIN_TABLE');

type Stored = FileRecord & { PK: string; SK: string };

function artistIdParam(event: APIGatewayProxyEvent): string {
  const id = event.pathParameters?.artistId;
  if (!isArtistId(id)) throw new HttpError(404, 'No such artist');
  return id;
}

function fileIdParam(event: APIGatewayProxyEvent): string {
  const id = event.pathParameters?.fileId ?? '';
  if (!FILE_ID_PATTERN.test(id)) throw new HttpError(404, 'No such file');
  return id;
}

/** Whether someone can read or change anything in an artist's workspace at all. */
function canArtistSpace(principal: Principal, action: 'read' | 'write', artistId: string) {
  return authorize(principal, action, { kind: 'artist-data', artistId, visibility: 'normal' });
}

// ── Folders (rev 10) ──────────────────────────────────────────────────────
/** Folders are read once per request and space. */
let folderCache = new Map<string, Promise<FolderMap>>();
function foldersOf(pk: string): Promise<FolderMap> {
  let m = folderCache.get(pk);
  if (!m) {
    m = loadFolders(pk).then(folderMap);
    folderCache.set(pk, m);
  }
  return m;
}
const NO_FOLDERS: FolderMap = new Map();
const mapFor = (f: Stored) => (folderManaged(f) ? foldersOf(f.PK) : Promise.resolve(NO_FOLDERS));

const REFUSED: Record<Level, string> = {
  none: 'You don’t have access to this file',
  view: 'You can open this file but not change it',
  edit: 'You can’t change who can open this file',
  manage: '',
};

/** Refuses unless the person has at least `min` on the file. */
async function needFile(principal: Principal, f: Stored, min: Exclude<Level, 'none'>) {
  const a = fileAccess(principal, f, await mapFor(f));
  if (!can(a, min))
    throw new HttpError(
      403,
      REFUSED[a.level === 'none' ? 'none' : min === 'manage' ? 'edit' : 'view'],
    );
  return a;
}

/** An upload into a folder: the folder must exist and the person must be able to add to it. */
async function uploadFolder(
  principal: Principal,
  pk: string,
  space: Parameters<typeof folderAccess>[3],
  id?: string,
) {
  if (!id) return undefined;
  const map = await foldersOf(pk);
  const folder = map.get(id);
  if (!folder || !can(folderAccess(principal, folder, map, space), 'view')) {
    throw new HttpError(404, 'No such folder');
  }
  if (!can(folderAccess(principal, folder, map, space), 'edit')) {
    throw new HttpError(403, 'You can open this folder but not add to it');
  }
  return folder;
}

function ensure(d: { allow: boolean; reason: string }) {
  if (!d.allow) throw new HttpError(403, d.reason);
}

async function load(pk: string, fileId: string): Promise<Stored> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: pk, SK: fileSk(fileId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such file');
  return res.Item as Stored;
}

async function list(pk: string): Promise<Stored[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :f)',
      ExpressionAttributeValues: { ':pk': pk, ':f': 'FILE#' },
      ScanIndexForward: false,
      Limit: 500,
    }),
  );
  return (res.Items ?? []) as Stored[];
}

/** A presigned POST to the quarantine bucket, bound to this key, size and type (design 9.3). */
async function uploadTarget(key: string, size: number, contentType: string) {
  const post = await createPresignedPost(s3, {
    Bucket: env('QUARANTINE_BUCKET'),
    Key: key,
    Expires: URL_LIFETIME_SECONDS,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['content-length-range', size, size],
      ['eq', '$Content-Type', contentType],
    ],
  });
  return { url: post.url, fields: post.fields, expiresIn: URL_LIFETIME_SECONDS };
}

async function createRecord(pk: string, rec: FileRecord) {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: pk,
        SK: fileSk(rec.fileId),
        type: 'file',
        ...rec,
        ttl: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

function downloadParams(f: FileRecord) {
  return {
    ResponseContentDisposition: contentDisposition(f.name, f.contentType),
    ResponseContentType: f.contentType,
    ResponseCacheControl: 'private, no-store',
  };
}

/**
 * Artist files are signed with a data-access session for that artist and the
 * caller's role, so S3 asks KMS under the caller's own tags: another artist's
 * key, or a private file for a BMG role, is refused by KMS itself (design 9.1).
 */
async function artistDownloadUrl(principal: Principal, f: FileRecord): Promise<string> {
  const credentials = await sessions.credentials(
    { roleArn: env('DATA_ACCESS_ROLE_ARN'), artistId: f.artistId!, role: principal.role },
    { minRemainingMs: (URL_LIFETIME_SECONDS + 60) * 1000 },
  );
  const client = new S3Client({ credentials });
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: env('ARTIST_BUCKET'),
      Key: storedKey('artist', f.fileId, f.artistId),
      ...downloadParams(f),
    }),
    { expiresIn: URL_LIFETIME_SECONDS },
  );
}

async function libraryDownloadUrl(f: FileRecord): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: env('LIBRARY_BUCKET'),
      Key: storedKey('library', f.fileId),
      ...downloadParams(f),
    }),
    { expiresIn: URL_LIFETIME_SECONDS },
  );
}

/**
 * A short-lived link to a file's preview image, signed like a download: an
 * artist file's preview is encrypted like the file, so it's signed in a
 * data-access session for that artist and the caller's role.
 */
async function thumbnailUrl(principal: Principal, f: FileRecord): Promise<string | null> {
  if (f.thumb?.status !== 'available') return null;
  const params = {
    ResponseContentType: f.thumb.contentType,
    ResponseCacheControl: 'private, max-age=300',
  };
  if (f.scope === 'library') {
    return getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: env('LIBRARY_BUCKET'),
        Key: storedKey('library', f.fileId, undefined, 'thumb', f.thumb.v ?? 1),
        ...params,
      }),
      { expiresIn: URL_LIFETIME_SECONDS },
    );
  }
  const credentials = await sessions.credentials(
    { roleArn: env('DATA_ACCESS_ROLE_ARN'), artistId: f.artistId!, role: principal.role },
    { minRemainingMs: (URL_LIFETIME_SECONDS + 60) * 1000 },
  );
  return getSignedUrl(
    new S3Client({ credentials }),
    new GetObjectCommand({
      Bucket: env('ARTIST_BUCKET'),
      Key: storedKey('artist', f.fileId, f.artistId, 'thumb', f.thumb.v ?? 1),
      ...params,
    }),
    { expiresIn: URL_LIFETIME_SECONDS },
  );
}

/**
 * What the client gets for each file: the public fields, a preview link
 * (signing is local: no call per file; a failure just means no preview) and
 * the owner's name and job title (rev 8).
 */
async function withThumbnails(principal: Principal, files: Stored[]) {
  const subs = files.flatMap((f) => [
    ownerOf(f).sub,
    f.versionUploadedBy ?? f.uploadedBy,
    ...(f.versions ?? []).map((v) => v.uploadedBy),
  ]);
  const names = await namesFor([...new Set(subs)]);
  const nameOf = (sub: string) => names.get(sub)?.displayName ?? 'Someone';
  return Promise.all(
    files.map(async (f) => {
      const owner = names.get(ownerOf(f).sub);
      const shown = publicFile(f, principal);
      // Folder access (rev 10) narrows what rev 8 allows; the API checks again.
      const level = fileAccess(principal, f, await mapFor(f)).level;
      return {
        ...shown,
        level,
        canEdit: shown.canEdit && can({ level, why: { kind: 'default' } }, 'edit'),
        canMove: level === 'manage' || shown.canManage,
        versionUploadedByName: nameOf(shown.versionUploadedBy),
        versions: shown.versions.map((v) => ({ ...v, uploadedByName: nameOf(v.uploadedBy) })),
        ownerName: owner?.displayName ?? (ownerOf(f).role === 'artist' ? 'Artist' : 'Blueprint'),
        ownerJobTitle: owner?.jobTitle ?? '',
        thumbnailUrl: await thumbnailUrl(principal, f).catch(() => null),
      };
    }),
  );
}

/** People who can be given edit access to, or ownership of, this file. */
async function candidates(f: FileRecord): Promise<Person[]> {
  return (await people()).filter((p) => canBeEditor(p, f));
}

/** Chosen editors and new owners must be people who can see the file. */
async function checkPeople(f: FileRecord, subs: string[]) {
  if (subs.length === 0) return;
  const ok = new Set((await candidates(f)).map((p) => p.sub));
  if (subs.some((s) => !ok.has(s))) {
    throw new HttpError(400, 'Only people who can see this document can edit or own it');
  }
}

/**
 * The owner-only part of a PATCH (rev 8): who can edit, and handing the
 * document to someone else. Returns the update clauses and the new record.
 */
async function ownerChanges(
  principal: Principal,
  f: FileRecord,
  patch: { editAccess?: FileRecord['editAccess']; editorIds?: string[]; ownerId?: string },
) {
  const sets: string[] = [];
  const values: Record<string, unknown> = {};
  const next: Partial<FileRecord> = {};
  if (patch.editAccess === undefined && patch.editorIds === undefined && !patch.ownerId) {
    return { sets, values, next };
  }
  const refused = manageAllowed(principal, f);
  if (refused) throw new HttpError(403, refused);
  if (patch.editAccess !== undefined || patch.editorIds !== undefined) {
    const access = patch.editAccess ?? editAccessOf(f);
    const ids = access === 'chosen' ? (patch.editorIds ?? f.editorIds ?? []) : [];
    await checkPeople(f, ids);
    sets.push('editAccess = :ea', 'editorIds = :eds');
    values[':ea'] = access;
    values[':eds'] = ids;
    next.editAccess = access;
    next.editorIds = ids;
  }
  if (patch.ownerId && patch.ownerId !== ownerOf(f).sub) {
    const to = (await candidates(f)).find((p) => p.sub === patch.ownerId);
    if (!to) throw new HttpError(400, 'Only someone who can see this document can own it');
    sets.push('ownerId = :oid', 'ownerRole = :orole');
    values[':oid'] = to.sub;
    values[':orole'] = to.role;
    next.ownerId = to.sub;
    next.ownerRole = to.role;
    // The old owner keeps edit access if the new owner had chosen editors.
    const access = next.editAccess ?? editAccessOf(f);
    if (access === 'chosen') {
      const ids = [...new Set([...(next.editorIds ?? f.editorIds ?? []), ownerOf(f).sub])].filter(
        (s) => s !== to.sub,
      );
      if (!sets.includes('editAccess = :ea')) sets.push('editAccess = :ea', 'editorIds = :eds');
      values[':ea'] = access;
      values[':eds'] = ids;
      next.editAccess = access;
      next.editorIds = ids;
    }
  }
  return { sets, values, next };
}

/**
 * One file. `?include=` adds, for the document's own page (rev 8):
 * - `people`: who can be given edit access or ownership (owner and managers
 *   only; left out for anyone else), so the picker needs no route of its own;
 * - `uses`: where it's used, and how many more places this person can't see.
 */
async function single(principal: Principal, event: APIGatewayProxyEvent, f: Stored) {
  const shown = (await withThumbnails(principal, [f]))[0]!;
  const include = new Set((event.queryStringParameters?.include ?? '').split(','));
  const extra: Record<string, unknown> = {};
  if (include.has('people') && !manageAllowed(principal, f)) {
    extra.people = await peopleFor(principal, f);
  }
  if (include.has('uses')) {
    const uses = await usesOf(principal, f);
    extra.uses = uses.visible;
    extra.hiddenUses = uses.hidden;
    extra.inUse = uses.all.some((u) => u.blocks);
  }
  return { ...shown, ...extra };
}

/**
 * Which of an artist's files are in use somewhere that stops them being
 * deleted (rev 8), for the "In use" chip in lists: the asset library (on the
 * record), the brand kit, and submissions waiting for review.
 */
async function inUseIds(artistId: string, files: FileRecord[]): Promise<Set<string>> {
  const ids = new Set(files.filter((f) => f.asset).map((f) => f.fileId));
  const [kit, subs] = await Promise.all([
    db.send(
      new GetCommand({
        TableName: table(),
        Key: { PK: artistPk(artistId), SK: BRAND_SK },
        ProjectionExpression: 'logos, imagery',
      }),
    ),
    db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
        FilterExpression: '#st = :open',
        ExpressionAttributeValues: { ':pk': artistPk(artistId), ':s': 'SUB#', ':open': 'open' },
        ExpressionAttributeNames: { '#st': 'status' },
        ProjectionExpression: 'fileIds',
      }),
    ),
  ]);
  const k = kit.Item as
    { logos?: { fileId: string }[]; imagery?: { fileIds?: string[] } } | undefined;
  for (const l of k?.logos ?? []) ids.add(l.fileId);
  for (const id of k?.imagery?.fileIds ?? []) ids.add(id);
  for (const s of subs.Items ?? []) for (const id of (s.fileIds as string[]) ?? []) ids.add(id);
  return ids;
}

/** The people picker for a file (owner and managers only). */
async function peopleFor(principal: Principal, f: FileRecord) {
  const refused = manageAllowed(principal, f);
  if (refused) throw new HttpError(403, refused);
  const owner = ownerOf(f).sub;
  return (await candidates(f))
    .filter((p) => p.sub !== owner)
    .map((p) => ({
      sub: p.sub,
      displayName: p.displayName,
      jobTitle: p.jobTitle,
      isArtist: p.role === 'artist',
    }))
    .sort((a, b) =>
      a.isArtist === b.isArtist ? a.displayName.localeCompare(b.displayName) : a.isArtist ? -1 : 1,
    );
}

/** The preview's upload target, when the browser made one. */
async function thumbTarget(
  scope: 'artist' | 'library',
  fileId: string,
  artistId: string | undefined,
  thumb: FileRecord['thumb'],
) {
  if (!thumb) return null;
  return uploadTarget(
    quarantineKey(scope, fileId, artistId, 'thumb'),
    thumb.size,
    thumb.contentType,
  );
}

/**
 * Deletes a file: its stored object (or the quarantined upload, if the scan
 * hasn't finished) and then its record. Both buckets are versioned, so the
 * object stays recoverable by an admin until its old version expires (35 days).
 */
async function removeFile(principal: Principal, f: Stored) {
  const scope = f.scope;
  if (f.status === 'pending') {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env('QUARANTINE_BUCKET'),
        Key: quarantineKey(scope, f.fileId, f.artistId),
      }),
    );
  } else if (f.status === 'available') {
    if (scope === 'library') {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: env('LIBRARY_BUCKET'),
          Key: storedKey('library', f.fileId),
        }),
      );
    } else {
      // Artist objects are only reachable through a data-access session for that artist.
      const credentials = await sessions.credentials({
        roleArn: env('DATA_ACCESS_ROLE_ARN'),
        artistId: f.artistId!,
        role: principal.role,
      });
      await new S3Client({ credentials }).send(
        new DeleteObjectCommand({
          Bucket: env('ARTIST_BUCKET'),
          Key: storedKey('artist', f.fileId, f.artistId),
        }),
      );
    }
  }
  if (f.thumb) await removeThumb(principal, f);
  await removeVersions(principal, f);
  await db.send(new DeleteCommand({ TableName: table(), Key: { PK: f.PK, SK: f.SK } }));
}

/**
 * Earlier versions (rev 8) go with the file: their archived bytes, the
 * previews of every version, and a new version still in quarantine.
 */
async function removeVersions(principal: Principal, f: Stored) {
  const artistId = f.artistId;
  const keys: string[] = [];
  for (const v of f.versions ?? []) keys.push(archivedKey(f.scope, f.fileId, artistId, v.v));
  for (let v = 2; v <= currentVersion(f); v++) {
    keys.push(storedKey(f.scope, f.fileId, artistId, 'thumb', v));
  }
  const p = f.pendingVersion;
  if (p) {
    for (const part of ['file', 'thumb'] as const) {
      await s3
        .send(
          new DeleteObjectCommand({
            Bucket: env('QUARANTINE_BUCKET'),
            Key: quarantineKey(f.scope, f.fileId, artistId, part, p.v),
          }),
        )
        .catch(() => undefined);
    }
    keys.push(storedKey(f.scope, f.fileId, artistId, 'thumb', p.v));
  }
  if (keys.length === 0) return;
  const client =
    f.scope === 'library'
      ? s3
      : new S3Client({
          credentials: await sessions.credentials({
            roleArn: env('DATA_ACCESS_ROLE_ARN'),
            artistId: artistId!,
            role: principal.role,
          }),
        });
  const bucket = env(f.scope === 'library' ? 'LIBRARY_BUCKET' : 'ARTIST_BUCKET');
  for (const Key of keys) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key })).catch(() => undefined);
  }
}

// ── Versions (rev 8) ──────────────────────────────────────────────────────
/**
 * Starts a new version: records it as pending and returns where to upload it
 * (and its preview). It replaces the document once the malware scan is clean.
 */
async function startVersion(
  principal: Principal,
  event: APIGatewayProxyEvent,
  f: Stored,
  body: z.infer<typeof VersionUpload>,
) {
  const refused = editAllowed(principal, f);
  if (refused) throw new HttpError(403, refused);
  const blocked = versionBlocked(f);
  if (blocked) throw new HttpError(409, blocked);
  const v = nextVersion(f);
  const pending = {
    v,
    name: body.name,
    size: body.size,
    contentType: body.contentType,
    uploadedBy: principal.sub,
    createdAt: new Date().toISOString(),
    ...(body.note ? { note: body.note } : {}),
    status: 'pending' as const,
    ...(body.thumbnail ? { thumb: { status: 'pending' as const, v, ...body.thumbnail } } : {}),
  };
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: f.PK, SK: f.SK },
      UpdateExpression: 'SET pendingVersion = :p',
      // Nobody else started one in the meantime.
      ConditionExpression: f.pendingVersion
        ? 'pendingVersion.v = :was'
        : 'attribute_exists(PK) AND attribute_not_exists(pendingVersion)',
      ExpressionAttributeValues: {
        ':p': pending,
        ...(f.pendingVersion ? { ':was': f.pendingVersion.v } : {}),
      },
    }),
  );
  const artistId = f.scope === 'artist' ? f.artistId : undefined;
  const upload = await uploadTarget(
    quarantineKey(f.scope, f.fileId, artistId, 'file', v),
    body.size,
    body.contentType,
  );
  const thumbUpload = body.thumbnail
    ? await uploadTarget(
        quarantineKey(f.scope, f.fileId, artistId, 'thumb', v),
        body.thumbnail.size,
        body.thumbnail.contentType,
      )
    : null;
  await audit(event, 'file.version-requested', 'success', {
    fileId: f.fileId,
    v,
    size: body.size,
    ...(artistId ? { artistId } : { library: true }),
  });
  return {
    file: (await withThumbnails(principal, [{ ...f, pendingVersion: pending }]))[0],
    upload,
    thumbUpload,
  };
}

/**
 * POST …/versions (rev 8): either a new version to upload, or
 * `{ restoreFrom: n }` to bring back an earlier one. One route for both keeps
 * the API stack's resource count down.
 */
async function versions(principal: Principal, event: APIGatewayProxyEvent, f: Stored) {
  let raw: unknown;
  try {
    raw = JSON.parse(event.body ?? '{}');
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  if (raw && typeof raw === 'object' && 'restoreFrom' in raw) {
    const { restoreFrom } = parseBody(event, VersionRestore);
    return json(202, await restoreVersion(principal, event, f, restoreFrom));
  }
  return json(201, await startVersion(principal, event, f, parseBody(event, VersionUpload)));
}

/** Which version a download is for: the current one unless the body names another. */
function downloadVersion(event: APIGatewayProxyEvent): number | undefined {
  if (!event.body) return undefined;
  return parseBody(event, DownloadBody).v;
}

/** A short-lived link to an earlier version, named after that version's file. */
async function versionDownloadUrl(principal: Principal, f: Stored, v: number) {
  const meta = (f.versions ?? []).find((x) => x.v === v);
  if (!meta) throw new HttpError(404, 'That version is no longer kept');
  const Key = archivedKey(f.scope, f.fileId, f.artistId, v);
  const params = {
    ResponseContentDisposition: contentDisposition(meta.name, meta.contentType),
    ResponseContentType: meta.contentType,
    ResponseCacheControl: 'private, no-store',
  };
  if (f.scope === 'library') {
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: env('LIBRARY_BUCKET'), Key, ...params }),
      {
        expiresIn: URL_LIFETIME_SECONDS,
      },
    );
  }
  const credentials = await sessions.credentials(
    { roleArn: env('DATA_ACCESS_ROLE_ARN'), artistId: f.artistId!, role: principal.role },
    { minRemainingMs: (URL_LIFETIME_SECONDS + 60) * 1000 },
  );
  return getSignedUrl(
    new S3Client({ credentials }),
    new GetObjectCommand({ Bucket: env('ARTIST_BUCKET'), Key, ...params }),
    { expiresIn: URL_LIFETIME_SECONDS },
  );
}

/**
 * Restore: an earlier version becomes the newest one (nothing is lost; the
 * current version goes into the history). The copy happens in the promoter,
 * triggered by the `file.restore` event this writes.
 */
async function restoreVersion(
  principal: Principal,
  event: APIGatewayProxyEvent,
  f: Stored,
  from: number,
) {
  const refused = editAllowed(principal, f);
  if (refused) throw new HttpError(403, refused);
  const blocked = versionBlocked(f);
  if (blocked) throw new HttpError(409, blocked);
  const meta = (f.versions ?? []).find((x) => x.v === from);
  if (!meta) throw new HttpError(404, 'That version is no longer kept');
  const v = nextVersion(f);
  const pending = {
    v,
    name: meta.name,
    size: meta.size,
    contentType: meta.contentType,
    uploadedBy: principal.sub,
    createdAt: new Date().toISOString(),
    note: `Restored version ${from}`,
    status: 'pending' as const,
    restoredFrom: from,
  };
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: f.PK, SK: f.SK },
      UpdateExpression: 'SET pendingVersion = :p',
      ConditionExpression: f.pendingVersion
        ? 'pendingVersion.v = :was'
        : 'attribute_exists(PK) AND attribute_not_exists(pendingVersion)',
      ExpressionAttributeValues: {
        ':p': pending,
        ...(f.pendingVersion ? { ':was': f.pendingVersion.v } : {}),
      },
    }),
  );
  await audit(event, 'file.restore', 'success', {
    fileId: f.fileId,
    v,
    restoredFrom: from,
    ...(f.scope === 'artist' ? { artistId: f.artistId! } : { library: true }),
  });
  return (await withThumbnails(principal, [{ ...f, pendingVersion: pending }]))[0];
}

/** The preview goes with the file, wherever it is in the pipeline. */
async function removeThumb(principal: Principal, f: Stored) {
  const scope = f.scope;
  await s3
    .send(
      new DeleteObjectCommand({
        Bucket: env('QUARANTINE_BUCKET'),
        Key: quarantineKey(scope, f.fileId, f.artistId, 'thumb'),
      }),
    )
    .catch(() => undefined);
  if (scope === 'library') {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env('LIBRARY_BUCKET'),
        Key: storedKey('library', f.fileId, undefined, 'thumb'),
      }),
    );
    return;
  }
  const credentials = await sessions.credentials({
    roleArn: env('DATA_ACCESS_ROLE_ARN'),
    artistId: f.artistId!,
    role: principal.role,
  });
  await new S3Client({ credentials }).send(
    new DeleteObjectCommand({
      Bucket: env('ARTIST_BUCKET'),
      Key: storedKey('artist', f.fileId, f.artistId, 'thumb'),
    }),
  );
}

/** What the folder routes need from here (rev 10). */
const deps = { removeFile };
export type FolderDeps = typeof deps;
// ── Gig media: photos and videos added on a gig's page ─────────────────────
/**
 * The gig, if this person can open it: artists see their own gigs; Blueprint
 * sees the ones the artist shared (the same rule as the gigs API).
 */
async function loadVisibleGig(principal: Principal, artistId: string, gigId: string) {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: gigSk(gigId) } }),
  );
  const gig = res.Item as Gig | undefined;
  const d = gig
    ? authorize(principal, 'read', {
        kind: 'artist-data',
        artistId,
        visibility: gig.shared ? 'normal' : 'private',
      })
    : { allow: false };
  // Someone who can't open the gig is told it doesn't exist.
  if (!gig || !d.allow) throw new HttpError(404, 'No such gig');
  return gig;
}

/**
 * Reserves `count` numbers for this gig name, kind and day in one atomic
 * step, so uploads at the same time never get the same number.
 */
async function reserve(artistId: string, gig: Gig, kind: MediaKind, count: number) {
  const res = await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: artistPk(artistId), SK: counterSk(gig.date, gig.title, kind) },
      UpdateExpression: 'ADD #n :c SET #t = :t',
      ExpressionAttributeNames: { '#n': 'last', '#t': 'type' },
      ExpressionAttributeValues: { ':c': count, ':t': 'gig-media-counter' },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const last = Number(res.Attributes?.last);
  if (last > MAX_MEDIA_NUMBER) {
    throw new HttpError(
      409,
      `This gig has reached ${MAX_MEDIA_NUMBER} ${kind === 'img' ? 'photos' : 'videos'} for the day`,
    );
  }
  return reservedNumbers(last, count)[0]!;
}

type ArtistSpace = { kind: 'artist'; artistId: string };

/**
 * Where a gig's media lives: the day folder, if it exists yet, and whether
 * this person could add to it (Can edit on the day folder, or on the deepest
 * folder that exists, or the Library's top level, since the rest gets made).
 */
async function dayFolder(principal: Principal, artistId: string, gig: Gig) {
  const space: ArtistSpace = { kind: 'artist', artistId };
  const map = await foldersOf(artistPk(artistId));
  const names = mediaFolderPath(gig.date);
  const { found, missing } = walkFolderPath(map.values(), names);
  const deepest = found.at(-1);
  const access = deepest
    ? folderAccess(principal, deepest, map, space)
    : rootAccess(principal, map, space);
  return {
    map,
    space,
    names,
    found,
    missing,
    day: missing.length ? undefined : deepest,
    access,
  };
}

/** `GET /artists/{artistId}/files?gigId=…`: the gig's photos and videos this person can open. */
async function listGigMedia(principal: Principal, artistId: string, gigId: string) {
  if (!FILE_ID_PATTERN.test(gigId)) throw new HttpError(404, 'No such gig');
  const gig = await loadVisibleGig(principal, artistId, gigId);
  const where = await dayFolder(principal, artistId, gig);
  const visible = (await list(artistPk(artistId))).filter(
    (f) =>
      f.gig?.gigId === gig.gigId &&
      can(fileAccess(principal, f, folderManaged(f) ? where.map : NO_FOLDERS), 'view'),
  );
  return json(200, {
    folder: mediaFolderLabel(gig.date),
    folderId: where.day?.folderId ?? null,
    canAdd: can(where.access, 'edit'),
    files: await withThumbnails(
      principal,
      visible.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true })),
    ),
  });
}

/**
 * Makes the missing folders of `gigs › year › month › day`. The person needs
 * Can edit where each new folder goes, as for New folder; they own what they
 * make. Ids are fixed per path so two uploads at once share one folder.
 */
async function makeDayFolder(
  event: APIGatewayProxyEvent,
  principal: Principal,
  artistId: string,
  gig: Gig,
) {
  const pk = artistPk(artistId);
  let where = await dayFolder(principal, artistId, gig);
  for (let attempt = 0; where.missing.length && attempt < 3; attempt++) {
    if (!can(where.access, 'view') && where.found.length) {
      throw new HttpError(403, `You can’t add to ${mediaFolderLabel(gig.date)}`);
    }
    if (!can(where.access, 'edit')) {
      throw new HttpError(
        403,
        `You can’t add folders under ${where.found.at(-1)?.name ?? 'the Library'}`,
      );
    }
    let parentId = where.found.at(-1)?.folderId ?? null;
    let raced = false;
    for (const [i, name] of where.missing.entries()) {
      const path = where.names.slice(0, where.found.length + i + 1);
      // The path's fixed id first; if that's taken by a folder since renamed, a fresh one.
      const folderId = attempt === 0 ? pathFolderId(artistId, path) : newId();
      let made: string | undefined;
      try {
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: {
              PK: pk,
              SK: folderSk(folderId),
              type: 'folder',
              folderId,
              name,
              parentId,
              ownerId: principal.sub,
              ownerRole: principal.role,
              createdAt: new Date().toISOString(),
              createdBy: principal.sub,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
        made = folderId;
        await audit(event, 'folder.create', 'success', { artistId, folderId, gigMedia: true });
      } catch (e) {
        if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
        // Someone else made it a moment ago: read the folders again and carry on from there.
        raced = true;
      }
      if (raced || !made) break;
      parentId = made;
    }
    folderCache.delete(pk);
    where = await dayFolder(principal, artistId, gig);
  }
  if (!where.day) throw new HttpError(409, 'Couldn’t make the gig’s folder. Please try again.');
  if (!can(where.access, 'view')) {
    throw new HttpError(403, `You can’t add to ${mediaFolderLabel(gig.date)}`);
  }
  if (!can(where.access, 'edit')) {
    throw new HttpError(403, `You can open ${mediaFolderLabel(gig.date)} but not add to it`);
  }
  return where.day;
}

/**
 * `POST /artists/{artistId}/files` with a `gigId`: several photos and videos
 * for a gig at once. Each gets its gig name, kind and number, and its own
 * quarantine upload, scanned and kept like any other artist file.
 */
async function uploadGigMedia(
  event: APIGatewayProxyEvent,
  principal: Principal,
  artistId: string,
  show: (f: FileRecord) => unknown,
) {
  const body = parseBody(event, MediaUpload);
  const gig = await loadVisibleGig(principal, artistId, body.gigId);
  // Filed in gigs › year › month › day, made if needed; the folder's access decides (rev 10).
  const folder = await makeDayFolder(event, principal, artistId, gig);
  const counts = countByKind(body.files);
  const start: Record<MediaKind, number> = { img: 1, video: 1 };
  for (const kind of ['img', 'video'] as const) {
    if (counts[kind]) start[kind] = await reserve(artistId, gig, kind, counts[kind]);
  }
  const now = new Date().toISOString();
  const created = [];
  for (const item of numberFiles(body.files, gig.title, start)) {
    const fileId = newId();
    const rec: FileRecord = {
      fileId,
      scope: 'artist',
      artistId,
      name: item.fileName,
      ...(item.thumbnail ? { thumb: { status: 'pending' as const, ...item.thumbnail } } : {}),
      size: item.size,
      contentType: item.contentType,
      status: 'pending',
      visibility: 'normal',
      uploadedBy: principal.sub,
      uploaderRole: principal.role,
      // In a folder, a new file takes the folder's access (rev 10).
      folderId: folder.folderId,
      editAccess: 'everyone',
      gig: { gigId: gig.gigId, kind: item.kind, n: item.n },
      createdAt: now,
    };
    await createRecord(artistPk(artistId), rec);
    created.push({
      file: show(rec),
      upload: await uploadTarget(
        quarantineKey('artist', fileId, artistId),
        item.size,
        item.contentType,
      ),
      thumbUpload: await thumbTarget('artist', fileId, artistId, rec.thumb),
    });
  }
  await audit(event, 'gig.media-upload-requested', 'success', {
    artistId,
    gigId: gig.gigId,
    count: created.length,
  });
  return json(201, {
    folder: mediaFolderLabel(gig.date),
    folderId: folder.folderId,
    files: created,
  });
}

/** Whether an upload request is for gig media (it names the gig). */
function isGigUpload(event: APIGatewayProxyEvent): boolean {
  try {
    const b = JSON.parse(event.body ?? '{}') as unknown;
    return typeof b === 'object' && b !== null && 'gigId' in b;
  } catch {
    return false;
  }
}

/**
 * Files: upload (to quarantine), list, rename-free metadata, sharing, and
 * short-lived download links. The malware scan and the move to the real
 * bucket happen in files-promote, after GuardDuty reports.
 */
export const handler = handle(async (raw) => {
  const event = libraryRoute(raw);
  const principal = await principalFor(authContext(event));
  const route = `${event.httpMethod} ${event.resource}`;
  const show = (f: FileRecord) => publicFile(f, principal);
  folderCache = new Map();

  // Folders (rev 10): one proxy route per space.
  if (event.resource.startsWith('/library/folders')) {
    return folderRoutes(principal, event, { space: { kind: 'library' }, pk: LIBRARY_PK }, deps);
  }
  if (event.resource.startsWith('/artists/{artistId}/folders')) {
    const artistId = artistIdParam(event);
    ensure(canArtistSpace(principal, 'read', artistId));
    return folderRoutes(
      principal,
      event,
      { space: { kind: 'artist', artistId }, pk: artistPk(artistId) },
      deps,
    );
  }

  switch (route) {
    // ── Artist workspace files ──
    case 'GET /artists/{artistId}/files': {
      const artistId = artistIdParam(event);
      ensure(canArtistSpace(principal, 'read', artistId));
      const gigId = event.queryStringParameters?.gigId;
      if (gigId !== undefined) return listGigMedia(principal, artistId, gigId);
      const map = await foldersOf(artistPk(artistId));
      const visible = (await list(artistPk(artistId))).filter((f) =>
        can(fileAccess(principal, f, folderManaged(f) ? map : NO_FOLDERS), 'view'),
      );
      const [shown, used] = await Promise.all([
        withThumbnails(principal, visible),
        // Another artist sees only what was sent to them, not where it's used.
        principal.role === 'artist' && principal.artistId !== artistId
          ? Promise.resolve(new Set<string>())
          : inUseIds(artistId, visible),
      ]);
      return json(200, { files: shown.map((f) => ({ ...f, inUse: used.has(f.fileId) })) });
    }

    case 'POST /artists/{artistId}/files': {
      const artistId = artistIdParam(event);
      ensure(canArtistSpace(principal, 'write', artistId));
      if (isGigUpload(event)) return uploadGigMedia(event, principal, artistId, show);
      const body = parseBody(event, ArtistUpload);
      const folder = await uploadFolder(
        principal,
        artistPk(artistId),
        { kind: 'artist', artistId },
        body.folderId,
      );
      if (!visibilityAllowed(principal.role, body.visibility)) {
        throw new HttpError(
          403,
          body.visibility === 'private'
            ? 'Only the artist can upload private files'
            : 'Only Blueprint can upload BMG-only files',
        );
      }
      const fileId = newId();
      const rec: FileRecord = {
        fileId,
        scope: 'artist',
        artistId,
        name: body.name,
        ...(body.title ? { title: body.title } : {}),
        ...(body.thumbnail ? { thumb: { status: 'pending' as const, ...body.thumbnail } } : {}),
        size: body.size,
        contentType: body.contentType,
        status: 'pending',
        visibility: body.visibility,
        // Never shared back to the owner; BMG-only files are never shared with artists.
        ...(body.visibility !== 'bmg-only' &&
        body.sharedWithArtistIds.filter((id) => id !== artistId).length
          ? { sharedWithArtistIds: body.sharedWithArtistIds.filter((id) => id !== artistId) }
          : {}),
        ...(body.asset
          ? {
              asset: {
                ...body.asset,
                updatedBy: principal.sub,
                updatedAt: new Date().toISOString(),
              },
            }
          : {}),
        uploadedBy: principal.sub,
        uploaderRole: principal.role,
        // In a folder, a new file takes the folder's access (rev 10).
        ...(folder ? { folderId: folder.folderId } : {}),
        editAccess:
          body.visibility === 'private'
            ? 'owner'
            : (body.editAccess ?? (folder ? 'everyone' : defaultEditAccess('artist'))),
        createdAt: new Date().toISOString(),
      };
      if (rec.editAccess === 'chosen') {
        await checkPeople(rec, body.editorIds);
        rec.editorIds = body.editorIds;
      }
      await createRecord(artistPk(artistId), rec);
      const upload = await uploadTarget(
        quarantineKey('artist', fileId, artistId),
        body.size,
        body.contentType,
      );
      const thumbUpload = await thumbTarget('artist', fileId, artistId, rec.thumb);
      await audit(event, 'file.upload-requested', 'success', { artistId, fileId, size: body.size });
      return json(201, { file: show(rec), upload, thumbUpload });
    }

    case 'GET /artists/{artistId}/files/{fileId}': {
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      await needFile(principal, f, 'view');
      return json(200, await single(principal, event, f));
    }

    case 'PATCH /artists/{artistId}/files/{fileId}': {
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      await needFile(principal, f, 'edit');
      const patch = parseBody(event, ArtistFilePatch);
      const now = new Date().toISOString();
      const sets = ['updatedAt = :at', 'updatedBy = :by'];
      const removes: string[] = [];
      const values: Record<string, unknown> = { ':at': now, ':by': principal.sub };
      let condition = 'attribute_exists(PK)';
      if (patch.visibility !== undefined) {
        if (principal.role === 'artist') {
          throw new HttpError(403, 'Blueprint decides which of its files you can see');
        }
        if (f.uploaderRole === 'artist') {
          throw new HttpError(409, 'An artist’s own uploads always stay visible to them');
        }
        const refused = manageAllowed(principal, f);
        if (refused) throw new HttpError(403, refused);
        sets.push('visibility = :v');
        values[':v'] = patch.visibility;
        values[':private'] = 'private';
        condition += ' AND visibility <> :private';
      }
      if (patch.title !== undefined) {
        const refused = editAllowed(principal, f);
        if (refused) throw new HttpError(403, refused);
        if (patch.title) {
          sets.push('title = :t');
          values[':t'] = patch.title;
        } else removes.push('title');
      }
      if (f.visibility === 'private' && (patch.editAccess ?? 'owner') !== 'owner') {
        throw new HttpError(409, 'Only you can open a private file, so only you can edit it');
      }
      const owned = await ownerChanges(principal, f, patch);
      sets.push(...owned.sets);
      Object.assign(values, owned.values);
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: f.PK, SK: f.SK },
          UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
          ConditionExpression: condition,
          ExpressionAttributeValues: values,
        }),
      );
      if (patch.visibility !== undefined)
        await audit(
          event,
          patch.visibility === 'normal' ? 'file.share' : 'file.unshare',
          'success',
          { artistId, fileId: f.fileId },
        );
      if (patch.title !== undefined)
        await audit(event, 'file.rename', 'success', { artistId, fileId: f.fileId });
      if (owned.sets.length)
        await audit(event, 'file.access', 'success', {
          artistId,
          fileId: f.fileId,
          editAccess: owned.next.editAccess ?? editAccessOf(f),
          transferred: !!owned.next.ownerId,
        });
      const next: FileRecord = {
        ...f,
        ...owned.next,
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      };
      if (patch.title !== undefined) {
        if (patch.title) next.title = patch.title;
        else delete next.title;
      }
      return json(200, (await withThumbnails(principal, [next as Stored]))[0]);
    }

    case 'POST /artists/{artistId}/files/{fileId}/versions': {
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      await needFile(principal, f, 'edit');
      return versions(principal, event, f);
    }

    case 'PUT /artists/{artistId}/files/{fileId}/asset': {
      // Add a file to the asset library, or change its details and approvals.
      // The artist and Blueprint can both do this (design: assets are shared work).
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      await needFile(principal, f, 'edit');
      const asset = {
        ...parseBody(event, AssetMetaSchema),
        updatedBy: principal.sub,
        updatedAt: new Date().toISOString(),
      };
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: f.PK, SK: f.SK },
          UpdateExpression: 'SET asset = :a',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':a': asset },
        }),
      );
      await audit(event, 'asset.update', 'success', {
        artistId,
        fileId: f.fileId,
        approvedFor: asset.approvedFor.join(','),
      });
      return json(200, show({ ...f, asset }));
    }

    case 'DELETE /artists/{artistId}/files/{fileId}/asset': {
      // Take a file out of the asset library (the file itself stays).
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      await needFile(principal, f, 'edit');
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: f.PK, SK: f.SK },
          UpdateExpression: 'REMOVE asset',
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      const rest = { ...f };
      delete rest.asset;
      return json(200, show(rest));
    }

    case 'POST /artists/{artistId}/files/{fileId}/download': {
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      await needFile(principal, f, 'view');
      if (f.status !== 'available') throw new HttpError(409, 'This file isn’t available yet');
      const v = downloadVersion(event);
      const url =
        v && v !== currentVersion(f)
          ? await versionDownloadUrl(principal, f, v)
          : await artistDownloadUrl(principal, f);
      await audit(event, 'file.download', 'success', {
        artistId,
        fileId: f.fileId,
        ...(v ? { v } : {}),
      });
      return json(200, { url, expiresIn: URL_LIFETIME_SECONDS });
    }

    case 'DELETE /artists/{artistId}/files/{fileId}': {
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      await needFile(principal, f, 'edit');
      const refused = deleteAllowed(principal, f);
      if (refused) throw new HttpError(403, refused);
      // In use anywhere other than chat: remove it from there first (rev 8).
      const inUse = inUseMessage((await usesOf(principal, f)).all);
      if (inUse) throw new HttpError(409, inUse);
      await removeFile(principal, f);
      await audit(event, 'file.delete', 'success', { artistId, fileId: f.fileId });
      return json(200, { deleted: f.fileId });
    }

    // ── BMG document library ──
    case 'GET /library/files': {
      const map = await foldersOf(LIBRARY_PK);
      const visible = (await list(LIBRARY_PK))
        .filter((f) => can(fileAccess(principal, f, folderManaged(f) ? map : NO_FOLDERS), 'view'))
        // Artists only see files once they are ready, and never who else they're shared with.
        .filter((f) => principal.role !== 'artist' || f.status === 'available');
      const files = (await withThumbnails(principal, visible)).map((f) =>
        principal.role === 'artist' ? { ...f, sharedWithArtistIds: [] } : f,
      );
      return json(200, { files });
    }

    case 'POST /library/files': {
      ensure(authorize(principal, 'write', { kind: 'org-shared', visibility: 'bmg-only' }));
      const body = parseBody(event, LibraryUpload);
      const folder = await uploadFolder(principal, LIBRARY_PK, { kind: 'library' }, body.folderId);
      const fileId = newId();
      const rec: FileRecord = {
        fileId,
        scope: 'library',
        name: body.name,
        ...(body.title ? { title: body.title } : {}),
        ...(body.thumbnail ? { thumb: { status: 'pending' as const, ...body.thumbnail } } : {}),
        size: body.size,
        contentType: body.contentType,
        status: 'pending',
        sharing: body.sharing,
        sharedWithArtistIds: body.sharing === 'selected' ? body.sharedWithArtistIds : [],
        uploadedBy: principal.sub,
        uploaderRole: principal.role,
        // In a folder, the folder decides who can see it (rev 10).
        ...(folder ? { folderId: folder.folderId } : {}),
        editAccess: body.editAccess ?? defaultEditAccess('library'),
        createdAt: new Date().toISOString(),
      };
      if (rec.editAccess === 'chosen') {
        await checkPeople(rec, body.editorIds);
        rec.editorIds = body.editorIds;
      }
      await createRecord(LIBRARY_PK, rec);
      const upload = await uploadTarget(
        quarantineKey('library', fileId),
        body.size,
        body.contentType,
      );
      const thumbUpload = await thumbTarget('library', fileId, undefined, rec.thumb);
      await audit(event, 'file.upload-requested', 'success', {
        library: true,
        fileId,
        size: body.size,
      });
      return json(201, { file: show(rec), upload, thumbUpload });
    }

    case 'GET /library/files/{fileId}': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      await needFile(principal, f, 'view');
      return json(200, await single(principal, event, f));
    }

    case 'PATCH /library/files/{fileId}': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      await needFile(principal, f, 'edit');
      const patch = parseBody(event, LibraryPatch);
      if (patch.title !== undefined) {
        const refused = editAllowed(principal, f);
        if (refused) throw new HttpError(403, refused);
      }
      if (patch.sharing !== undefined) {
        const refused = manageAllowed(principal, f);
        if (refused) throw new HttpError(403, refused);
        if (folderManaged(f)) {
          throw new HttpError(
            409,
            'This document’s access is set in Access (rev 10), not Share with',
          );
        }
      }
      const owned = await ownerChanges(principal, f, patch);
      const sets = ['updatedAt = :at', 'updatedBy = :by'];
      const removes: string[] = [];
      const values: Record<string, unknown> = {
        ':at': new Date().toISOString(),
        ':by': principal.sub,
      };
      const ids = patch.sharing === 'selected' ? patch.sharedWithArtistIds : [];
      if (patch.sharing !== undefined) {
        sets.push('sharing = :s', 'sharedWithArtistIds = :ids');
        values[':s'] = patch.sharing;
        values[':ids'] = ids;
      }
      if (patch.title !== undefined) {
        if (patch.title) {
          sets.push('title = :t');
          values[':t'] = patch.title;
        } else removes.push('title');
      }
      sets.push(...owned.sets);
      Object.assign(values, owned.values);
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: f.PK, SK: f.SK },
          UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: values,
        }),
      );
      if (owned.sets.length)
        await audit(event, 'file.access', 'success', {
          library: true,
          fileId: f.fileId,
          editAccess: owned.next.editAccess ?? editAccessOf(f),
          transferred: !!owned.next.ownerId,
        });
      if (patch.sharing !== undefined)
        await audit(event, 'file.share', 'success', {
          library: true,
          fileId: f.fileId,
          sharing: patch.sharing,
          artists: ids.length,
        });
      if (patch.title !== undefined)
        await audit(event, 'file.rename', 'success', { library: true, fileId: f.fileId });
      const next: FileRecord = {
        ...f,
        ...owned.next,
        ...(patch.sharing !== undefined
          ? { sharing: patch.sharing, sharedWithArtistIds: ids }
          : {}),
      };
      if (patch.title !== undefined) {
        if (patch.title) next.title = patch.title;
        else delete next.title;
      }
      return json(200, (await withThumbnails(principal, [next as Stored]))[0]);
    }

    case 'POST /library/files/{fileId}/versions': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      await needFile(principal, f, 'edit');
      return versions(principal, event, f);
    }

    case 'POST /library/files/{fileId}/download': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      await needFile(principal, f, 'view');
      if (f.status !== 'available') throw new HttpError(409, 'This file isn’t available yet');
      const v = downloadVersion(event);
      const url =
        v && v !== currentVersion(f)
          ? await versionDownloadUrl(principal, f, v)
          : await libraryDownloadUrl(f);
      await audit(event, 'file.download', 'success', {
        library: true,
        fileId: f.fileId,
        ...(v ? { v } : {}),
      });
      return json(200, { url, expiresIn: URL_LIFETIME_SECONDS });
    }

    case 'DELETE /library/files/{fileId}': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      await needFile(principal, f, 'edit');
      const refused = deleteAllowed(principal, f);
      if (refused) throw new HttpError(403, refused);
      const inUse = inUseMessage((await usesOf(principal, f)).all);
      if (inUse) throw new HttpError(409, inUse);
      await removeFile(principal, f);
      await audit(event, 'file.delete', 'success', { library: true, fileId: f.fileId });
      return json(200, { deleted: f.fileId });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
