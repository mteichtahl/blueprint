/**
 * Folders and folder permissions (rev 10, `claude/BMG_Rev10_Folders_and_Permissions.md`).
 *
 * Each library is a space: Blueprint's library, or one artist's Library.
 * Folders live inside one space and nest with no depth limit. Folders and
 * files can carry their own access settings ("grants"); everything else is
 * inherited from the folders above.
 *
 * The rule: walk up from the item through its parent folders. The first
 * setting found for the person (or for their artist account) wins; failing
 * that, the first setting for a group they're in (the highest level, if two
 * groups are set on the same item). That includes "No access", so an override
 * can take access away as well as give it. A folder with `inherit: false`
 * stops the walk. With nothing set at all, the space's default applies.
 *
 * On top of that come rules no setting can change (section 3.5): the space
 * holder and the owner can't be locked out, artists never edit Blueprint's
 * library, another artist's files stay out of reach, Blueprint never opens a
 * file an artist marked private (KMS refuses it too), and Blueprint can't give
 * itself access an artist has removed.
 *
 * Pure: every function here is unit-tested, including trees thousands of
 * levels deep.
 */
import type { Principal } from '@bmg/authz';
import { z } from 'zod';
import type { FileRecord } from './model.ts';

// ── Levels ────────────────────────────────────────────────────────────────
export const LEVELS = ['none', 'view', 'edit', 'manage'] as const;
export type Level = (typeof LEVELS)[number];
const rank = (l: Level) => LEVELS.indexOf(l);
export const atLeast = (l: Level, min: Level) => rank(l) >= rank(min);
const max = (a: Level, b: Level) => (rank(a) >= rank(b) ? a : b);
const min = (a: Level, b: Level) => (rank(a) <= rank(b) ? a : b);

// ── Who access can be given to ────────────────────────────────────────────
/**
 * A grant key names who a setting is for:
 * - `p:<sub>`: one person;
 * - `a:<artistId>`: an artist (their account);
 * - `g:team`: the Blueprint team; `g:admins`: Blueprint admins;
 * - `g:artists`: all artists (Blueprint's library only).
 */
export type GrantKey = `p:${string}` | `a:${string}` | 'g:team' | 'g:admins' | 'g:artists';
export type Grants = Partial<Record<GrantKey, Level>>;

const SUB = '[0-9a-f-]{36}';
const ARTIST = 'art_[a-z0-9]{10,32}';
const KEY_PATTERN = new RegExp(`^(p:${SUB}|a:${ARTIST}|g:team|g:admins|g:artists)$`);
export const isGrantKey = (k: string): k is GrantKey => KEY_PATTERN.test(k);

/** A person's own setting beats a group's (3.2). */
const personal = (k: string) => k.startsWith('p:') || k.startsWith('a:');

function matches(p: Pick<Principal, 'sub' | 'role' | 'artistId'>, key: string): boolean {
  if (key === `p:${p.sub}`) return true;
  if (key.startsWith('a:')) return p.role === 'artist' && key === `a:${p.artistId}`;
  if (key === 'g:team') return p.role !== 'artist';
  if (key === 'g:admins') return p.role === 'bmg-admin';
  if (key === 'g:artists') return p.role === 'artist';
  return false;
}

// ── Spaces ────────────────────────────────────────────────────────────────
export type Space = { kind: 'library' } | { kind: 'artist'; artistId: string };
export const LIBRARY_SPACE: Space = { kind: 'library' };

/**
 * Who can be named in a space (3.1). In an artist's Library, only Blueprint
 * (the artist always manages their own space, and other artists get files
 * through chat). In Blueprint's library, anyone.
 */
export function keyAllowed(space: Space, key: GrantKey): boolean {
  if (space.kind === 'library') return true;
  return key === 'g:team' || key === 'g:admins' || key.startsWith('p:');
}

/** With nothing set anywhere up the tree (3.2). */
export function spaceDefault(space: Space, p: Pick<Principal, 'role'>): Level {
  if (p.role === 'artist') return 'none';
  // Library: the team edits, admins manage (below). Artist space: Blueprint
  // keeps today's rights (see and change files there) until the artist says otherwise.
  return 'edit';
}

/** The space's own default settings, as shown in the Access panel. */
export function defaultGrants(space: Space): Grants {
  return space.kind === 'library'
    ? { 'g:team': 'edit', 'g:admins': 'manage', 'g:artists': 'none' }
    : { 'g:team': 'edit' };
}

