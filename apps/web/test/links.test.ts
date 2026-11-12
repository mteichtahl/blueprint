// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { docLink, placeLink, type FileUse } from '../src/lib/files.ts';
import { openLink } from '../src/lib/push.ts';

const ART = 'art_chloepoli000';
const use = (kind: FileUse['kind'], id = 'x1'): FileUse => ({
  kind,
  id,
  title: 't',
  blocks: false,
});

describe('"Where it’s used" rows open their place (rev 8)', () => {
  it('links each kind of place', () => {
    const f = { artistId: ART };
    expect(placeLink(use('chat', 'dm-1'), f)).toBe('chat:dm-1');
    expect(placeLink(use('submission', 'sub1'), f)).toBe(`submission:${ART}/sub1`);
    expect(placeLink(use('brand-kit'), f)).toBe(`brand:${ART}`);
    expect(placeLink(use('asset'), f)).toBe(`assets:${ART}`);
  });

  it('only chats can be opened for a library document', () => {
    expect(placeLink(use('chat', 'g1'), { artistId: null })).toBe('chat:g1');
    expect(placeLink(use('submission'), { artistId: null })).toBeNull();
  });

  it('names a document by its space', () => {
    expect(docLink({ artistId: ART, fileId: 'f1' })).toBe(`doc:${ART}/f1`);
    expect(docLink({ artistId: null, fileId: 'f2' })).toBe('doc:library/f2');
  });

  it('sends links to the app shell', () => {
    const seen = vi.fn();
    const on = (e: Event) => seen((e as CustomEvent<string>).detail);
    window.addEventListener('bmg-go', on);
    openLink('brand:art_x');
    window.removeEventListener('bmg-go', on);
    expect(seen).toHaveBeenCalledWith('brand:art_x');
  });
});

describe('Copy to… wording (rev 10)', () => {
  it('says what was copied and what was left out', async () => {
    const { copiedText } = await import('../src/components/Folders.tsx');
    expect(copiedText('Contracts', { files: 3, folders: 1, skipped: 0 })).toBe(
      'Copied 3 files and 1 folder to “Contracts”.',
    );
    expect(copiedText('Library', { files: 1, folders: 0, skipped: 2 })).toBe(
      'Copied 1 file to “Library”. 2 items you can’t open or still being scanned were left out.',
    );
  });
});
