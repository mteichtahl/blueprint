import { z } from 'zod';

/**
 * Actions found in a meeting (rev 11 change). After a meeting about an
 * artist is transcribed, the AI lists things the meeting agreed that the app
 * can do: add a to-do, create a gig. Each one waits for a person to press
 * **Do it** (carried out through the normal API with that person's own
 * permissions) or **Ignore**. Plan changes keep their own review (spec 6);
 * the screen shows them as one more action. Pure.
 */

export const ACTION_KINDS = ['todo', 'gig'] as const;
export type MeetingActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_STATUSES = ['waiting', 'doing', 'done', 'ignored'] as const;
export type MeetingActionStatus = (typeof ACTION_STATUSES)[number];

/** Most actions kept from one look at a meeting. */
export const MAX_MEETING_ACTIONS = 15;

const IsoDate = z.iso.date();
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const TodoFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(2000).optional(),
    due: IsoDate.optional(),
  })
  .strict();
export type TodoFields = z.infer<typeof TodoFields>;

export const GigFields = z
  .object({
    title: z.string().trim().min(1).max(120),
    date: IsoDate,
    startTime: Time.optional(),
    venue: z.string().trim().max(160).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export type GigFields = z.infer<typeof GigFields>;

export interface MeetingAction {
  /** `a1`, `a2`… within one set. */
  id: string;
  kind: MeetingActionKind;
  /** One line saying why: what the meeting agreed. */
  why: string;
  /** Transcript line ids it comes from. */
  refs: number[];
  todo?: TodoFields;
  gig?: GigFields;
  status: MeetingActionStatus;
  /** Who pressed Do it or Ignore, and when. */
  decidedBy?: string;
  decidedAt?: string;
  /** What Do it made (the to-do's or gig's id). */
  resultId?: string;
  /** Why the last Do it didn't work (it's back to waiting). */
  error?: string;
}

export interface MeetingActionSet {
  requestId: string;
  createdAt: string;
  createdBy: string;
  items: MeetingAction[];
}

export const ACTIONS_REPLY_SHAPE = `Reply with JSON only, no other text:
{"actions":[
 {"kind":"todo","why":"<one line: what was agreed>","refs":[<transcript line numbers>],"title":"<starts with a verb>","notes":"<optional>","due":"YYYY-MM-DD"},
 {"kind":"gig","why":"…","refs":[…],"title":"<gig name>","date":"YYYY-MM-DD","startTime":"HH:MM","venue":"<optional>","notes":"<optional>"}
]}
Leave out optional fields the meeting didn't settle. A gig needs a date. If there's nothing to do, reply {"actions":[]}.`;

const Refs = z.array(z.number().int().min(0)).max(20).default([]);
const Why = z.string().trim().min(1).max(300);
const ReplyItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('todo'),
    why: Why,
    refs: Refs,
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(2000).optional().catch(undefined),
    due: IsoDate.optional().catch(undefined),
  }),
  z.object({
    kind: z.literal('gig'),
    why: Why,
    refs: Refs,
    title: z.string().trim().min(1).max(120),
    date: IsoDate,
    startTime: Time.optional().catch(undefined),
    venue: z.string().trim().max(160).optional().catch(undefined),
    notes: z.string().trim().max(2000).optional().catch(undefined),
  }),
]);
const ActionsReply = z.object({ actions: z.array(z.unknown()).max(50) });

const defined = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;

/**
 * The actions in a model's reply. Anything malformed is dropped one by one
 * (a gig with no date, an unknown kind), as are lines that don't exist.
 * Undefined when the reply isn't the right shape at all.
 */
export function actionsFrom(
  reply: unknown,
  segments: { id: number }[],
  meta: Omit<MeetingActionSet, 'items'>,
): MeetingActionSet | undefined {
  const r = ActionsReply.safeParse(reply);
  if (!r.success) return undefined;
  const ids = new Set(segments.map((s) => s.id));
  const items: MeetingAction[] = [];
  for (const raw of r.data.actions) {
    const a = ReplyItem.safeParse(raw);
    if (!a.success) continue;
    const base = {
      id: `a${items.length + 1}`,
      kind: a.data.kind,
      why: a.data.why,
      refs: [...new Set(a.data.refs)].filter((x) => ids.has(x)),
      status: 'waiting' as const,
    };
    if (a.data.kind === 'todo') {
      const { title, notes, due } = a.data;
      items.push({ ...base, todo: defined({ title, notes, due }) });
    } else {
      const { title, date, startTime, venue, notes } = a.data;
      items.push({ ...base, gig: defined({ title, date, startTime, venue, notes }) });
    }
    if (items.length >= MAX_MEETING_ACTIONS) break;
  }
  return { ...meta, items };
}

