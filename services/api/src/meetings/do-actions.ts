import type { Principal } from '@bmg/authz';
import { z } from 'zod';
import { HttpError } from '../lib.ts';
import {
  ActionEdits,
  actionsWaiting,
  resultIdFrom,
  stepFor,
  withEdits,
  type MeetingAction,
} from './meeting-actions.ts';
import { meetingDate, spaceOf, type Meeting, type MeetingContent } from './model.ts';
import { mutateContent, updateMeeting } from './store.ts';

/**
 * Do it and Ignore for a meeting's actions (rev 11 change). Do it claims the
 * action first, so two people pressing it at once can't make two to-dos, then
 * makes one normal API call with the person's own token: they can only do
 * what they could do by hand, and the usual rules and notifications apply.
 */

type StaffRole = 'bmg-admin' | 'bmg-staff';

/** One call to the app's own API, as the person who pressed Do it. */
export type ApiCall = (step: {
  method: string;
  path: string;
  body: unknown;
}) => Promise<{ ok: boolean; out: Record<string, unknown> }>;

/** A Do it that never finished (the request died) frees the action after this. */
export const DOING_STALE_MS = 2 * 60_000;

export const DoActionBody = z.object({ edits: ActionEdits.optional() }).strict();

export const ActionsPatch = z
  .object({
    updates: z
      .array(
        z
          .object({
            id: z.string().regex(/^a\d{1,3}$/),
            /** ignored: Ignore. waiting: undo an Ignore. */
            status: z.enum(['ignored', 'waiting']),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

const WHY_NOT: Record<string, string> = {
  done: 'This action has already been done',
  ignored: 'This action was ignored. Bring it back first.',
  doing: 'Someone is doing this action right now',
};

function find(content: MeetingContent, id: string): MeetingAction {
  const a = content.actions?.items.find((x) => x.id === id);
  if (!a) throw new HttpError(404, 'No such action');
  return a;
}

function replace(content: MeetingContent, next: MeetingAction): MeetingContent {
  return {
    ...content,
    actions: {
      ...content.actions!,
      items: content.actions!.items.map((x) => (x.id === next.id ? next : x)),
    },
  };
}

const free = (a: MeetingAction, now: number) =>
  a.status === 'waiting' ||
  (a.status === 'doing' && Date.parse(a.decidedAt ?? '') < now - DOING_STALE_MS);

async function save(
  m: Meeting,
  role: StaffRole,
  change: (c: MeetingContent) => MeetingContent,
): Promise<{ meeting: Meeting; content: MeetingContent }> {
  let waiting = 0;
  const saved = await mutateContent(spaceOf(m), m.meetingId, role, (c) => {
    const next = change(c);
    waiting = actionsWaiting(next.actions);
    return next;
  });
  await updateMeeting(saved.meeting, { actionsWaiting: waiting });
  return { meeting: { ...saved.meeting, actionsWaiting: waiting }, content: saved.content };
}

export async function doAction(
  m: Meeting,
  principal: Principal,
  actionId: string,
  body: z.infer<typeof DoActionBody>,
  call: ApiCall,
  today: string,
): Promise<{ action: MeetingAction; ok: boolean; error?: string; meeting: Meeting }> {
  if (!m.artistId) throw new HttpError(400, 'Only a meeting about an artist has actions');
  const role = principal.role as StaffRole;
  const now = Date.now();

  // 1. Claim it, with any edits staff made.
  let claimed!: MeetingAction;
  await save(m, role, (c) => {
    const a = find(c, actionId);
    if (!free(a, now)) throw new HttpError(409, WHY_NOT[a.status] ?? 'Not possible now');
    let edited: MeetingAction;
    try {
      edited = withEdits(a, body.edits);
    } catch {
      throw new HttpError(400, 'Check the details: something isn’t filled in right');
    }
    claimed = {
      ...edited,
      status: 'doing',
      decidedBy: principal.sub,
      decidedAt: new Date(now).toISOString(),
    };
    delete claimed.error;
    return replace(c, claimed);
  });

  // 2. Do it through the normal API.
  let ok = false;
  let error: string | undefined;
  let resultId: string | undefined;
  try {
    const res = await call(
      stepFor(claimed, m.artistId, { title: m.title, date: meetingDate(m.startedAt) }, today),
    );
    ok = res.ok;
    if (ok) resultId = resultIdFrom(claimed.kind, res.out);
    else error = String(res.out.detail ?? res.out.title ?? 'That wasn’t allowed');
  } catch {
    error = 'The app didn’t answer. Try again.';
  }

  // 3. Done, or back to waiting with what went wrong.
  const finished: MeetingAction = ok
    ? { ...claimed, status: 'done', ...(resultId ? { resultId } : {}) }
    : { ...claimed, status: 'waiting', error: error! };
  const saved = await save(m, role, (c) => replace(c, finished));
  return { action: finished, ok, ...(error ? { error } : {}), meeting: saved.meeting };
}

/** Ignore actions, or bring ignored ones back. */
export async function decideActions(
  m: Meeting,
  principal: Principal,
  body: z.infer<typeof ActionsPatch>,
): Promise<{ meeting: Meeting; content: MeetingContent }> {
  if (!m.artistId) throw new HttpError(400, 'Only a meeting about an artist has actions');
  const at = new Date().toISOString();
  return save(m, principal.role as StaffRole, (c) => {
    let next = c;
    for (const u of body.updates) {
      const a = find(next, u.id);
      const from = u.status === 'ignored' ? 'waiting' : 'ignored';
      if (a.status !== from) {
        throw new HttpError(409, WHY_NOT[a.status] ?? 'This action has changed. Reload.');
      }
      const updated: MeetingAction = {
        ...a,
        status: u.status,
        decidedBy: principal.sub,
        decidedAt: at,
      };
      if (u.status === 'waiting') {
        delete updated.decidedBy;
        delete updated.decidedAt;
      }
      next = replace(next, updated);
    }
    return next;
  });
}
