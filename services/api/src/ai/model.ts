import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '@bmg/authz';
import { z } from 'zod';
import type { Gig } from '../events/model.ts';
import type { Submission } from '../review/model.ts';
import type { Plan, Todo } from '../workspace/model.ts';

/**
 * Assistant rules that are enforced in code, not in prompts (design 10.4–10.6).
 * Pure, so they are unit-tested.
 */

/** Each artist's current AI choice, projected from the consent ledger: `ARTIST#id / AI`. */
export const AI_SK = 'AI';

/** Assistant history is kept for 30 days (design 10.5). */
export const HISTORY_DAYS = 30;
export const historyPk = (sub: string) => `AICHAT#${sub}`;
/** A new chat session id: time-ordered, with 80 bits from the CSPRNG (not Math.random). */
export const sessionId = () => `s${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;
export const SessionId = z.string().regex(/^s[a-z0-9]{8,30}$/);

export const ChatBody = z
  .object({
    message: z.string().trim().min(1).max(2000),
    sessionId: SessionId.optional(),
  })
  .strict();

/**
 * Who the assistant may serve. Artists only once they've opted in; Blueprint
 * staff always (BMG's own account is AI-on by org setting, design 10.3).
 */
export function canUseAssistant(principal: Principal, artistOptedIn: boolean): string | undefined {
  if (!principal.mfaSatisfied) return 'two-step verification required';
  if (principal.role === 'artist' && !artistOptedIn) {
    return 'AI assistance is off for your account. You can turn it on in Profile.';
  }
  return undefined;
}

/**
 * Which artist workspaces an AI read may touch. An opted-out artist simply
 * doesn't exist to the assistant (design 10.4).
 */
export function aiCanRead(
  principal: Principal,
  artistId: string,
  optedIn: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (!optedIn) {
    return {
      ok: false,
      reason:
        principal.role === 'artist'
          ? 'AI assistance is off for this account.'
          : "This artist isn't using AI features, so their workspace can't be seen here. Check it by hand.",
    };
  }
  if (principal.role === 'artist' && principal.artistId !== artistId) {
    return { ok: false, reason: 'You can only ask about your own workspace.' };
  }
  if (principal.role === 'bmg-staff' && !(principal.assignedArtistIds ?? []).includes(artistId)) {
    return { ok: false, reason: "That artist isn't assigned to you." };
  }
  return { ok: true };
}

/** A compact view of one workspace for the model: no notes ciphertext, no private items. */
export function workspaceDigest(
  input: {
    artistName: string;
    plan?: Plan;
    todos: Todo[];
    gigs: Gig[];
    submissions: Submission[];
  },
  role: Principal['role'],
  today: string,
) {
  const { plan } = input;
  return {
    artist: input.artistName,
    plan: plan
      ? {
          outcome: plan.outcome,
          phases: plan.phases.map((p) => {
            const total = p.milestones.length;
            const doneCount = p.milestones.filter((m) => m.done).length;
            return {
              name: p.name,
              progress: total ? `${doneCount} of ${total} milestones` : 'no milestones yet',
              openMilestones: p.milestones.filter((m) => !m.done).map((m) => m.title),
            };
          }),
        }
      : null,
    openTodos: input.todos
      .filter((t) => !t.done)
      .filter((t) => role !== 'artist' || t.visibility !== 'bmg-only')
      .slice(0, 50)
      .map((t) => ({ title: t.title, due: t.due ?? null, overdue: !!t.due && t.due < today })),
    upcomingGigs: input.gigs
      .filter((g) => g.date >= today && g.status !== 'cancelled')
      // Gigs an artist kept private stay private (design 9.1).
      .filter((g) => role === 'artist' || g.shared)
      .slice(0, 20)
      .map((g) => ({
        title: g.title,
        date: g.date,
        status: g.status,
        venue: g.venue ?? null,
        helpWanted: g.help?.status === 'open' ? g.help.topics : [],
      })),
    openSubmissions: input.submissions
      .filter((s) => s.status === 'open')
      .slice(0, 20)
      .map((s) => ({
        submissionId: s.submissionId,
        title: s.title,
        type: s.submissionType,
        priority: s.priority,
        neededBy: s.neededBy,
      })),
  };
}

// ── Action tokens (design 10.2): single-use, 60 s, bound to person, session and checklist ──

export const ActionClaims = z.object({
  sub: z.string(),
  sid: SessionId,
  h: z.string(),
  exp: z.number().int(),
  jti: z.string().min(16),
});
export type ActionClaims = z.infer<typeof ActionClaims>;

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');

/** The bytes the MAC covers. */
export function claimsBytes(claims: ActionClaims): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(claims));
}

export function encodeToken(claims: ActionClaims, mac: Uint8Array): string {
  return `${b64(JSON.stringify(claims))}.${b64(mac)}`;
}

export function decodeToken(token: string): { claims: ActionClaims; mac: Uint8Array } | undefined {
  const [c, m, extra] = token.split('.');
  if (!c || !m || extra !== undefined) return undefined;
  try {
    const claims = ActionClaims.safeParse(JSON.parse(Buffer.from(c, 'base64url').toString('utf8')));
    if (!claims.success) return undefined;
    return { claims: claims.data, mac: new Uint8Array(Buffer.from(m, 'base64url')) };
  } catch {
    return undefined;
  }
}

/** Checks everything except the MAC itself (KMS VerifyMac does that). */
export function checkClaims(
  claims: ActionClaims,
  expected: { sub: string; hash: string; nowSeconds: number },
): string | undefined {
  if (claims.sub !== expected.sub) return 'This checklist was made for someone else.';
  if (claims.h !== expected.hash) return 'The checklist changed. Ask the assistant again.';
  if (claims.exp < expected.nowSeconds)
    return 'This checklist has expired. Ask the assistant again.';
  return undefined;
}

export const jtiKey = (jti: string) => ({
  PK: `AIACT#${createHash('sha256').update(jti).digest('hex')}`,
  SK: 'USED',
});
