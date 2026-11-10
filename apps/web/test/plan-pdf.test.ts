import { describe, expect, it } from 'vitest';
import {
  changesOldestFirst,
  copyrightLine,
  LOGO_PATH,
  markdownToBlocks,
  pdfFileName,
} from '../src/lib/planPdf.ts';
import type { PlanChange } from '../src/lib/api.ts';

describe('plan PDF', () => {
  it('keeps the shape of the Markdown as plain text', () => {
    expect(
      markdownToBlocks(
        '## Goal\nPlay **three** shows\nin _Melbourne_.\n\n- Book [Corner](https://corner.com.au)\n1. Promo\n> Keep it fun',
      ),
    ).toEqual([
      { kind: 'heading', text: 'Goal' },
      { kind: 'para', text: 'Play three shows in Melbourne.' },
      { kind: 'bullet', text: 'Book Corner (https://corner.com.au)' },
      { kind: 'bullet', text: 'Promo' },
      { kind: 'quote', text: 'Keep it fun' },
    ]);
    expect(markdownToBlocks('')).toEqual([]);
  });

  it('names the file after the artist and day', () => {
    expect(pdfFileName('Chloe Poli', '2026-11-10')).toBe('Plan - Chloe Poli - 2026-11-10.pdf');
    expect(pdfFileName('AC/DC?', '2026-11-10')).toBe('Plan - ACDC - 2026-11-10.pdf');
  });

  it('carries the official logo and a copyright line (rev 8)', () => {
    expect(LOGO_PATH).toBe('/brand/bmg-logo-white-on-navy.png');
    expect(copyrightLine(2026)).toBe('© 2026 Blueprint Music Group. All rights reserved.');
  });

  it('lists the change history in the order it happened (rev 8)', () => {
    const c = (version: number, at: string): PlanChange => ({
      changeId: `c${version}`,
      version,
      at,
      kind: 'edited',
      byName: 'Blueprint',
      changes: ['Changed the outcome'],
    });
    const newestFirst = [
      c(3, '2026-11-10T02:00:00Z'),
      c(2, '2026-11-09T02:00:00Z'),
      c(1, '2026-11-01T02:00:00Z'),
    ];
    expect(changesOldestFirst(newestFirst).map((x) => x.version)).toEqual([1, 2, 3]);
    expect(newestFirst[0]!.version).toBe(3);
  });
});
