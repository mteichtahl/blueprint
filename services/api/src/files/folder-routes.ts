/**
 * Folder routes (rev 10), one proxy route per space, served by the files
 * function:
 *
 *   GET    {space}/folders                 every folder this person can see
 *   POST   {space}/folders                 new folder { name, parentId }
 *   PATCH  {space}/folders/{folderId}      rename { name }
 *   DELETE {space}/folders/{folderId}      delete it and everything inside
 *   POST   {space}/folders/move            { items, to, preview }
 *   GET    {space}/folders/access          ?kind=folder|file&id=…  the Access panel
 *   PUT    {space}/folders/access          { item, grants, inherit, pushDown, preview }
 *   GET    {space}/folders/check           ?kind=…&id=…&sub=…  "Check someone's access"
 *
 * `{space}` is `/library` or `/artists/{artistId}`. Nothing moves between
 * spaces: each artist's files are encrypted under their own key.
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Principal } from '@bmg/authz';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { audit, db, env, HttpError, json, parseBody } from '../lib.ts';
import { newId } from '../workspace/model.ts';
import { can, entriesFor, fileAccess, folderAccess, rootAccess, type Viewer } from './access.ts';
import { loadAllFiles, loadFolders, type StoredFile, type StoredFolder } from './folder-store.ts';
import {
  AccessBody,
  ancestors,
  cleanGrants,
  compareAccess,
  descendants,
  FOLDER_ID_PATTERN,
  folderManaged,
  folderMap,
  FolderCreate,
  FolderRename,
  folderSk,
  inheritedGrants,
  isInside,
  keyAllowed,
  legacyLibraryGrants,
  MoveBody,
  nameTaken,
  type Access,
  type FolderMap,
  type FolderRecord,
  type GrantKey,
  type Grants,
  type Item,
  type Level,
  type Space,
} from './folders.ts';
import { deleteAllowed, fileSk, inUseMessage, manageAllowed, type FileRecord } from './model.ts';
import { people, type Person } from './people.ts';
import { usesOf } from './usage.ts';

export interface SpaceCtx {
  space: Space;
  pk: string;
}

/** What the files function lends the folder routes. */
export interface Deps {
  removeFile: (principal: Principal, f: StoredFile) => Promise<void>;
}

const table = () => env('MAIN_TABLE');

// ── People and names ──────────────────────────────────────────────────────
const asViewer = (p: Person): Viewer => ({
  sub: p.sub,
  role: p.role,
  ...(p.artistId ? { artistId: p.artistId } : {}),
  ...(p.assignedArtistIds ? { assignedArtistIds: p.assignedArtistIds } : {}),
  mfaSatisfied: true,
});

/** Who could have access in this space (for summaries and the picker). */
function inSpace(space: Space, all: Person[]): Person[] {
  if (space.kind === 'library') return all;
  return all.filter((p) =>
    p.role === 'artist'
      ? p.artistId === space.artistId
      : p.role === 'bmg-admin' || (p.assignedArtistIds ?? []).includes(space.artistId),
  );
}

const GROUP_LABEL: Record<string, string> = {
  'g:team': 'Blueprint team',
  'g:admins': 'Blueprint admins',
  'g:artists': 'All artists',
};

function labeller(all: Person[]) {
  const bySub = new Map(all.map((p) => [p.sub, p]));
  const byArtist = new Map(all.filter((p) => p.artistId).map((p) => [p.artistId!, p]));
  return (key: GrantKey): string => {
    if (GROUP_LABEL[key]) return GROUP_LABEL[key]!;
    if (key.startsWith('a:')) return byArtist.get(key.slice(2))?.displayName ?? 'Artist';
    return bySub.get(key.slice(2))?.displayName ?? 'Former member';
  };
}

// ── Items ─────────────────────────────────────────────────────────────────
type Ref = { kind: 'file' | 'folder'; id: string };
type Loaded = { kind: 'folder'; folder: StoredFolder } | { kind: 'file'; file: StoredFile };

const asItem = (it: Loaded): Item =>
  it.kind === 'folder' ? { kind: 'folder', folder: it.folder } : { kind: 'file', file: it.file };

