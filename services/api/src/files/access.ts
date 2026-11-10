/**
 * Who can do what with a file or folder (rev 10): files in folders follow the
 * folder rules in `folders.ts`; files that were never put in a folder keep
 * their rev 8 rules until they are. Pure, so it is unit-tested.
 */
import { authorize, type Principal } from '@bmg/authz';
import {
  accessTo,
  atLeast,
  chainOf,
  defaultGrants,
  folderManaged,
  type Access,
  type FolderMap,
  type FolderRecord,
  type GrantKey,
  type Grants,
  type Item,
  type Level,
  type Space,
} from './folders.ts';
import { librarySharing, type FileRecord } from './model.ts';

export type Viewer = Pick<
  Principal,
  'sub' | 'role' | 'artistId' | 'assignedArtistIds' | 'mfaSatisfied'
>;

export const spaceOf = (f: Pick<FileRecord, 'scope' | 'artistId'>): Space =>
  f.scope === 'library' ? { kind: 'library' } : { kind: 'artist', artistId: f.artistId! };

/** The rev 8 rules as a level: read is view, write is edit (the space holder manages). */
export function legacyLevel(p: Viewer, f: FileRecord): Level {
  const full = { ...p, secondsSinceAuth: 0 } as Principal;
  const resource =
    f.scope === 'library'
      ? librarySharing(f)
      : {
          kind: 'artist-data' as const,
          artistId: f.artistId!,
          visibility: f.visibility ?? 'normal',
          sharedWithArtistIds: f.sharedWithArtistIds ?? [],
        };
  if (authorize(full, 'write', resource).allow) {
    if (f.scope === 'library') return p.role === 'bmg-admin' ? 'manage' : 'edit';
    return p.role === 'artist' ? 'manage' : 'edit';
  }
  return authorize(full, 'read', resource).allow ? 'view' : 'none';
}

/** Someone's access to a file. Two-step verification first, always. */
export function fileAccess(p: Viewer, f: FileRecord, map: FolderMap): Access {
  if (!p.mfaSatisfied)
    return { level: 'none', why: { kind: 'capped', reason: 'two-step verification required' } };
  if (!folderManaged(f)) return { level: legacyLevel(p, f), why: { kind: 'default' } };
  return accessTo(p, { kind: 'file', file: f }, map, spaceOf(f));
}

export function folderAccess(
  p: Viewer,
  folder: FolderRecord,
  map: FolderMap,
  space: Space,
): Access {
  if (!p.mfaSatisfied)
    return { level: 'none', why: { kind: 'capped', reason: 'two-step verification required' } };
  return accessTo(p, { kind: 'folder', folder }, map, space);
}

/** The top of a space, as if it were a folder with no settings. */
export function rootAccess(p: Viewer, map: FolderMap, space: Space): Access {
  const root: FolderRecord = {
    folderId: 'root',
    name: '',
    parentId: null,
    ownerId: '',
    ownerRole: 'bmg-admin',
    createdAt: '',
    createdBy: '',
  };
  return folderAccess(p, root, map, space);
}

export const can = (a: Access, min: Level) => atLeast(a.level, min);

/** One row of the Access panel: who, their level, and where it comes from. */
export interface Entry {
  key: GrantKey;
  level: Level;
  source:
    | { kind: 'here' }
    | { kind: 'inherited'; folderId: string; folderName: string }
    | { kind: 'default' };
}

/**
 * Every setting that reaches an item: its own, then each folder's above it
 * (nearest wins per person or group), then the space defaults unless the
 * walk stopped at "Don't inherit".
 */
export function entriesFor(item: Item, map: FolderMap, space: Space): Entry[] {
  const chain = chainOf(item, map);
  const seen = new Set<string>();
  const out: Entry[] = [];
  let stopped = false;
  chain.forEach((node, at) => {
    if (stopped) return;
    for (const [key, level] of Object.entries(node.grants ?? {}) as [GrantKey, Level][]) {
      if (!level || seen.has(key)) continue;
      seen.add(key);
      const folder = node as Partial<FolderRecord>;
      out.push({
        key,
        level,
        source:
          at === 0
            ? { kind: 'here' }
            : { kind: 'inherited', folderId: folder.folderId!, folderName: folder.name! },
      });
    }
    if (node.inherit === false) stopped = true;
  });
  if (!stopped) {
    for (const [key, level] of Object.entries(defaultGrants(space)) as [GrantKey, Level][]) {
      if (!seen.has(key)) out.push({ key, level, source: { kind: 'default' } });
    }
  }
  return out;
}

/**
 * Whether Blueprint's knowledge base may hold an artist's file: not when the
 * artist has taken Blueprint's access away, for the team or for anyone in it
 * (the knowledge base is shared by the whole team).
 */
export function hiddenFromBlueprint(f: FileRecord, map: FolderMap): boolean {
  if (f.scope !== 'artist' || !folderManaged(f)) return false;
  const entries = entriesFor({ kind: 'file', file: f }, map, spaceOf(f));
  return entries.some(
    (e) =>
      e.level === 'none' && (e.key === 'g:team' || e.key === 'g:admins' || e.key.startsWith('p:')),
  );
}

export type { Grants };
