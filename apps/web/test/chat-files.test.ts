import { describe, expect, it } from 'vitest';
import { downloadPath } from '../src/pages/Messages.tsx';

describe('file cards in chat', () => {
  it('download from the right place', () => {
    expect(
      downloadPath({
        kind: 'file',
        id: 'f1',
        artistId: 'art_aaaaaaaaaaaa',
        scope: 'artist',
        title: 'a',
        subtitle: '',
      }),
    ).toBe('/artists/art_aaaaaaaaaaaa/files/f1/download');
    expect(
      downloadPath({ kind: 'file', id: 'f2', scope: 'library', title: 'b', subtitle: '' }),
    ).toBe('/library/files/f2/download');
    expect(downloadPath({ kind: 'gig', id: 'g', title: 'c', subtitle: '' })).toBeNull();
  });
});