function accessOf(p: Viewer, it: Loaded | Item, map: FolderMap, space: Space): Access {
  return it.kind === 'folder'
    ? folderAccess(p, it.folder, map, space)
    : fileAccess(p, it.file as FileRecord, map);
}

async function loadItem(ctx: SpaceCtx, map: FolderMap, ref: Ref): Promise<Loaded> {
  if (ref.kind === 'folder') {
    const folder = map.get(ref.id) as StoredFolder | undefined;
    if (!folder) throw new HttpError(404, 'No such folder');
    return { kind: 'folder', folder };
  }
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: ctx.pk, SK: fileSk(ref.id) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such file');
  return { kind: 'file', file: res.Item as StoredFile };
}

const nameOf = (it: Loaded) =>
  it.kind === 'folder' ? it.folder.name : it.file.title || it.file.name;

function refFromQuery(event: APIGatewayProxyEvent): Ref {
  const q = event.queryStringParameters ?? {};
  const kind = q.kind === 'file' ? 'file' : q.kind === 'folder' ? 'folder' : undefined;
  if (!kind || !FOLDER_ID_PATTERN.test(q.id ?? ''))
    throw new HttpError(400, 'Say which folder or file');
  return { kind, id: q.id! };
}

/** Refuses with "not found" when the person can't even see it, so names never leak. */
function need(a: Access, min: Exclude<Level, 'none'>, what: 'folder' | 'file') {
  if (!can(a, 'view')) throw new HttpError(404, `No such ${what}`);
  if (!can(a, min)) {
    throw new HttpError(
      403,
      min === 'manage'
        ? `You can’t change who can open this ${what}`
        : `You can open this ${what} but not change it`,
    );
  }
}

/** The folders and files inside a folder, at any depth (and the folder itself). */
function subtree(folders: StoredFolder[], files: StoredFile[], root: StoredFolder) {
  const inner = [root, ...descendants(folders, root.folderId)] as StoredFolder[];
  const ids = new Set(inner.map((f) => f.folderId));
  return { folders: inner, files: files.filter((f) => f.folderId && ids.has(f.folderId)) };
}

// ── What a folder looks like to the app ───────────────────────────────────
function shown(
  p: Viewer,
  f: FolderRecord,
  map: FolderMap,
  space: Space,
  visible: Set<string>,
  names: Map<string, Person>,
) {
  const parentShown = !!f.parentId && visible.has(f.parentId);
  return {
    folderId: f.folderId,
    name: f.name,
    /** null at the top, or when the parent is one this person can't open. */
    parentId: parentShown ? f.parentId : null,
    /** Given access deeper than its parents (3.4): shown under "Shared with me". */
    sharedWithMe: !!f.parentId && !parentShown,
    /** The path from the top; folders this person can't open are null ("…"). */
    path: ancestors(map, f.parentId)
      .reverse()
      .map((a) => (visible.has(a.folderId) ? { folderId: a.folderId, name: a.name } : null)),
    level: folderAccess(p, f, map, space).level,
    customAccess: !!f.grants || f.inherit === false,
    ownerId: f.ownerId,
    ownerName:
      names.get(f.ownerId)?.displayName ?? (f.ownerRole === 'artist' ? 'Artist' : 'Blueprint'),
    ownedByMe: f.ownerId === p.sub,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt ?? f.createdAt,
  };
}

