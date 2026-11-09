import { describe, expect, it } from 'vitest';
import {
  docAttributes,
  indexName,
  ingestDecision,
  kbName,
  MAX_INLINE_BYTES,
  reconcilePlan,
  retrievalFilter,
} from '../src/ai/kb.ts';

const pdf = { status: 'available' as const, contentType: 'application/pdf', size: 1000 };

describe('knowledge bases', () => {
  it('never takes private items, unscanned files, media or huge files', () => {
    expect(ingestDecision({ ...pdf, visibility: 'normal' })).toEqual({ ingest: true });
    expect(ingestDecision({ ...pdf, visibility: 'bmg-only' })).toEqual({ ingest: true });
    expect(ingestDecision({ ...pdf, visibility: 'private' })).toEqual({
      ingest: false,
      reason: 'private',
    });
    expect(ingestDecision({ ...pdf, status: 'pending' })).toMatchObject({ ingest: false });
    expect(ingestDecision({ ...pdf, contentType: 'audio/wav' })).toMatchObject({
      reason: 'not a document',
    });
    expect(ingestDecision({ ...pdf, size: MAX_INLINE_BYTES + 1 })).toMatchObject({
      reason: 'too large',
    });
  });

  it("hides Blueprint-only items from an artist's own search, set by code", () => {
    expect(retrievalFilter('artist')).toEqual({
      notEquals: { key: 'visibility', value: 'bmg-only' },
    });
    expect(retrievalFilter('bmg-admin')).toBeUndefined();
  });

  it('tags every chunk with where it came from', () => {
    expect(docAttributes({ fileId: 'f1', name: 'Set list.pdf' })).toEqual([
      { key: 'sourceId', value: { type: 'STRING', stringValue: 'f1' } },
      { key: 'fileName', value: { type: 'STRING', stringValue: 'Set list.pdf' } },
      { key: 'visibility', value: { type: 'STRING', stringValue: 'normal' } },
    ]);
  });

  it('names are valid for Bedrock and S3 Vectors', () => {
    expect(kbName('bmg', 'staging', 'art_aaaaaaaaaaaa')).toBe('bmg-staging-art-aaaaaaaaaaaa');
    expect(indexName('art_aaaaaaaaaaaa')).toBe('kb-art-aaaaaaaaaaaa');
  });

  it('reconciliation removes opted-out artists and adds opted-in ones', () => {
    expect(reconcilePlan(new Set(['a', 'b']), new Set(['b', 'c']))).toEqual({
      create: ['a'],
      purge: ['c'],
    });
  });
});
