import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Principal } from '@bmg/authz';
import { z } from 'zod';
import { aiStates } from '../ai/prompts.ts';
import { db, env, HttpError } from '../lib.ts';
import { newId } from '../workspace/model.ts';
import { loadPlan, savePlan } from '../workspace/plan-store.ts';
import { AI_TASKS, JOB_STALE_MS, QUESTION_MAX, type AiJob, type AiTask } from './ai.ts';
import {
  artistsInvolved,
  meetingSk,
  spaceOf,
  spacePk,
  type Meeting,
  type MeetingContent,
} from './model.ts';
import {
  applySuggestions,
  planProblem,
  ProposedChange,
  reviewChanges,
  setStatus,
  SUGGESTION_STATUSES,
  UNDO_DAYS,
  type Suggestion,
} from './plan-changes.ts';
import { loadMeeting, readContent, writeContent } from './store.ts';

/**
 * What Blueprint does with a transcript (rev 11, spec 5.2 and 6): ask for a
 * summary, an answer or plan suggestions (the worker does the AI work), review
 * the suggestions, update the plan, and undo that update.
 */

const events = new EventBridgeClient({});
type StaffRole = 'bmg-admin' | 'bmg-staff';

async function put(source: string, type: string, detail: Record<string, unknown>) {
  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: env('EVENT_BUS'),
          Source: source,
          DetailType: type,
          Detail: JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...detail }),
        },
      ],
    }),
  );
}

/** Refuses AI work for anyone who turned AI off, at the moment of asking (spec 8). */
async function needAi(m: Meeting) {
  const involved = artistsInvolved(m);
  if (!involved.length) return;
  const states = await aiStates(involved);
  if (involved.some((id) => !states[id])) {
    throw new HttpError(
      409,
      'An artist in this meeting has turned off AI assistance, so it can’t be summarised or used for plan suggestions.',
    );
  }
}

const TASK_WORDS: Record<AiTask, string> = {
  quick: 'a summary',
  full: 'meeting notes',
  ask: 'an answer',
  suggest: 'plan suggestions',
};

export const AiRequest = z
  .object({
    task: z.enum(AI_TASKS),
    question: z.string().trim().min(1).max(QUESTION_MAX).optional(),
  })
  .strict()
  .refine((r) => r.task !== 'ask' || !!r.question, 'Type a question to ask');

/**
 * Starts a summary, an answer or plan suggestions. One at a time per meeting;
 * a job that has been quiet for a few minutes counts as lost.
 */
