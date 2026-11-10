import { describe, expect, it } from 'vitest';
import { atLeast, describeChanges, foldersBase } from '../src/lib/folders.ts';

describe('folders (rev 10)', () => {
  it('finds the folder routes for a file collection', () => {
    expect(foldersBase('/library/files')).toBe('/library/folders');
    expect(foldersBase('/artists/art_aaaaaaaaaaaa/files')).toBe(
      '/artists/art_aaaaaaaaaaaa/folders',
    );
  });
  it('compares levels', () => {
    expect(atLeast('manage', 'edit')).toBe(true);
    expect(atLeast('view', 'edit')).toBe(false);
  });
  it('says who gains and loses access in plain words', () => {
    expect(describeChanges({ changes: [] })).toBe('doesn’t change who can open anything');
    expect(
      describeChanges(
        {
          changes: [
            { sub: 'a', name: 'Chloe', gains: 3, loses: 0 },
            { sub: 'b', name: 'Sam', gains: 48, loses: 0 },
            { sub: 'c', name: 'SARUN', gains: 0, loses: 12 },
          ],
        },
        'files',
      ),
    ).toBe(
      'gives 2 people access to up to 48 files and removes access for 1 person from up to 12 files',
    );
  });
});