// ── Folders ───────────────────────────────────────────────────────────────
export interface FolderRecord {
  folderId: string;
  name: string;
  /** null at the top of the space. */
  parentId: string | null;
  ownerId: string;
  ownerRole: Principal['role'];
  grants?: Grants;
  /** false: "Don't inherit access from parent folders". */
  inherit?: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
}

export const folderSk = (folderId: string) => `FOLDER#${folderId}`;
export const FOLDER_ID_PATTERN = /^[a-z0-9]{10,40}$/;

/** Anything that can hold settings: a folder or a file. */
export interface AccessNode {
  grants?: Grants;
  inherit?: boolean;
}

export type FolderMap = ReadonlyMap<string, FolderRecord>;
export const folderMap = (folders: FolderRecord[]): FolderMap =>
  new Map(folders.map((f) => [f.folderId, f]));

/**
 * The folders above, nearest first. A missing parent ends the walk (the item
 * is treated as being at the top), and so does a loop, which moves never make
 * but a bad record must not turn into an endless walk.
 */
export function ancestors(map: FolderMap, parentId: string | null | undefined): FolderRecord[] {
  const out: FolderRecord[] = [];
  const seen = new Set<string>();
  let id = parentId ?? null;
  while (id && !seen.has(id)) {
    seen.add(id);
    const f = map.get(id);
    if (!f) break;
    out.push(f);
    id = f.parentId;
  }
  return out;
}

/** Whether `id` is `ancestorId` or somewhere inside it. */
export function isInside(map: FolderMap, id: string | null, ancestorId: string): boolean {
  if (id === ancestorId) return true;
  return ancestors(map, id).some((f) => f.folderId === ancestorId);
}

/** Every folder inside `rootId` (not including it), at any depth. */
export function descendants(folders: Iterable<FolderRecord>, rootId: string): FolderRecord[] {
  const children = new Map<string, FolderRecord[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const list = children.get(f.parentId) ?? [];
    list.push(f);
    children.set(f.parentId, list);
  }
  const out: FolderRecord[] = [];
  const seen = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (seen.has(c.folderId)) continue;
      seen.add(c.folderId);
      out.push(c);
      stack.push(c.folderId);
    }
  }
  return out;
}

// ── Resolving access ──────────────────────────────────────────────────────
/** Where a level came from, for "Check someone's access" and the Access panel. */
export type Source =
  | { kind: 'setting'; at: number; key: GrantKey }
  | { kind: 'not-inherited'; at: number }
  | { kind: 'default' };

/**
 * "Nearest setting wins" over a chain of nodes, the item first. Returns the
 * level from settings alone, before the fixed rules in `accessTo`.
 */
export function resolve(
  p: Pick<Principal, 'sub' | 'role' | 'artistId'>,
  chain: readonly AccessNode[],
  space: Space,
): { level: Level; source: Source } {
  for (let at = 0; at < chain.length; at++) {
    const node = chain[at]!;
    let mine: { level: Level; key: GrantKey } | undefined;
    let group: { level: Level; key: GrantKey } | undefined;
    for (const [key, level] of Object.entries(node.grants ?? {}) as [GrantKey, Level][]) {
      if (!level || !matches(p, key)) continue;
      const slot = personal(key) ? 'mine' : 'group';
      const cur = slot === 'mine' ? mine : group;
      if (!cur || rank(level) > rank(cur.level)) {
        if (slot === 'mine') mine = { level, key };
        else group = { level, key };
      }
    }
    const hit = mine ?? group;
    if (hit) return { level: hit.level, source: { kind: 'setting', at, key: hit.key } };
    if (node.inherit === false) return { level: 'none', source: { kind: 'not-inherited', at } };
  }
  return { level: spaceDefault(space, p), source: { kind: 'default' } };
}

export type Why =
  Source | { kind: 'space-holder' } | { kind: 'owner' } | { kind: 'capped'; reason: string };

export interface Access {
  level: Level;
  why: Why;
}

/** The item being checked: a folder, or a file in (or above) the folders. */
export type Item =
  | { kind: 'folder'; folder: FolderRecord }
  | {
      kind: 'file';
      file: Pick<
        FileRecord,
        | 'folderId'
        | 'grants'
        | 'inherit'
        | 'visibility'
        | 'sharedWithArtistIds'
        | 'ownerId'
        | 'ownerRole'
        | 'uploadedBy'
        | 'uploaderRole'
      >;
    };