/** Lets the artist's knowledge base catch up after access or location changes (design 10.3). */
async function resync(event: APIGatewayProxyEvent, space: Space, files: FileRecord[]) {
  if (space.kind !== 'artist') return;
  for (const f of files) {
    await audit(event, 'file.share', 'success', {
      artistId: space.artistId,
      fileId: f.fileId,
      folders: true,
    });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────
export async function folderRoutes(
  principal: Principal,
  event: APIGatewayProxyEvent,
  ctx: SpaceCtx,
  deps: Deps,
): Promise<APIGatewayProxyResult> {
  const rest = (event.pathParameters?.proxy ?? '').replace(/\/+$/, '');
  const method = event.httpMethod;
  const { space } = ctx;
  const folders = await loadFolders(ctx.pk);
  const map = folderMap(folders);
  const where: Record<string, string | boolean> =
    space.kind === 'library' ? { library: true } : { artistId: space.artistId };

  // ── List ──
  if (method === 'GET' && rest === '') {
    const all = await people().catch(() => [] as Person[]);
    const names = new Map(all.map((p) => [p.sub, p]));
    const visible = folders.filter((f) => can(folderAccess(principal, f, map, space), 'view'));
    const ids = new Set(visible.map((f) => f.folderId));
    return json(200, {
      root: { level: rootAccess(principal, map, space).level },
      folders: visible
        .map((f) => shown(principal, f, map, space, ids, names))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    });
  }

  // ── Create ──
  if (method === 'POST' && rest === '') {
    const body = parseBody(event, FolderCreate);
    if (body.parentId) {
      const parent = map.get(body.parentId);
      if (!parent) throw new HttpError(404, 'No such folder');
      need(folderAccess(principal, parent, map, space), 'edit', 'folder');
    } else if (!can(rootAccess(principal, map, space), 'edit')) {
      throw new HttpError(403, 'You can’t add folders here');
    }
    if (nameTaken(folders, body.parentId, body.name)) {
      throw new HttpError(409, 'There’s already a folder with that name here');
    }
    const now = new Date().toISOString();
    const folder: FolderRecord = {
      folderId: newId(),
      name: body.name,
      parentId: body.parentId,
      ownerId: principal.sub,
      ownerRole: principal.role,
      createdAt: now,
      createdBy: principal.sub,
    };
    await db.send(
      new PutCommand({
        TableName: table(),
        Item: { PK: ctx.pk, SK: folderSk(folder.folderId), type: 'folder', ...folder },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    await audit(event, 'folder.create', 'success', { ...where, folderId: folder.folderId });
    const next = new Map(map).set(folder.folderId, folder);
    const ids = new Set(
      [...next.values()]
        .filter((f) => can(folderAccess(principal, f, next, space), 'view'))
        .map((f) => f.folderId),
    );
    return json(201, shown(principal, folder, next, space, ids, new Map()));
  }

  // ── Move ──
  if (method === 'POST' && rest === 'move') {
    const body = parseBody(event, MoveBody);
    const to = body.to;
    if (to) {
      const dest = map.get(to);
      if (!dest) throw new HttpError(404, 'No such folder');
      need(folderAccess(principal, dest, map, space), 'edit', 'folder');
    } else if (!can(rootAccess(principal, map, space), 'edit')) {
      throw new HttpError(403, 'You can’t move things here');
    }
    const items = await Promise.all(body.items.map((r) => loadItem(ctx, map, r)));
    const files = await loadAllFiles(ctx.pk);
    const nextMap = new Map(map);
    const movedFiles = new Map<string, StoredFile>();
    const affected: { before: Item; afterId: Ref }[] = [];
    for (const it of items) {
      const a = accessOf(principal, it, map, space);
      if (it.kind === 'folder') {
        need(a, 'manage', 'folder');
        if (to && isInside(map, to, it.folder.folderId)) {
          throw new HttpError(409, 'A folder can’t go inside itself');
        }
        if (nameTaken(nextMap.values(), to, it.folder.name, it.folder.folderId)) {
          throw new HttpError(409, `There’s already a folder called “${it.folder.name}” there`);
        }
        nextMap.set(it.folder.folderId, { ...it.folder, parentId: to });
        const sub = subtree(folders, files, it.folder);
        for (const f of sub.folders)
          affected.push({
            before: { kind: 'folder', folder: f },
            afterId: { kind: 'folder', id: f.folderId },
          });
        for (const f of sub.files)
          affected.push({
            before: { kind: 'file', file: f },
            afterId: { kind: 'file', id: f.fileId },
          });
      } else {
        // Moving a file: full access to it, or the rev 8 right to manage it.
        if (!(a.level === 'manage' || (can(a, 'edit') && !manageAllowed(principal, it.file)))) {
          need(a, 'manage', 'file');
        }
        const f = it.file;
        const grants =
          !folderManaged(f) && f.scope === 'library' ? legacyLibraryGrants(f) : f.grants;
        const moved: StoredFile = { ...f, ...(grants ? { grants } : {}) };
        if (to) moved.folderId = to;
        else delete moved.folderId;
        movedFiles.set(f.fileId, moved);
        affected.push({
          before: { kind: 'file', file: f },
          afterId: { kind: 'file', id: f.fileId },
        });
      }
    }
    // Files inside moved folders stay where they are, in the moved folder.
    const after = (r: Ref): Item =>
      r.kind === 'folder'
        ? { kind: 'folder', folder: nextMap.get(r.id)! }
        : { kind: 'file', file: movedFiles.get(r.id) ?? files.find((f) => f.fileId === r.id)! };
    const all = await people().catch(() => [] as Person[]);
    const changes = compareAccess(
      inSpace(space, all),
      affected.map((a) => ({ before: a.before, after: after(a.afterId) })),
      {
        before: (p, it) => accessOf(asViewer(p), it, map, space).level,
        after: (p, it) => accessOf(asViewer(p), it, nextMap, space).level,
      },
    );
    const names = new Map(all.map((p) => [p.sub, p.displayName]));
    const summary = {
      items: affected.length,
      changes: changes.map((c) => ({ ...c, name: names.get(c.sub) ?? 'Someone' })),
    };
    if (body.preview) return json(200, summary);

    const now = new Date().toISOString();
    for (const it of items) {
      if (it.kind === 'folder') {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: ctx.pk, SK: folderSk(it.folder.folderId) },
            UpdateExpression: 'SET parentId = :p, updatedAt = :at, updatedBy = :by',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':p': to, ':at': now, ':by': principal.sub },
          }),
        );
      }
    }
    for (const f of movedFiles.values()) {
      const values: Record<string, unknown> = { ':at': now, ':by': principal.sub };
      const sets = ['updatedAt = :at', 'updatedBy = :by'];
      if (to) {
        sets.push('folderId = :f');
        values[':f'] = to;
      }
      if (f.grants) {
        sets.push('grants = :g');
        values[':g'] = f.grants;
      }
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: ctx.pk, SK: fileSk(f.fileId) },
          UpdateExpression: `SET ${sets.join(', ')}${to ? '' : ' REMOVE folderId'}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: values,
        }),
      );
    }
    await audit(event, 'folder.move', 'success', {
      ...where,
      to: to ?? 'top',
      items: items.length,
      gains: changes.reduce((n, c) => n + c.gains, 0),
      losses: changes.reduce((n, c) => n + c.loses, 0),
    });
    await resync(
      event,
      space,
      affected.flatMap((a) => (a.before.kind === 'file' ? [a.before.file as FileRecord] : [])),
    );
    return json(200, { moved: items.length, ...summary });
  }

  // ── Access panel ──
  if (rest === 'access' && method === 'GET') {
    const it = await loadItem(ctx, map, refFromQuery(event));
    const a = accessOf(principal, it, map, space);
    need(a, 'view', it.kind);
    const all = await people().catch(() => [] as Person[]);
    const label = labeller(all);
    const manage = can(a, 'manage');
    const node = it.kind === 'folder' ? it.folder : it.file;
    const legacy = it.kind === 'file' && !folderManaged(it.file);
    let entries = legacy ? [] : entriesFor(asItem(it), map, space);
    // Only people who manage it see everyone; others see the groups and themselves.
    if (!manage) {
      entries = entries.filter(
        (e) =>
          e.key.startsWith('g:') ||
          e.key === `p:${principal.sub}` ||
          e.key === `a:${principal.artistId}`,
      );
    }
    const people_ = inSpace(space, all);
    const candidates = manage
      ? [
          ...(Object.keys(GROUP_LABEL) as GrantKey[]).filter((k) => keyAllowed(space, k)),
          ...people_
            .filter((p) => p.role === 'artist' && space.kind === 'library' && p.artistId)
            .map((p) => `a:${p.artistId}` as GrantKey),
          ...people_.filter((p) => p.role !== 'artist').map((p) => `p:${p.sub}` as GrantKey),
        ]
          .filter((k, i, all_) => all_.indexOf(k) === i)
          .map((key) => ({
            key,
            label: label(key),
            detail: key.startsWith('g:')
              ? 'Group'
              : key.startsWith('a:')
                ? 'Artist'
                : (all.find((p) => p.sub === key.slice(2))?.jobTitle ?? ''),
          }))
      : [];
    return json(200, {
      item: {
        kind: it.kind,
        id: it.kind === 'folder' ? it.folder.folderId : it.file.fileId,
        name: nameOf(it),
      },
      level: a.level,
      canManage: manage,
      /** A file not in a folder yet still uses rev 8 sharing; settings start when it's moved or set. */
      legacySharing: legacy,
      inherit: node.inherit !== false,
      entries: entries.map((e) => ({ ...e, label: label(e.key) })),
      candidates,
    });
  }

  if (rest === 'access' && method === 'PUT') {
    const body = parseBody(event, AccessBody);
    const it = await loadItem(ctx, map, body.item);
    need(accessOf(principal, it, map, space), 'manage', it.kind);
    const all = await people().catch(() => [] as Person[]);
    // Check who's named: groups this space allows, real artists, Blueprint people.
    for (const key of Object.keys(body.grants ?? {}) as GrantKey[]) {
      if (!keyAllowed(space, key)) {
        throw new HttpError(
          400,
          space.kind === 'artist'
            ? 'Only Blueprint can be given access here; the artist always has it'
            : 'That can’t be given access here',
        );
      }
      if (key.startsWith('a:') && !all.some((p) => p.artistId === key.slice(2))) {
        throw new HttpError(400, 'Unknown artist');
      }
      if (key.startsWith('p:') && !all.some((p) => p.sub === key.slice(2) && p.role !== 'artist')) {
        throw new HttpError(400, 'Unknown person');
      }
    }
    const node = it.kind === 'folder' ? it.folder : it.file;
    const item = asItem(it);
    // "Don't inherit": copy in what reaches it now, so nothing changes until edited.
    let grants: Grants = { ...(node.grants ?? {}) };
    let inherit = node.inherit !== false;
    if (body.inherit === false && inherit) {
      grants = { ...inheritedGrants(item, map, space), ...grants };
      inherit = false;
    } else if (body.inherit === true) {
      inherit = true;
    }
    if (it.kind === 'file' && !folderManaged(it.file) && it.file.scope === 'library') {
      grants = { ...(legacyLibraryGrants(it.file) ?? {}), ...grants };
    }
    for (const [k, l] of Object.entries(body.grants ?? {}) as [GrantKey, Level | null][]) {
      if (l === null) delete grants[k];
      else grants[k] = l;
    }
    const cleaned = cleanGrants(space, grants);
    const changed = Object.keys(body.grants ?? {}) as GrantKey[];

    // The new state, and what's inside it.
    const files = it.kind === 'folder' ? await loadAllFiles(ctx.pk) : [];
    const inner =
      it.kind === 'folder' ? subtree(folders, files, it.folder) : { folders: [], files: [] };
    const nextMap = new Map(map);
    const nextFiles = new Map<string, StoredFile>();
    const strip = <T extends { grants?: Grants }>(n: T): T => {
      if (body.pushDown !== 'replace' || !n.grants) return n;
      const g = { ...n.grants };
      for (const k of changed) delete g[k];
      const rest_ = { ...n };
      if (Object.keys(g).length) rest_.grants = g;
      else delete rest_.grants;
      return rest_;
    };
    const withNode = <T extends AccessLike>(n: T): T => {
      const out = { ...n, inherit } as T;
      if (cleaned) out.grants = cleaned;
      else delete out.grants;
      if (inherit) delete out.inherit;
      return out;
    };
    if (it.kind === 'folder') {
      nextMap.set(it.folder.folderId, withNode(it.folder));
      for (const f of inner.folders.slice(1)) nextMap.set(f.folderId, strip(f));
      for (const f of inner.files) nextFiles.set(f.fileId, strip(f));
    } else {
      nextFiles.set(it.file.fileId, withNode(it.file));
    }
    const affected: { before: Item; after: Item }[] = [
      ...inner.folders.map((f) => ({
        before: { kind: 'folder' as const, folder: f },
        after: { kind: 'folder' as const, folder: nextMap.get(f.folderId)! },
      })),
      ...(it.kind === 'file' ? [it.file] : inner.files).map((f) => ({
        before: { kind: 'file' as const, file: f },
        after: { kind: 'file' as const, file: nextFiles.get(f.fileId)! },
      })),
    ];
    const changes = compareAccess(inSpace(space, all), affected, {
      before: (p, x) => accessOf(asViewer(p), x, map, space).level,
      after: (p, x) => accessOf(asViewer(p), x, nextMap, space).level,
    });
    const names = new Map(all.map((p) => [p.sub, p.displayName]));
    const afterItem: Item =
      it.kind === 'folder'
        ? { kind: 'folder', folder: nextMap.get(it.folder.folderId)! }
        : { kind: 'file', file: nextFiles.get(it.file.fileId)! };
    const summary = {
      files: affected.filter((a) => a.before.kind === 'file').length,
      changes: changes.map((c) => ({ ...c, name: names.get(c.sub) ?? 'Someone' })),
      /** Saving would take away this person's own right to manage it (shown as a warning). */
      youLoseManage: !can(accessOf(principal, afterItem, nextMap, space), 'manage'),
      /** Deeper items with their own setting for the people being changed (the push-down question). */
      deeperOverrides:
        it.kind === 'folder'
          ? [...inner.folders.slice(1), ...inner.files].filter((n) =>
              changed.some((k) => n.grants && k in n.grants),
            ).length
          : 0,
    };
    if (body.preview) return json(200, summary);

    const now = new Date().toISOString();
    const write = async (sk: string, n: AccessLike) =>
      db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: ctx.pk, SK: sk },
          UpdateExpression: `SET updatedAt = :at, updatedBy = :by${n.grants ? ', grants = :g' : ''}${n.inherit === false ? ', inherit = :i' : ''}${
            [!n.grants && 'grants', n.inherit !== false && 'inherit'].filter(Boolean).length
              ? ` REMOVE ${[!n.grants && 'grants', n.inherit !== false && 'inherit'].filter(Boolean).join(', ')}`
              : ''
          }`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ':at': now,
            ':by': principal.sub,
            ...(n.grants ? { ':g': n.grants } : {}),
            ...(n.inherit === false ? { ':i': false } : {}),
          },
        }),
      );
    if (it.kind === 'folder') {
      await write(folderSk(it.folder.folderId), nextMap.get(it.folder.folderId)!);
      if (body.pushDown === 'replace') {
        for (const f of inner.folders.slice(1)) {
          if (changed.some((k) => f.grants && k in f.grants))
            await write(folderSk(f.folderId), nextMap.get(f.folderId)!);
        }
        for (const f of inner.files) {
          if (changed.some((k) => f.grants && k in f.grants))
            await write(fileSk(f.fileId), nextFiles.get(f.fileId)!);
        }
      }
    } else {
      await write(fileSk(it.file.fileId), nextFiles.get(it.file.fileId)!);
    }
    await audit(event, it.kind === 'folder' ? 'folder.access' : 'file.access', 'success', {
      ...where,
      [it.kind === 'folder' ? 'folderId' : 'fileId']:
        it.kind === 'folder' ? it.folder.folderId : it.file.fileId,
      settings: Object.keys(cleaned ?? {}).length,
      inherit,
      pushDown: body.pushDown,
      gains: changes.reduce((n, c) => n + c.gains, 0),
      losses: changes.reduce((n, c) => n + c.loses, 0),
    });
    await resync(event, space, it.kind === 'file' ? [it.file] : inner.files);
    return json(200, { saved: true, ...summary });
  }

  // ── Check someone's access ──
  if (rest === 'check' && method === 'GET') {
    const it = await loadItem(ctx, map, refFromQuery(event));
    need(accessOf(principal, it, map, space), 'manage', it.kind);
    const sub = event.queryStringParameters?.sub ?? '';
    const all = await people().catch(() => [] as Person[]);
    const person = all.find((p) => p.sub === sub);
    if (!person) throw new HttpError(404, 'No such person');
    const a = accessOf(asViewer(person), it, map, space);
    const label = labeller(all);
    const chain =
      it.kind === 'folder'
        ? [it.folder, ...ancestors(map, it.folder.parentId)]
        : [it.file, ...ancestors(map, it.file.folderId)];
    const at = (i: number) =>
      i === 0 ? `this ${it.kind}` : `“${(chain[i] as FolderRecord).name}”`;
    const why = a.why;
    const because =
      it.kind === 'file' && !folderManaged(it.file)
        ? 'this file isn’t in a folder yet, so its own sharing decides'
        : why.kind === 'setting'
          ? `of the setting for ${label(why.key)} on ${at(why.at)}`
          : why.kind === 'not-inherited'
            ? `${at(why.at)} doesn’t inherit access, and nothing there is set for them`
            : why.kind === 'default'
              ? space.kind === 'library'
                ? 'that’s the library’s default'
                : 'that’s the default for Blueprint in an artist’s Library'
              : why.kind === 'owner'
                ? 'they own it'
                : why.kind === 'space-holder'
                  ? space.kind === 'library'
                    ? 'Blueprint admins manage everything in the library'
                    : 'it’s their own Library'
                  : why.reason;
    return json(200, { sub, name: person.displayName, level: a.level, because });
  }

  // ── One folder: rename, delete ──
  const folderId = rest;
  if (!FOLDER_ID_PATTERN.test(folderId)) throw new HttpError(404, 'Not found');
  const folder = map.get(folderId) as StoredFolder | undefined;
  if (!folder) throw new HttpError(404, 'No such folder');
  const access = folderAccess(principal, folder, map, space);

  if (method === 'PATCH') {
    need(access, 'edit', 'folder');
    const body = parseBody(event, FolderRename);
    if (nameTaken(folders, folder.parentId, body.name, folderId)) {
      throw new HttpError(409, 'There’s already a folder with that name here');
    }
    const now = new Date().toISOString();
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: ctx.pk, SK: folderSk(folderId) },
        UpdateExpression: 'SET #n = :n, updatedAt = :at, updatedBy = :by',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':n': body.name, ':at': now, ':by': principal.sub },
      }),
    );
    await audit(event, 'folder.rename', 'success', { ...where, folderId });
    return json(200, { folderId, name: body.name });
  }

  if (method === 'DELETE') {
    need(access, 'manage', 'folder');
    const files = await loadAllFiles(ctx.pk);
    const inner = subtree(folders, files, folder);
    const hidden =
      inner.folders.some((f) => !can(folderAccess(principal, f, map, space), 'view')) ||
      inner.files.some((f) => !can(fileAccess(principal, f, map), 'view'));
    if (hidden) throw new HttpError(409, 'This folder contains items you don’t have access to');
    const notMine = inner.files.filter((f) => deleteAllowed(principal, f));
    if (notMine.length) {
      throw new HttpError(
        409,
        `${notMine.length} ${notMine.length === 1 ? 'file' : 'files'} in this folder belong to someone else, who has to delete ${notMine.length === 1 ? 'it' : 'them'} first`,
      );
    }
    const inUse: string[] = [];
    for (const f of inner.files) {
      if (inUseMessage((await usesOf(principal, f)).all)) inUse.push(f.title || f.name);
    }
    if (inUse.length) {
      throw new HttpError(
        409,
        `${inUse.length} ${inUse.length === 1 ? 'file' : 'files'} in this folder ${inUse.length === 1 ? 'is' : 'are'} in use (${inUse.slice(0, 3).join(', ')}${inUse.length > 3 ? '…' : ''}). Remove ${inUse.length === 1 ? 'it' : 'them'} from those places before deleting.`,
      );
    }
    for (const f of inner.files) await deps.removeFile(principal, f);
    for (const f of inner.folders) {
      await db.send(
        new DeleteCommand({ TableName: table(), Key: { PK: ctx.pk, SK: folderSk(f.folderId) } }),
      );
    }
    await audit(event, 'folder.delete', 'success', {
      ...where,
      folderId,
      folders: inner.folders.length,
      files: inner.files.length,
    });
    return json(200, {
      deleted: folderId,
      folders: inner.folders.length,
      files: inner.files.length,
    });
  }

  throw new HttpError(404, 'Not found');
}

type AccessLike = { grants?: Grants; inherit?: boolean };