const titleOf = (a: MeetingAction) => (a.todo?.title ?? a.gig?.title ?? '').trim().toLowerCase();

/**
 * Looking again: what people already did, ignored or are doing stays as it
 * was (same ids, so a Do it in progress still finds its action). The new
 * look replaces what was still waiting, without repeating anything already
 * decided.
 */
export function mergeActions(
  before: MeetingActionSet | undefined,
  next: MeetingActionSet,
): MeetingActionSet {
  const decided = (before?.items ?? []).filter((a) => a.status !== 'waiting');
  const seen = new Set(decided.map((a) => `${a.kind}:${titleOf(a)}`));
  let n = Math.max(0, ...decided.map((a) => Number(a.id.slice(1)) || 0));
  const fresh = next.items
    .filter((a) => !seen.has(`${a.kind}:${titleOf(a)}`))
    .map((a) => ({ ...a, id: `a${++n}` }));
  return { ...next, items: [...decided, ...fresh] };
}

/** How many still need someone to decide. */
export const actionsWaiting = (set: MeetingActionSet | undefined) =>
  (set?.items ?? []).filter((a) => a.status === 'waiting').length;

/** Staff's own wording before Do it; only the action's own fields. */
export const ActionEdits = z
  .object({ todo: TodoFields.partial().optional(), gig: GigFields.partial().optional() })
  .strict();
export type ActionEdits = z.infer<typeof ActionEdits>;

/** The action with staff's edits applied, re-checked as a whole. */
export function withEdits(a: MeetingAction, edits: ActionEdits | undefined): MeetingAction {
  if (!edits) return a;
  if (a.kind === 'todo') {
    if (edits.gig) throw new Error('A to-do has no gig fields');
    return { ...a, todo: TodoFields.parse(defined({ ...a.todo, ...edits.todo })) };
  }
  if (edits.todo) throw new Error('A gig has no to-do fields');
  return { ...a, gig: GigFields.parse(defined({ ...a.gig, ...edits.gig })) };
}

/** Where the meeting came from, at the end of what Do it makes. */
const fromLine = (meeting: { title: string; date: string }) =>
  `From the meeting “${meeting.title}”, ${meeting.date}.`;

/** The one normal-API call Do it makes for an action. */
export function stepFor(
  a: MeetingAction,
  artistId: string,
  meeting: { title: string; date: string; shared: boolean },
  today: string,
): { method: 'POST'; path: string; body: Record<string, unknown> } {
  const notes = (own: string | undefined) =>
    [own, fromLine(meeting)].filter(Boolean).join('\n\n').slice(0, 2000);
  if (a.kind === 'todo' && a.todo) {
    return {
      method: 'POST',
      path: `/artists/${artistId}/todos`,
      body: defined({
        title: a.todo.title,
        notes: notes(a.todo.notes),
        // A date already gone isn't a due date any more.
        due: a.todo.due && a.todo.due >= today ? a.todo.due : undefined,
        // From a meeting the artist can't see: the to-do stays BMG-only too.
        bmgOnly: meeting.shared ? undefined : true,
      }),
    };
  }
  if (a.kind === 'gig' && a.gig) {
    return {
      method: 'POST',
      path: `/artists/${artistId}/gigs`,
      body: defined({
        title: a.gig.title,
        date: a.gig.date,
        startTime: a.gig.startTime,
        venue: a.gig.venue,
        notes: notes(a.gig.notes),
        // A gig from a meeting is an idea until someone confirms it.
        status: 'idea',
      }),
    };
  }
  throw new Error('This action is missing its details');
}

/** The id in what the API sent back, if any. */
export const resultIdFrom = (kind: MeetingActionKind, out: Record<string, unknown>) => {
  const v = kind === 'todo' ? (out.todoId ?? out.id) : (out.gigId ?? out.id);
  return typeof v === 'string' ? v : undefined;
};