export async function requestAi(
  m: Meeting,
  principal: Principal,
  body: z.infer<typeof AiRequest>,
): Promise<AiJob> {
  if (m.status !== 'ready') throw new HttpError(409, 'The transcript isn’t ready yet');
  await needAi(m);
  if (body.task === 'suggest') {
    if (!m.artistId) throw new HttpError(400, 'Only a meeting about an artist can change a plan');
    if (!(await loadPlan(m.artistId))) {
      throw new HttpError(409, 'This artist doesn’t have a plan yet. Start one first.');
    }
  }
  const now = new Date();
  const job: AiJob = {
    task: body.task,
    status: 'working',
    requestId: randomUUID(),
    requestedBy: principal.sub,
    requestedAt: now.toISOString(),
  };
  // The question is kept with the meeting's content (never on the event bus),
  // before the job starts, so the worker always finds it.
  if (body.question) {
    const role = principal.role as StaffRole;
    const content: MeetingContent = {
      ...(await readContent(m, role)),
      pending: { requestId: job.requestId, question: body.question },
    };
    await writeContent(m, content, role);
  }
  try {
    await db.send(
      new UpdateCommand({
        TableName: env('MAIN_TABLE'),
        Key: { PK: spacePk(spaceOf(m)), SK: meetingSk(m.meetingId) },
        UpdateExpression: 'SET aiJob = :job, updatedAt = :at',
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(aiJob) OR aiJob.#st <> :working OR aiJob.requestedAt < :stale)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':job': job,
          ':at': now.toISOString(),
          ':working': 'working',
          ':stale': new Date(now.getTime() - JOB_STALE_MS).toISOString(),
        },
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
    throw new HttpError(
      409,
      `Still working on ${TASK_WORDS[m.aiJob?.task ?? body.task]}. One moment.`,
    );
  }
  await put('bmg.meetings', 'meeting.ai', {
    meetingId: m.meetingId,
    ...(m.artistId ? { artistId: m.artistId } : {}),
    requestId: job.requestId,
  });
  return job;
}

// ── Reviewing suggestions ─────────────────────────────────────────────────
const EDITABLE = ['after', 'name', 'goal', 'title', 'due', 'start', 'end', 'done'] as const;

export const SuggestionsPatch = z
  .object({
    contentVersion: z.number().int().min(0),
    updates: z
      .array(
        z
          .object({
            id: z.string().regex(/^c\d{1,3}$/),
            status: z.enum(SUGGESTION_STATUSES).optional(),
            /** Staff's own wording or dates; only the fields above, kind unchanged. */
            change: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict();

/** Accept, reject or edit suggestions; linked ones follow (spec 6.3). */
export async function reviewSuggestions(
  m: Meeting,
  principal: Principal,
  body: z.infer<typeof SuggestionsPatch>,
) {
  if (body.contentVersion !== m.contentVersion) {
    throw new HttpError(409, 'Someone else changed this meeting. Reload and try again.');
  }
  const role = principal.role as StaffRole;
  const content = await readContent(m, role);
  const set = content.suggestions;
  if (!set || set.applied) throw new HttpError(409, 'There are no suggestions waiting');
  const list = set.suggestions;
  const plan = body.updates.some((u) => u.change) ? await loadPlan(m.artistId!) : undefined;
  for (const u of body.updates) {
    const s = list.find((x) => x.id === u.id);
    if (!s) throw new HttpError(404, 'No such suggestion');
    if (u.change && plan) {
      const edits = Object.fromEntries(
        Object.entries(u.change).filter(([k]) => (EDITABLE as readonly string[]).includes(k)),
      );
      const merged = ProposedChange.safeParse({ ...s.change, ...edits });
      if (!merged.success) throw new HttpError(400, 'That change isn’t valid');
      // A milestone for a new stage is checked together with the stage.
      const parent = s.dependsOn ? list.find((x) => x.id === s.dependsOn) : undefined;
      const checked = reviewChanges(plan, [...(parent ? [parent.change] : []), merged.data]);
      const mine = checked.at(-1);
      if (!mine || (parent && checked.length < 2)) {
        throw new HttpError(
          400,
          'That edit doesn’t change the plan, or points at something that isn’t there',
        );
      }
      Object.assign(s, {
        change: mine.change,
        where: mine.where,
        before: mine.before,
        after: mine.after,
        checkThis: mine.checkThis,
        edited: true,
      });
      setStatus(list, s.id, 'accepted');
    }
    if (u.status) setStatus(list, s.id, u.status);
  }
  const waiting = list.filter((x) => x.status !== 'rejected').length;
  const version = await writeContent(m, content, role, { suggestionsWaiting: waiting });
  return { suggestions: set, contentVersion: version };
}

// ── Updating the plan ─────────────────────────────────────────────────────
export const PlanUpdateBody = z.object({ notifyArtist: z.boolean().default(true) }).strict();

/**
 * Tells the artist (unless staff chose not to) and the plan owner (rev 12)
 * what changed. The person who made the change isn't told.
 */
async function tellArtist(
  artistId: string,
  lines: string[],
  bySub: string,
  { undo = false, artist = true }: { undo?: boolean; artist?: boolean } = {},
) {
  await put('bmg.workspace', 'plan.updated', {
    artistId,
    undo,
    lines: lines.slice(0, 5),
    more: Math.max(0, lines.length - 5),
    bySub,
    ...(artist ? {} : { skipArtist: true }),
  });
}

/**
 * Update plan (spec 6.4): every accepted change lands in one save, with one
 * history entry, or none does. Changes that no longer fit (the plan changed
 * since) go back to waiting and nothing is saved, so staff see them first.
 */
export async function updatePlan(
  m: Meeting,
  principal: Principal,
  body: z.infer<typeof PlanUpdateBody>,
) {
  if (!m.artistId) throw new HttpError(400, 'Only a meeting about an artist can change a plan');
  const role = principal.role as StaffRole;
  const content = await readContent(m, role);
  const set = content.suggestions;
  if (!set || set.applied) throw new HttpError(409, 'There are no suggestions waiting');
  const accepted = set.suggestions.filter((s) => s.status === 'accepted');
  if (!accepted.length) throw new HttpError(400, 'Accept at least one change first');
  const plan = await loadPlan(m.artistId);
  if (!plan) throw new HttpError(409, 'This artist no longer has a plan');

  const { next, stale } = applySuggestions(plan, set.suggestions, newId);
  if (stale.length) {
    for (const s of set.suggestions as Suggestion[]) {
      if (stale.includes(s.id)) {
        s.status = 'waiting';
        s.stale = true;
      }
    }
    await writeContent(m, content, role);
    throw new HttpError(
      409,
      `The plan has changed since, so ${stale.length === 1 ? 'one change needs' : `${stale.length} changes need`} another look.`,
    );
  }
  const problem = planProblem(next);
  if (problem) throw new HttpError(400, `The plan wouldn’t be valid: ${problem}`);

  const saved = await savePlan({
    principal,
    artistId: m.artistId,
    current: plan,
    content: next,
    kind: 'meeting',
    lead: [`From the meeting “${m.title}”`],
  });
  const undoUntil = new Date(Date.now() + UNDO_DAYS * 86_400_000).toISOString();
  set.applied = {
    at: saved.at,
    by: principal.sub,
    planVersion: saved.version,
    undoUntil,
    before: { outcome: plan.outcome, measures: plan.measures, phases: plan.phases },
    changeCount: accepted.length,
  };
  // The plan is saved; recording it on the meeting is retried if someone edits at the same time.
  try {
    await writeContent(m, content, role, { undoUntil, suggestionsWaiting: 0 });
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 409)) throw err;
    const fresh = await loadMeeting(spaceOf(m), m.meetingId);
    const again = await readContent(fresh, role);
    again.suggestions = set;
    await writeContent(fresh, again, role, { undoUntil, suggestionsWaiting: 0 });
  }
  await tellArtist(m.artistId, saved.changes, principal.sub, { artist: body.notifyArtist });
  return { planVersion: saved.version, changes: saved.changes, undoUntil };
}

/** Undo (spec 6.4): for 7 days, and only if nobody has changed the plan since. */
export async function undoPlanUpdate(m: Meeting, principal: Principal) {
  if (!m.artistId) throw new HttpError(400, 'There’s no plan update to undo');
  const role = principal.role as StaffRole;
  const content = await readContent(m, role);
  const applied = content.suggestions?.applied;
  if (!applied || applied.undoneAt) throw new HttpError(409, 'There’s no plan update to undo');
  if (Date.now() > Date.parse(applied.undoUntil)) {
    throw new HttpError(409, 'It’s too late to undo this update. Change the plan in the editor.');
  }
  const plan = await loadPlan(m.artistId);
  if (!plan || plan.version !== applied.planVersion) {
    throw new HttpError(
      409,
      'The plan has changed since this update, so it can’t be undone. Change it in the plan editor instead.',
    );
  }
  const saved = await savePlan({
    principal,
    artistId: m.artistId,
    current: plan,
    content: applied.before,
    kind: 'undone',
    lead: [`Undid the update from the meeting “${m.title}”`],
  });
  applied.undoneAt = saved.at;
  await writeContent(m, content, role, {}, ['undoUntil']);
  await tellArtist(m.artistId, saved.changes, principal.sub, { undo: true });
  return { planVersion: saved.version };
}

/** A meeting whose plan update can still be undone can't be deleted (spec 9). */
export function deleteBlocked(m: Pick<Meeting, 'undoUntil'>): string | undefined {
  if (!m.undoUntil || Date.parse(m.undoUntil) < Date.now()) return undefined;
  const when = new Date(m.undoUntil).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Australia/Melbourne',
  });
  return `Its plan update can be undone until ${when}. Delete the meeting after that.`;
}
