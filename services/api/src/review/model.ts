/**
 * Submissions and the review queue (design F3; screens: artist "Submit for
 * review", workspace Submissions tab, BMG Review queue). Pure: keys, schemas
 * and ordering, unit-tested.
 *
 * - The artist submits with a type, priority, needed-by date, plan phase,
 *   note and (optionally) files from their library. The note is encrypted
 *   with the artist's own key.
 * - BMG's queue is sorted by priority, then needed-by date (GSI3).
 * - BMG can change the priority or date; the artist is told (event).
 * - "Provide feedback" turns each action point into a to-do linked to the
 *   submission and phase, in one DynamoDB transaction.
 */
import { z } from 'zod';

export const SUBMISSION_TYPES = [
  'demo',
  'mix',
  'master',
  'lyrics',
  'artwork',
  'photo',
  'video',
  'press',
  'social-post',
  'other',
] as const;
export type SubmissionType = (typeof SUBMISSION_TYPES)[number];

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
const PRIORITY_RANK: Record<Priority, number> = { high: 1, medium: 2, low: 3 };

export type SubmissionStatus = 'open' | 'reviewed';

export interface Submission {
  submissionId: string;
  artistId: string;
  title: string;
  /** Stored as submissionType: the item's own `type` attribute is 'submission'. */
  submissionType: SubmissionType;
  priority: Priority;
  neededBy: string;
  phaseId?: string;
  fileIds: string[];
  /**
   * The version of each file when it was sent (rev 8): a later version of the
   * document doesn't change what was submitted.
   */
  fileVersions?: Record<string, number>;
  /** Artist-key ciphertext (AWS Encryption SDK). */
  noteCipher?: Uint8Array;
  feedbackCipher?: Uint8Array;
  feedbackTodoIds?: string[];
  /** When feedback was sent. Feedback no longer ends the review: Complete review does. */
  feedbackAt?: string;
  /** `reviewed` = the review is complete (reviewedAt/reviewedBy say when and who). */
  status: SubmissionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
  /** Who last changed priority or date, so the artist sees "Blueprint changed this". */
  changedByBmgAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export const submissionSk = (id: string) => `SUB#${id}`;
export const SUBMISSION_ID_PATTERN = /^[a-z0-9]{10,40}$/;

/** GSI3 keys: one partition per status, sorted by priority, then date. */
export const queuePk = (status: SubmissionStatus) => `REVIEW#${status}`;
export function queueSk(
  s: Pick<Submission, 'priority' | 'neededBy' | 'artistId' | 'submissionId'>,
) {
  return `${PRIORITY_RANK[s.priority]}#${s.neededBy}#${s.artistId}#${s.submissionId}`;
}

/** The same order the queue index gives, for lists read from one artist's partition. */
export function byPriorityThenDate(a: Submission, b: Submission): number {
  return queueSk(a) < queueSk(b) ? -1 : queueSk(a) > queueSk(b) ? 1 : 0;
}

const Title = z.string().trim().min(1, 'Give it a title').max(200);
const Note = z.string().trim().max(4000);
const IsoDate = z.iso.date('Use a date like 2026-12-01');
const FileIds = z
  .array(z.string().regex(/^[a-z0-9]{10,40}$/))
  .max(10, 'Attach up to 10 files')
  .default([]);

export const SubmissionCreate = z.object({
  title: Title,
  type: z.enum(SUBMISSION_TYPES),
  priority: z.enum(PRIORITIES).default('medium'),
  neededBy: IsoDate,
  phaseId: z.string().max(40).optional(),
  note: Note.optional(),
  fileIds: FileIds,
});

export const SubmissionPatch = z
  .object({
    priority: z.enum(PRIORITIES).optional(),
    neededBy: IsoDate.optional(),
    /** Artists can still edit these while the submission is open. */
    title: Title.optional(),
    note: Note.optional(),
    /** Blueprint completes the review; the person who asked for it is told. */
    complete: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const FeedbackBody = z
  .object({
    comment: z.string().trim().max(4000).default(''),
    points: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          due: IsoDate.optional(),
        }),
      )
      .max(20, 'Up to 20 action points at a time')
      .default([]),
    /** Send the feedback and complete the review in one step. */
    complete: z.boolean().default(false),
  })
  .refine((v) => v.comment || v.points.length > 0, 'Add a comment or at least one action point');

/** What changes a role may make with a PATCH. */
export function patchAllowed(
  role: 'artist' | 'bmg-admin' | 'bmg-staff',
  status: SubmissionStatus,
  patch: z.infer<typeof SubmissionPatch>,
): string | undefined {
  if (status !== 'open') return 'This review is already complete';
  if (patch.complete) {
    if (role === 'artist') return 'Blueprint completes the review';
    if (Object.keys(patch).length > 1) return 'Complete the review on its own';
    return undefined;
  }
  if (role !== 'artist' && (patch.title !== undefined || patch.note !== undefined)) {
    return 'Only the artist can change the title or note';
  }
  return undefined;
}

/** True when BMG changed what the artist set, so the artist should be told (F3). */
export function bmgChangedTiming(
  role: 'artist' | 'bmg-admin' | 'bmg-staff',
  before: Pick<Submission, 'priority' | 'neededBy'>,
  patch: z.infer<typeof SubmissionPatch>,
): boolean {
  if (role === 'artist') return false;
  return (
    (patch.priority !== undefined && patch.priority !== before.priority) ||
    (patch.neededBy !== undefined && patch.neededBy !== before.neededBy)
  );
}

/** Metadata for lists; the note and feedback are only decrypted on the detail view. */
export function publicSubmission(s: Submission) {
  return {
    submissionId: s.submissionId,
    artistId: s.artistId,
    title: s.title,
    type: s.submissionType,
    priority: s.priority,
    neededBy: s.neededBy,
    phaseId: s.phaseId ?? null,
    fileIds: s.fileIds ?? [],
    fileVersions: s.fileVersions ?? {},
    status: s.status,
    createdAt: s.createdAt,
    changedByBmgAt: s.changedByBmgAt ?? null,
    reviewedAt: s.reviewedAt ?? null,
    feedbackAt:
      s.feedbackAt ?? (s.status === 'reviewed' && s.feedbackCipher ? s.reviewedAt : null) ?? null,
    feedbackTodoIds: s.feedbackTodoIds ?? [],
  };
}
