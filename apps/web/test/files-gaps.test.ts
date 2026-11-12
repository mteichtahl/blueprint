import { describe, expect, it } from 'vitest';
import type { FileItem } from '../src/lib/files.ts';
import { pickerLevel, type Folder } from '../src/lib/folders.ts';
import { searchLibrary, zipEntries, zipTooBig, ZIP_MAX_FILES } from '../src/lib/zip.ts';

/** Rev 10 gaps: Download as ZIP, This folder / Everywhere search, folders in pickers. */

const folder = (folderId: string, name: string, parentId: string | null): Folder =>
  ({ folderId, name, parentId, path: [], level: 'edit', sharedWithMe: false }) as unknown as Folder;
const file = (
  fileId: string,
  name: string,
  folderId: string | null,
  over: Partial<FileItem> = {},
) =>
  ({
    fileId,
    name,
    displayName: over.displayName ?? name,
    folderId,
    size: 10,
    status: 'available',
    ...over,
  }) as FileItem;

const folders = [
  folder('tour', 'Tour', null),
  folder('riders', 'Riders', 'tour'),
  folder('press', 'Press', null),
];
const files = [
  file('f1', 'rider.pdf', 'riders', { displayName: 'Corner Hotel rider' }),
  file('f2', 'rider.pdf', 'riders'),
  file('f3', 'setlist.txt', 'tour'),
  file('f4', 'shot.jpg', 'press', { displayName: 'Café press shot' }),
  file('f5', 'scan.pdf', 'tour', { status: 'pending' }),
  file('f6', 'loose.pdf', null),
];

describe('Download as ZIP (rev 10)', () => {
  it('keeps the folders as paths, makes names unique and leaves out unscanned files', () => {
    const { entries, skipped } = zipEntries(
      [
        { kind: 'folder', id: 'tour' },
        { kind: 'file', id: 'f6' },
      ],
      folders,
      files,
    );
    expect(entries.map((e) => e.path)).toEqual([
      'Tour/setlist.txt',
      'Tour/Riders/rider.pdf',
      'Tour/Riders/rider (2).pdf',
      'loose.pdf',
    ]);
    expect(skipped).toBe(1);
  });

  it('says when there’s nothing, or too much, to zip', () => {
    expect(zipTooBig([])).toBe('There are no files to download.');
    const many = Array.from({ length: ZIP_MAX_FILES + 1 }, (_, i) => ({
      fileId: `f${i}`,
      path: `${i}`,
      size: 1,
    }));
    expect(zipTooBig(many)).toMatch(/^That’s 201 files/);
    expect(zipTooBig([{ fileId: 'x', path: 'x', size: 600 * 1024 * 1024 }])).toMatch(/600 MB/);
  });
});

describe('This folder / Everywhere search (rev 10)', () => {
  it('matches every word, ignoring case and accents', () => {
    const r = searchLibrary('cafe SHOT', 'everywhere', null, folders, files);
    expect(r.files.map((f) => f.fileId)).toEqual(['f4']);
  });

  it('“This folder” searches inside the open folder only, at any depth', () => {
    const here = searchLibrary('rider', 'here', 'tour', folders, files);
    expect(here.files.map((f) => f.fileId)).toEqual(['f1', 'f2']);
    expect(here.folders.map((f) => f.folderId)).toEqual(['riders']);
    expect(searchLibrary('shot', 'here', 'tour', folders, files).files).toEqual([]);
    expect(searchLibrary('shot', 'everywhere', 'tour', folders, files).files).toHaveLength(1);
  });
});

describe('folders in pickers (rev 10)', () => {
  it('shows one level at a time, with files in unknown folders at the top', () => {
    const top = pickerLevel(folders, [...files, file('f7', 'x.pdf', 'hidden')], null);
    expect(top.folders.map((f) => f.name)).toEqual(['Press', 'Tour']);
    expect(top.files.map((f) => f.fileId)).toEqual(['f6', 'f7']);
    const tour = pickerLevel(folders, files, 'tour');
    expect(tour.here?.name).toBe('Tour');
    expect(tour.folders.map((f) => f.name)).toEqual(['Riders']);
    expect(tour.files.map((f) => f.fileId)).toEqual(['f3', 'f5']);
  });
});
