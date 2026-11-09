import { describe, expect, it } from 'vitest';
import {
  bmgChangedTiming,
  byPriorityThenDate,
  FeedbackBody,
  patchAllowed,
  publicSubmission,
  queueSk,
  SubmissionCreate,
  type Submission,
} from '../src/review/model.ts';

const base: Submission = {
  submissionId: 'mabcdefgh0123456789',
  artistId: 'art_aaaaaaaaaaaa',
  title: 'Single mix v2',
  submissionType: 'mix',
  priority: 'medium',
  neededBy: '2026-11-20',
  fileIds: [],
  noteCipher: new Uint8Array([1, 2, 3]),
  status: 'open',
  createdBy: 'u-a',
  createdAt: '2026-11-09T00:00:00Z',
};

describe('review queue order', () => {
  it('sorts by priority, then needed-by date', () => {
    const subs: Submission[] = [
      { ...base, submissionId: 'a0000000001', priority: 'low', neededBy: '2026-11-10' },
      { ...base, submissionId: 'a0000000002', priority: 'high', neededBy: '2026-12-01' },
      { ...base, submissionId: 'a0000000003', priority: 'high', neededBy: '2026-11-15' },
      { ...base, submissionId: 'a0000000004', priority: 'medium', neededBy: '2026-11-11' },
    ];
    expect(subs.sort(byPriorityThenDate).map((s) => s.submissionId)).toEqual([
      'a0000000003',
      'a0000000002',
      'a0000000004',
      'a0000000001',
    ]);
    expect(queueSk({ ...base, priority: 'high' })).toMatch(/^1#2026-11-20#art_/);
  });
});

describe('submitting', () => {
  it('needs a title, a type and a needed-by date; defaults to medium priority', () => {
    const s = SubmissionCreate.parse({ title: 'Demo', type: 'demo', neededBy: '2026-12-01' });
    expect(s.priority).toBe('medium');
    expect(SubmissionCreate.safeParse({ title: 'Demo', type: 'demo' }).success).toBe(false);
    expect(
      SubmissionCreate.safeParse({ title: 'x', type: 'podcast', neededBy: '2026-12-01' }).success,
    ).toBe(false);
  });
});

describe('changes', () => {
  it('lets BMG change priority and date but not the artist’s words', () => {
    expect(patchAllowed('bmg-staff', 'open', { priority: 'high' })).toBeUndefined();
    expect(patchAllowed('bmg-staff', 'open', { note: 'x' })).toMatch(/Only the artist/);
    expect(patchAllowed('artist', 'open', { title: 'New' })).toBeUndefined();
    expect(patchAllowed('artist', 'reviewed', { priority: 'low' })).toMatch(
      /already been reviewed/,
    );
  });

  it('tells the artist only when BMG actually changed the timing', () => {
    expect(bmgChangedTiming('bmg-admin', base, { priority: 'high' })).toBe(true);
    expect(bmgChangedTiming('bmg-admin', base, { priority: 'medium' })).toBe(false);
    expect(bmgChangedTiming('bmg-admin', base, { neededBy: '2026-11-25' })).toBe(true);
    expect(bmgChangedTiming('artist', base, { priority: 'high' })).toBe(false);
  });
});

describe('feedback', () => {
  it('needs a comment or at least one action point', () => {
    expect(FeedbackBody.safeParse({}).success).toBe(false);
    expect(FeedbackBody.safeParse({ comment: 'Great' }).success).toBe(true);
    expect(FeedbackBody.safeParse({ points: [{ title: 'Lift the vocal' }] }).success).toBe(true);
  });
});

describe('lists', () => {
  it('never include the encrypted note', () => {
    const shown = publicSubmission(base);
    expect(shown.type).toBe('mix');
    expect(JSON.stringify(shown)).not.toMatch(/noteCipher|feedbackCipher/);
  });
});