const ownerSub = (item: Item) =>
  item.kind === 'folder' ? item.folder.ownerId : (item.file.ownerId ?? item.file.uploadedBy);

/** The item and the folders above it, nearest first. */
export function chainOf(item: Item, map: FolderMap): AccessNode[] {
  return item.kind === 'folder'
    ? [item.folder, ...ancestors(map, item.folder.parentId)]
    : [item.file, ...ancestors(map, item.file.folderId)];
}

/**
 * Someone's access to a folder or file: the settings, then the rules no
 * setting can change.
 */
export function accessTo(
  p: Pick<Principal, 'sub' | 'role' | 'artistId' | 'assignedArtistIds'>,
  item: Item,
  map: FolderMap,
  space: Space,
): Access {
  const file = item.kind === 'file' ? item.file : undefined;

  if (space.kind === 'artist') {
    if (p.role === 'artist') {
      if (p.artistId !== space.artistId) {
        // Another artist: only a file sent to them in a chat, to open (rev 7).
        const sent =
          !!file &&
          file.visibility !== 'bmg-only' &&
          (file.sharedWithArtistIds ?? []).includes(p.artistId ?? '');
        return sent
          ? { level: 'view', why: { kind: 'capped', reason: 'sent to you in a chat' } }
          : { level: 'none', why: { kind: 'capped', reason: 'another artist’s Library' } };
      }
      if (file?.visibility === 'bmg-only') {
        return { level: 'none', why: { kind: 'capped', reason: 'kept for Blueprint only' } };
      }
      return { level: 'manage', why: { kind: 'space-holder' } };
    }
    // Blueprint in an artist's space.
    if (file?.visibility === 'private') {
      return { level: 'none', why: { kind: 'capped', reason: 'marked private by the artist' } };
    }
    if (p.role === 'bmg-staff' && !(p.assignedArtistIds ?? []).includes(space.artistId)) {
      return { level: 'none', why: { kind: 'capped', reason: 'not assigned to this artist' } };
    }
    const r = resolve(p, chainOf(item, map), space);
    // The owner keeps full control of what they own, but never past an
    // artist's "No access": Blueprint can't override the artist (3.5).
    if (ownerSub(item) === p.sub && r.level !== 'none') {
      return { level: 'manage', why: { kind: 'owner' } };
    }
    return { level: r.level, why: r.source };
  }

  // Blueprint's library.
  if (p.role === 'bmg-admin') return { level: 'manage', why: { kind: 'space-holder' } };
  if (ownerSub(item) === p.sub) return { level: 'manage', why: { kind: 'owner' } };
  const r = resolve(p, chainOf(item, map), space);
  if (p.role === 'artist' && atLeast(r.level, 'edit')) {
    return { level: 'view', why: { kind: 'capped', reason: 'only Blueprint changes the library' } };
  }
  return { level: r.level, why: r.source };
}

// ── Files before rev 10 ───────────────────────────────────────────────────
/**
 * A file is managed by folders once it's in a folder or has its own setting.
 * Files that never were keep their rev 8 sharing until they're moved.
 */
export const folderManaged = (f: Pick<FileRecord, 'folderId' | 'grants' | 'inherit'>) =>
  !!f.folderId || !!f.grants || f.inherit === false;

/**
 * A library file's old sharing as settings of its own, so moving it into a
 * folder doesn't change who can see it ("moved items keep their own settings").
 */
export function legacyLibraryGrants(
  f: Pick<FileRecord, 'sharing' | 'sharedWithArtistIds'>,
): Grants | undefined {
  if (f.sharing === 'all-artists') return { 'g:artists': 'view' };
  if (f.sharing === 'selected' && f.sharedWithArtistIds?.length) {
    return Object.fromEntries(f.sharedWithArtistIds.map((id) => [`a:${id}`, 'view'])) as Grants;
  }
  return undefined;
}

// ── Changes ───────────────────────────────────────────────────────────────
/**
 * What "Don't inherit" copies in: the settings that currently reach this item
 * from above, plus the space defaults, so turning it on changes nothing until
 * someone edits it (3.3).
 */
