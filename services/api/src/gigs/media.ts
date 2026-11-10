/**
 * Gig media: photos and videos of a gig, uploaded on the gig's page. Pure:
 * names, folder path, counters and request schemas, unit-tested.
 *
 * - Files live in the artist's Library, in `gigs/<year>/<month>/<day>/` for
 *   the gig's date (e.g. `gigs/2026/12/11/`).
 * - Every file is named `<gig name>_<img|video>_<00000>` plus its extension,
 *   e.g. `Northcote Social Club_img_00001.jpg`. The number counts up per gig
 *   name, kind and day, so names never clash inside a day's folder.
 * - Several files go up at once: one request reserves a block of numbers.
 * - Who can see and add them follows the folder's access (rev 10).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export type MediaKind = 'img' | 'video';

/** Files per upload request; the page sends bigger selections in batches. */
export const MAX_MEDIA_PER_REQUEST = 20;
/** The counter is five digits. */
export const MAX_MEDIA_NUMBER = 99_999;
/** The root folder, in the artist's Library. */
export const GIGS_FOLDER = 'gigs';

/** Photos and videos only. SVG can carry script, so it isn't a photo. */
export function mediaKindOf(contentType: string): MediaKind | undefined {
  const t = contentType.toLowerCase();
  if (t === 'image/svg+xml') return undefined;
  if (t.startsWith('image/')) return 'img';
  if (t.startsWith('video/')) return 'video';
  return undefined;
}

/**
 * The gig name as it goes into a file name: folder rules forbid `/` and `\`,
 * control characters are dropped, runs of spaces close up, and it's cut so the
 * whole name stays within the 120-character item limit.
 */
export function gigNamePart(title: string): string {
  const clean = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A name ending in dots or spaces doesn't survive downloads on Windows.
    .replace(/[. ]+$/, '');
  return (clean || 'Gig').slice(0, 90).trim();
}

/** The extension to keep, from the picked file's name (lower case, letters and digits only). */
export function extensionOf(fileName: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(fileName)?.[1];
  return ext ? `.${ext.toLowerCase()}` : '';
}

export const pad5 = (n: number) => String(n).padStart(5, '0');

/** `<gig name>_<img|video>_<00000>` plus the original extension. */
export function mediaFileName(gigTitle: string, kind: MediaKind, n: number, original: string) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_MEDIA_NUMBER) {
    throw new RangeError('Media numbers run from 00001 to 99999');
  }
  return `${gigNamePart(gigTitle)}_${kind}_${pad5(n)}${extensionOf(original)}`;
}

/** The folder names from the Library root down: `['gigs', '2026', '12', '11']`. */
export function mediaFolderPath(date: string): [string, string, string, string] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError('Gig dates look like 2026-12-11');
  return [GIGS_FOLDER, m[1]!, m[2]!, m[3]!];
}

/**
 * How much of a day's folder path already exists (rev 10 folders): the
 * folders found from the top down (matched by name, case ignored, as folder
 * names are), and the names still to create below the last one found.
 */
export function walkFolderPath<
  F extends { folderId: string; name: string; parentId: string | null },
>(folders: Iterable<F>, names: readonly string[]): { found: F[]; missing: string[] } {
  const all = [...folders];
  const found: F[] = [];
  let parent: string | null = null;
  for (const [i, name] of names.entries()) {
    const n = name.toLocaleLowerCase();
    const hit = all.find(
      (f) => (f.parentId ?? null) === parent && f.name.toLocaleLowerCase() === n,
    );
    if (!hit) return { found, missing: names.slice(i) };
    found.push(hit);
    parent = hit.folderId;
  }
  return { found, missing: [] };
}

/**
 * A folder id that every upload agrees on for the same artist and path, so
 * two uploads creating `gigs › 2026` at the same moment make one folder, not
 * two (the second write fails its "doesn't exist yet" check).
 */
export function pathFolderId(artistId: string, names: readonly string[]): string {
  return `gm${createHash('sha256')
    .update(`${artistId}/${names.join('/').toLocaleLowerCase()}`)
    .digest('hex')
    .slice(0, 30)}`;
}

/** For screens and messages: "gigs › 2026 › 12 › 11". */
export const mediaFolderLabel = (date: string) => mediaFolderPath(date).join(' › ');

/**
 * The counter item. One per artist, day, gig name (case ignored, as folder
 * names are) and kind, so two gigs with the same name on the same day still
 * get different numbers, and renaming a gig starts its new name at 00001.
 */
export function counterSk(date: string, gigTitle: string, kind: MediaKind) {
  return `GIGMEDIA#${date}#${gigNamePart(gigTitle).toLowerCase()}#${kind}`;
}

/**
 * Given the counter after adding `count` (DynamoDB ADD returns the new
 * value), the numbers that were reserved: `last - count + 1 … last`.
 */
export function reservedNumbers(last: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => last - count + 1 + i);
}

// ── Requests ──────────────────────────────────────────────────────────────
const ContentType = z
  .string()
  .max(100)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, 'Unknown file type')
  .transform((t) => t.toLowerCase())
  .refine((t) => mediaKindOf(t) !== undefined, 'Only photos and videos can be added to a gig');

export const MediaItem = z
  .object({
    /** The picked file's name; only its extension is kept. */
    name: z.string().trim().min(1).max(200),
    size: z
      .number()
      .int()
      .min(1, 'The file is empty')
      .max(500 * 1024 * 1024, 'Files are limited to 500 MB'),
    contentType: ContentType,
    thumbnail: z
      .object({
        size: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024),
        contentType: z.enum(['image/webp', 'image/jpeg', 'image/png']),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Sent to `POST /artists/{artistId}/files` (the same route as any artist
 * upload): the gig and up to 20 files, which get their names and numbers here.
 */
export const MediaUpload = z
  .object({
    gigId: z.string().regex(/^[a-z0-9]{10,40}$/, 'No such gig'),
    files: z
      .array(MediaItem)
      .min(1, 'Pick at least one photo or video')
      .max(MAX_MEDIA_PER_REQUEST, `Add up to ${MAX_MEDIA_PER_REQUEST} files at a time`),
  })
  .strict();
export type MediaUpload = z.infer<typeof MediaUpload>;

/**
 * Splits an upload into its kinds and gives each file its number, in the
 * order picked. `start` holds the first reserved number per kind.
 */
export function numberFiles<T extends { contentType: string; name: string }>(
  files: T[],
  gigTitle: string,
  start: Record<MediaKind, number>,
): (T & { kind: MediaKind; n: number; fileName: string })[] {
  const next = { ...start };
  return files.map((f) => {
    const kind = mediaKindOf(f.contentType)!;
    const n = next[kind]++;
    return { ...f, kind, n, fileName: mediaFileName(gigTitle, kind, n, f.name) };
  });
}

export const countByKind = (files: { contentType: string }[]) =>
  files.reduce<Record<MediaKind, number>>(
    (c, f) => {
      c[mediaKindOf(f.contentType)!]++;
      return c;
    },
    { img: 0, video: 0 },
  );
