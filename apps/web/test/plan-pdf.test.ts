import { describe, expect, it } from 'vitest';
import { markdownToBlocks, pdfFileName } from '../src/lib/planPdf.ts';

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
});
