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
import { authorize, type Action, type Principal } from '@bmg/authz';
import { DataAccessSessions, isArtistId } from '@bmg/crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  ArtistFilePatch,
  AssetMetaSchema,
  ArtistUpload,
  contentDisposition,
  deleteAllowed,
  FILE_ID_PATTERN,
  fileSk,
  LIBRARY_PK,
  LibraryPatch,
  LibraryUpload,
  librarySharing,
  PENDING_TTL_SECONDS,
  publicFile,
  quarantineKey,
  storedKey,
  URL_LIFETIME_SECONDS,
  visibilityAllowed,
  type FileRecord,
} from '../files/model.ts';
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

function canArtistFile(principal: Principal, action: Action, artistId: string, f?: FileRecord) {
  return authorize(principal, action, {
    kind: 'artist-data',
    artistId,
    visibility: f?.visibility ?? 'normal',
  });
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
  await db.send(new DeleteCommand({ TableName: table(), Key: { PK: f.PK, SK: f.SK } }));
}

/** A file attached to a submission that is still waiting for review can't be deleted. */
async function attachedToOpenSubmission(artistId: string, fileId: string): Promise<boolean> {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':pk': artistPk(artistId), ':s': 'SUB#' },
      ProjectionExpression: '#st, fileIds',
      ExpressionAttributeNames: { '#st': 'status' },
      Limit: 300,
    }),
  );
  return (res.Items ?? []).some(
    (s) => s.status === 'open' && ((s.fileIds as string[] | undefined) ?? []).includes(fileId),
  );
}

/**
 * Files: upload (to quarantine), list, rename-free metadata, sharing, and
 * short-lived download links. The malware scan and the move to the real
 * bucket happen in files-promote, after GuardDuty reports.
 */