export function inheritedGrants(item: Item, map: FolderMap, space: Space): Grants {
  const chain = chainOf(item, map).slice(1);
  const out: Grants = {};
  let stopped = false;
  for (const node of chain) {
    for (const [k, l] of Object.entries(node.grants ?? {}) as [GrantKey, Level][]) {
      if (l && !(k in out)) out[k] = l;
    }
    if (node.inherit === false) {
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    for (const [k, l] of Object.entries(defaultGrants(space)) as [GrantKey, Level][]) {
      if (!(k in out)) out[k] = l;
    }
  }
  return out;
}

/** Drops "no setting" entries and keys this space can't name. */
export function cleanGrants(space: Space, grants: Grants): Grants | undefined {
  const out: Grants = {};
  for (const [k, l] of Object.entries(grants) as [GrantKey, Level][]) {
    if (l && isGrantKey(k) && keyAllowed(space, k)) out[k] = l;
  }
  return Object.keys(out).length ? out : undefined;
}

// ── Names ─────────────────────────────────────────────────────────────────
export const FolderName = z
  .string()
  .trim()
  .min(1, 'Give the folder a name')
  .max(120, 'Folder names are limited to 120 characters')
  .refine(
    // eslint-disable-next-line no-control-regex
    (n) => !/[\u0000-\u001f\u007f/\\]/.test(n),
    'Folder names cannot contain / \\ or control characters',
  );

/** Folder names are unique among the folders next to them, ignoring case. */
export function nameTaken(
  folders: Iterable<FolderRecord>,
  parentId: string | null,
  name: string,
  except?: string,
): boolean {
  const n = name.trim().toLocaleLowerCase();
  for (const f of folders) {
    if (f.folderId !== except && (f.parentId ?? null) === parentId) {
      if (f.name.toLocaleLowerCase() === n) return true;
    }
  }
  return false;
}

// ── Requests ──────────────────────────────────────────────────────────────
const Id = z.string().regex(FOLDER_ID_PATTERN, 'No such folder');
const ParentId = Id.nullable();

const GrantsSchema = z
  .record(z.string(), z.enum(LEVELS).nullable())
  .refine((g) => Object.keys(g).length <= 200, 'Too many settings')
  .refine((g) => Object.keys(g).every(isGrantKey), 'Unknown person or group');

export const FolderCreate = z
  .object({ name: FolderName, parentId: ParentId.default(null) })
  .strict();

export const FolderRename = z.object({ name: FolderName }).strict();

const ItemRef = z
  .object({ kind: z.enum(['file', 'folder']), id: z.string().regex(FOLDER_ID_PATTERN) })
  .strict();

export const MoveBody = z
  .object({
    items: z.array(ItemRef).min(1).max(200),
    to: ParentId,
    /** Only report who gains and loses access. */
    preview: z.boolean().default(false),
  })
  .strict();

export const AccessBody = z
  .object({
    item: ItemRef,
    /** The settings on this item; a key set to null is reset to inherited. */
    grants: GrantsSchema.optional(),
    inherit: z.boolean().optional(),
    /** Deeper items with their own setting for the same people: keep (default) or replace. */
    pushDown: z.enum(['keep', 'replace']).default('keep'),
    preview: z.boolean().default(false),
  })
  .strict()
  .refine((b) => b.grants !== undefined || b.inherit !== undefined, 'Nothing to change');

// ── Who gains and who loses access ────────────────────────────────────────
export interface Change {
  sub: string;
  gains: number;
  loses: number;
}

/**
 * Compares who can see each item before and after a change (the move or
 * access summary). `before` and `after` give each person's view of each item.
 */
export function compareAccess<P extends { sub: string }>(
  people: readonly P[],
  items: readonly { before: Item; after: Item }[],
  view: { before: (p: P, item: Item) => Level; after: (p: P, item: Item) => Level },
): Change[] {
  const out: Change[] = [];
  for (const p of people) {
    let gains = 0;
    let loses = 0;
    for (const it of items) {
      const was = atLeast(view.before(p, it.before), 'view');
      const now = atLeast(view.after(p, it.after), 'view');
      if (!was && now) gains++;
      if (was && !now) loses++;
    }
    if (gains || loses) out.push({ sub: p.sub, gains, loses });
  }
  return out;
}

export { max as maxLevel, min as minLevel };
