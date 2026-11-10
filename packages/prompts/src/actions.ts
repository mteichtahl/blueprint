import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The actions the assistant can propose (design 10.2). The agent only drafts
 * them; the person taps "Do it" and the API carries each one out with that
 * person's own permissions, re-checking every step.
 */

// Same pattern as @bmg/crypto's ARTIST_ID_PATTERN (real ids are art_ + 16).
const ArtistId = z.string().regex(/^art_[a-z0-9]{10,32}$/);
const Summary = z.string().trim().min(1).max(200);

export const Action = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('createTodo'),
      summary: Summary,
      artistId: ArtistId,
      title: z.string().trim().min(1).max(200),
      notes: z.string().trim().max(2000).optional(),
      due: z.iso.date().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sendMessage'),
      summary: Summary,
      /** BMG: the artist to message. Artists: leave out to message Blueprint. */
      artistId: ArtistId.optional(),
      text: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      type: z.literal('updateSubmissionPriority'),
      summary: Summary,
      artistId: ArtistId,
      submissionId: z.string().min(1).max(60),
      priority: z.enum(['high', 'medium', 'low']),
    })
    .strict(),
]);
export type Action = z.infer<typeof Action>;

export const MAX_ACTIONS = 10;
export const ActionList = z.array(Action).min(1).max(MAX_ACTIONS);

/** How long a proposed checklist can be confirmed for (design 10.2). */
export const ACTION_TOKEN_SECONDS = 60;

/** A stable hash of the checklist, so the confirm token is bound to exactly these actions. */
export function actionsHash(actions: readonly Action[]): string {
  const canonical = JSON.stringify(actions, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
  return createHash('sha256').update(canonical).digest('base64url');
}

/** What the chat Lambda sends the agent on each turn. */
export const Invocation = z.object({
  message: z.string().min(1).max(4000),
  /** The caller's own access token: the agent's tools call the API with it. */
  token: z.string().min(20),
  apiUrl: z.url(),
  systemPrompt: z.string().min(1),
  toolDescriptions: z.record(z.string(), z.string()),
  role: z.enum(['artist', 'bmg-admin', 'bmg-staff']),
  artistId: z.string().optional(),
});
export type Invocation = z.infer<typeof Invocation>;

/** What the agent returns. */
export interface AgentReply {
  reply: string;
  actions: Action[];
  /** Names of the tools used, for the trace (never their inputs or outputs). */
  toolsUsed: string[];
}

/**
 * Why a turn failed, from the agent (error name, plus an AWS service error's
 * status and message, which name the action and resource). Never prompt or
 * reply text, so it is safe to log and to show to an admin.
 */
export interface AgentFailure {
  failure: { error: string; status?: number; detail?: string };
}
