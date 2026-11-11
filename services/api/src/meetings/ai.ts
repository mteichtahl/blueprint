import { z } from 'zod';
import { clock, meetingDate, speakerName, type Meeting, type MeetingContent } from './model.ts';

/**
 * Summaries and questions about a meeting (rev 11, spec 5.2). Pure.
 *
 * The prompts are editable by an admin; the reply shape is appended by code,
 * so an edit can't change it. Every point carries the transcript lines it
 * came from, and lines that don't exist are dropped, so every claim on screen
 * links to a moment someone can play and check.
 */

export const SUMMARY_KINDS = ['quick', 'full'] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

export interface SummaryPoint {
  text: string;
  /** Transcript line ids. */
  refs: number[];
}
export interface ActionItem extends SummaryPoint {
  owner?: string;
  due?: string;
}
export interface Summary {
  id: string;
  kind: SummaryKind;
  createdAt: string;
  createdBy: string;
  sections: { heading: string; points: SummaryPoint[] }[];
  actions: ActionItem[];
}
export interface Answer {
  id: string;
  question: string;
  answer: string;
  refs: number[];
  createdAt: string;
  createdBy: string;
}

/** Older summaries and answers are kept, up to these. */
export const MAX_SUMMARIES = 10;
export const MAX_ANSWERS = 20;
export const QUESTION_MAX = 500;

/** The AI work a meeting can have running. */
export const AI_TASKS = ['quick', 'full', 'ask', 'suggest'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface AiJob {
  task: AiTask;
  status: 'working' | 'failed';
  requestId: string;
  requestedBy: string;
  requestedAt: string;
  error?: string;
}

/** A job older than this is treated as lost and can be started again. */
export const JOB_STALE_MS = 6 * 60_000;

/** Transcript lines for the model: `[12] (3:04) Kyra: …`. */
export function transcriptLines(content: Pick<MeetingContent, 'segments' | 'speakers'>): string {
  return (
    content.segments
      .map((s) => `[${s.id}] (${clock(s.start)}) ${speakerName(content, s.speaker)}: ${s.text}`)
      .join('\n') || '(nothing was said)'
  );
}

export function promptVars(
  m: Pick<Meeting, 'title' | 'startedAt' | 'attendees' | 'artistId'>,
  content: MeetingContent,
  opts: { artistName?: string; today: string },
) {
  return {
    today: opts.today,
    title: m.title,
    meetingDate: meetingDate(m.startedAt),
    attendees: m.attendees.map((a) => a.name).join(', ') || '(not listed)',
    about: m.artistId ? (opts.artistName ?? 'an artist') : 'Blueprint itself',
    artistName: opts.artistName ?? 'The artist',
    notes:
      [
        content.notes.trim(),
        ...content.markers.map((k) => `Marked at ${clock(k.at)}${k.note ? `: ${k.note}` : ''}`),
      ]
        .filter(Boolean)
        .join('\n') || '(none)',
    transcript: transcriptLines(content),
  };
}

export const SUMMARY_REPLY_SHAPE: Record<SummaryKind, string> = {
  quick: `Reply with JSON only, no other text:
{"sections":[{"heading":"Summary","points":[{"text":"…","refs":[<transcript line numbers>]}]}],"actions":[]}`,
  full: `Reply with JSON only, no other text:
{"sections":[{"heading":"Overview|Decisions|Open questions|Plan","points":[{"text":"…","refs":[<transcript line numbers>]}]}],
 "actions":[{"text":"<what, starting with a verb>","owner":"<who, as named in the meeting>","due":"YYYY-MM-DD","refs":[…]}]}
Leave out "owner" or "due" when the meeting didn't say.`,
};

export const ANSWER_REPLY_SHAPE = `Reply with JSON only, no other text:
{"answer":"…","refs":[<transcript line numbers it comes from>]}`;

const Refs = z.array(z.number().int().min(0)).max(20).default([]);
const Point = z.object({ text: z.string().trim().min(1).max(1000), refs: Refs });
const SummaryReply = z.object({
  sections: z
    .array(z.object({ heading: z.string().trim().min(1).max(60), points: z.array(Point).max(20) }))
    .max(8),
  actions: z
    .array(
      Point.extend({
        owner: z.string().trim().max(120).optional(),
        due: z.iso.date().optional().catch(undefined),
      }),
    )
    .max(30)
    .default([]),
});
const AnswerReply = z.object({ answer: z.string().trim().min(1).max(3000), refs: Refs });

/** The first JSON object in a model's reply. */
export function jsonIn(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const keepRefs = (refs: number[], ids: Set<number>) => [...new Set(refs)].filter((r) => ids.has(r));

/** A summary from the model's reply, or undefined if it isn't one. */
export function summaryFrom(
  reply: unknown,
  content: Pick<MeetingContent, 'segments'>,
  meta: Pick<Summary, 'id' | 'kind' | 'createdAt' | 'createdBy'>,
): Summary | undefined {
  const r = SummaryReply.safeParse(reply);
  if (!r.success) return undefined;
  const ids = new Set(content.segments.map((s) => s.id));
  const sections = r.data.sections
    .map((s) => ({
      heading: s.heading,
      points: s.points.map((p) => ({ text: p.text, refs: keepRefs(p.refs, ids) })),
    }))
    .filter((s) => s.points.length);
  const actions =
    meta.kind === 'full'
      ? r.data.actions.map((a) => ({
          text: a.text,
          refs: keepRefs(a.refs, ids),
          ...(a.owner ? { owner: a.owner } : {}),
          ...(a.due ? { due: a.due } : {}),
        }))
      : [];
  if (!sections.length && !actions.length) return undefined;
  return { ...meta, sections, actions };
}

export function answerFrom(
  reply: unknown,
  content: Pick<MeetingContent, 'segments'>,
  meta: Omit<Answer, 'answer' | 'refs'>,
): Answer | undefined {
  const r = AnswerReply.safeParse(reply);
  if (!r.success) return undefined;
  const ids = new Set(content.segments.map((s) => s.id));
  return { ...meta, answer: r.data.answer, refs: keepRefs(r.data.refs, ids) };
}

/** The summary as Markdown, for the top of the meeting note. */
export function summaryMarkdown(s: Summary, content: Pick<MeetingContent, 'segments'>): string {
  const at = new Map(content.segments.map((x) => [x.id, x.start]));
  const times = (refs: number[]) => {
    const t = refs.map((r) => at.get(r)).filter((x): x is number => x !== undefined);
    return t.length ? ` (${t.slice(0, 3).map(clock).join(', ')})` : '';
  };
  const lines: string[] = [];
  for (const sec of s.sections) {
    if (s.sections.length > 1) lines.push(`### ${sec.heading}`, '');
    for (const p of sec.points) lines.push(`- ${p.text}${times(p.refs)}`);
    lines.push('');
  }
  if (s.actions.length) {
    lines.push('### Action items', '');
    for (const a of s.actions) {
      const who = a.owner ? `**${a.owner}:** ` : '';
      lines.push(`- [ ] ${who}${a.text}${a.due ? ` (by ${a.due})` : ''}${times(a.refs)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