export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const route = `${event.httpMethod} ${event.resource}`;
  const show = (f: FileRecord) => publicFile(f, principal.sub);

  switch (route) {
    // ── Artist workspace files ──
    case 'GET /artists/{artistId}/files': {
      const artistId = artistIdParam(event);
      ensure(canArtistFile(principal, 'read', artistId));
      const files = (await list(artistPk(artistId)))
        .filter((f) => canArtistFile(principal, 'read', artistId, f).allow)
        .map(show);
      return json(200, { files });
    }

    case 'POST /artists/{artistId}/files': {
      const artistId = artistIdParam(event);
      ensure(canArtistFile(principal, 'write', artistId));
      const body = parseBody(event, ArtistUpload);
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
        size: body.size,
        contentType: body.contentType,
        status: 'pending',
        visibility: body.visibility,
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
        createdAt: new Date().toISOString(),
      };
      await createRecord(artistPk(artistId), rec);
      const upload = await uploadTarget(
        quarantineKey('artist', fileId, artistId),
        body.size,
        body.contentType,
      );
      await audit(event, 'file.upload-requested', 'success', { artistId, fileId, size: body.size });
      return json(201, { file: show(rec), upload });
    }

    case 'GET /artists/{artistId}/files/{fileId}': {
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      ensure(canArtistFile(principal, 'read', artistId, f));
      return json(200, show(f));
    }

    case 'PATCH /artists/{artistId}/files/{fileId}': {
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      ensure(canArtistFile(principal, 'write', artistId, f));
      const patch = parseBody(event, ArtistFilePatch);
      if (principal.role === 'artist') {
        throw new HttpError(403, 'Blueprint decides which of its files you can see');
      }
      if (f.uploaderRole === 'artist') {
        throw new HttpError(409, 'An artist’s own uploads always stay visible to them');
      }
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: f.PK, SK: f.SK },
          UpdateExpression: 'SET visibility = :v, updatedAt = :at, updatedBy = :by',
          ConditionExpression: 'attribute_exists(PK) AND visibility <> :private',
          ExpressionAttributeValues: {
            ':v': patch.visibility,
            ':private': 'private',
            ':at': new Date().toISOString(),
            ':by': principal.sub,
          },
        }),
      );
      await audit(event, patch.visibility === 'normal' ? 'file.share' : 'file.unshare', 'success', {
        artistId,
        fileId: f.fileId,
      });
      return json(200, show({ ...f, visibility: patch.visibility }));
    }

    case 'PUT /artists/{artistId}/files/{fileId}/asset': {
      // Add a file to the asset library, or change its details and approvals.
      // The artist and Blueprint can both do this (design: assets are shared work).
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      ensure(canArtistFile(principal, 'write', artistId, f));
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
      ensure(canArtistFile(principal, 'write', artistId, f));
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
      ensure(canArtistFile(principal, 'read', artistId, f));
      if (f.status !== 'available') throw new HttpError(409, 'This file isn’t available yet');
      const url = await artistDownloadUrl(principal, f);
      await audit(event, 'file.download', 'success', { artistId, fileId: f.fileId });
      return json(200, { url, expiresIn: URL_LIFETIME_SECONDS });
    }

    case 'DELETE /artists/{artistId}/files/{fileId}': {
      const artistId = artistIdParam(event);
      const f = await load(artistPk(artistId), fileIdParam(event));
      ensure(canArtistFile(principal, 'write', artistId, f));
      const refused = deleteAllowed(principal, f);
      if (refused) throw new HttpError(403, refused);
      if (await attachedToOpenSubmission(artistId, f.fileId)) {
        throw new HttpError(409, 'This file is attached to a submission waiting for review');
      }
      await removeFile(principal, f);
      await audit(event, 'file.delete', 'success', { artistId, fileId: f.fileId });
      return json(200, { deleted: f.fileId });
    }

    // ── BMG document library ──
    case 'GET /library/files': {
      const files = (await list(LIBRARY_PK))
        .filter((f) => authorize(principal, 'read', librarySharing(f)).allow)
        // Artists only see files once they are ready, and never who else they're shared with.
        .filter((f) => principal.role !== 'artist' || f.status === 'available')
        .map(show)
        .map((f) => (principal.role === 'artist' ? { ...f, sharedWithArtistIds: [] } : f));
      return json(200, { files });
    }

    case 'POST /library/files': {
      ensure(authorize(principal, 'write', { kind: 'org-shared', visibility: 'bmg-only' }));
      const body = parseBody(event, LibraryUpload);
      const fileId = newId();
      const rec: FileRecord = {
        fileId,
        scope: 'library',
        name: body.name,
        size: body.size,
        contentType: body.contentType,
        status: 'pending',
        sharing: body.sharing,
        sharedWithArtistIds: body.sharing === 'selected' ? body.sharedWithArtistIds : [],
        uploadedBy: principal.sub,
        uploaderRole: principal.role,
        createdAt: new Date().toISOString(),
      };
      await createRecord(LIBRARY_PK, rec);
      const upload = await uploadTarget(
        quarantineKey('library', fileId),
        body.size,
        body.contentType,
      );
      await audit(event, 'file.upload-requested', 'success', {
        library: true,
        fileId,
        size: body.size,
      });
      return json(201, { file: show(rec), upload });
    }

    case 'GET /library/files/{fileId}': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      ensure(authorize(principal, 'read', librarySharing(f)));
      return json(200, show(f));
    }

    case 'PATCH /library/files/{fileId}': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      ensure(authorize(principal, 'write', librarySharing(f)));
      const patch = parseBody(event, LibraryPatch);
      const ids = patch.sharing === 'selected' ? patch.sharedWithArtistIds : [];
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: f.PK, SK: f.SK },
          UpdateExpression:
            'SET sharing = :s, sharedWithArtistIds = :ids, updatedAt = :at, updatedBy = :by',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ':s': patch.sharing,
            ':ids': ids,
            ':at': new Date().toISOString(),
            ':by': principal.sub,
          },
        }),
      );
      await audit(event, 'file.share', 'success', {
        library: true,
        fileId: f.fileId,
        sharing: patch.sharing,
        artists: ids.length,
      });
      return json(200, show({ ...f, sharing: patch.sharing, sharedWithArtistIds: ids }));
    }

    case 'POST /library/files/{fileId}/download': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      ensure(authorize(principal, 'read', librarySharing(f)));
      if (f.status !== 'available') throw new HttpError(409, 'This file isn’t available yet');
      const url = await libraryDownloadUrl(f);
      await audit(event, 'file.download', 'success', { library: true, fileId: f.fileId });
      return json(200, { url, expiresIn: URL_LIFETIME_SECONDS });
    }

    case 'DELETE /library/files/{fileId}': {
      const f = await load(LIBRARY_PK, fileIdParam(event));
      ensure(authorize(principal, 'write', librarySharing(f)));
      const refused = deleteAllowed(principal, f);
      if (refused) throw new HttpError(403, refused);
      await removeFile(principal, f);
      await audit(event, 'file.delete', 'success', { library: true, fileId: f.fileId });
      return json(200, { deleted: f.fileId });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
