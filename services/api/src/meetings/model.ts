import { z } from 'zod';
import { ARTIST_ID_PATTERN } from '@bmg/crypto';
import { authorize, type Principal } from '@bmg/authz';
import { extensionOf, gigNamePart } from '../gigs/media.ts';
import { artistPk } from '../workspace/model.ts';
import type { AiJob, Answer, Summary } from './ai.ts';
import type { SuggestionSet } from './plan-changes.ts';
import type { MeetingActionSet } from './meeting-actions.ts';

/**
 * Meeting notes (rev 11): Blueprint staff record a meeting, it's transcribed
 * and filed in the Library, and staff can ask for a summary and suggested
 * plan changes. Pure: keys, schemas, names, the transcript builder and the
 * note's Markdown, all unit-tested.
 *
 * Storage:
 * - The meeting (metadata only) is `<space PK> / MEETING#<id>` in the main
 *   table, where the space is the artist (`ARTIST#…`) or Blueprint
 *   (`ORG#meetings`). GSI3 (`MEETINGS`, newest first) lists them all.
 * - What was said (transcript, typed notes, markers, speaker names,
 *   summaries) is one JSON object in the space's own bucket: under the
 *   artist's key in `artist-data`, or the platform key in `org-data`. It's
 *   written as a new object per change (`content-<n>.json`) and the item's
 *   `contentVersion` moves only if nobody saved in between.
 * - The audio and the meeting note are ordinary Library files in
 *   `Meetings › <year> › <month>`, so folders, access, versions and the
 *   knowledge base all apply unchanged.
 */

// ── Keys ──────────────────────────────────────────────────────────────────
export const LIBRARY_MEETINGS_PK = 'ORG#meetings';
export const meetingSk = (meetingId: string) => `MEETING#${meetingId}`;
export const MEETING_PREFIX = 'MEETING#';
/** GSI3 partition: every meeting, newest first (`<createdAt>#<meetingId>`). */
export const MEETINGS_GSI3PK = 'MEETINGS';
export const MEETING_ID_PATTERN = /^[a-z0-9]{10,40}$/;

export type MeetingSpace = { kind: 'artist'; artistId: string } | { kind: 'library' };

export const spacePk = (s: MeetingSpace) =>
  s.kind === 'artist' ? artistPk(s.artistId) : LIBRARY_MEETINGS_PK;

/** The space as it appears in a path: `library`, or the artist's id. */
export const spaceParam = (s: MeetingSpace) => (s.kind === 'artist' ? s.artistId : 'library');

export function parseSpaceParam(value: string | undefined): MeetingSpace | undefined {
  if (value === 'library') return { kind: 'library' };
  if (value && ARTIST_ID_PATTERN.test(value)) return { kind: 'artist', artistId: value };
  return undefined;
}

export const spaceOf = (m: Pick<Meeting, 'artistId'>): MeetingSpace =>
  m.artistId ? { kind: 'artist', artistId: m.artistId } : { kind: 'library' };

/** Where the meeting's content object lives in its space's bucket. */
export function contentKey(m: Pick<Meeting, 'meetingId' | 'artistId'>, version: number) {
  const base = m.artistId
    ? `artists/${m.artistId}/meetings/${m.meetingId}`
    : `meetings/${m.meetingId}`;
  return `${base}/content-${version}.json`;
}

// ── The meeting ───────────────────────────────────────────────────────────
/**
 * - `recording`: being recorded (or the upload hasn't been picked yet).
 * - `uploading`: the audio is on its way, or waiting for the malware scan.
 * - `transcribing`: Amazon Transcribe is working on it.
 * - `ready`: the transcript is in.
 * - `failed`: the audio was rejected, or transcription failed (see `statusReason`).
 * - `no-ai`: an artist in it turned AI off, so only the audio and notes are kept.
 * - `off`: transcription is switched off for the account (no AWS AI opt-out yet).
 */
export const MEETING_STATUSES = [
  'recording',
  'uploading',
  'transcribing',
  'ready',
  'failed',
  'no-ai',
  'off',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const ATTENDEE_KINDS = ['staff', 'artist', 'contact'] as const;
export interface Attendee {
  kind: (typeof ATTENDEE_KINDS)[number];
  /** A Cognito sub (staff), an artist id, or a contact id. */
  id: string;
  name: string;
}

/** The wording ticked before recording; kept with the meeting. */
export const CONSENT_WORDING = {
  recording: 'Everyone in this meeting knows it’s being recorded and has agreed.',
  upload: 'I have everyone’s agreement to this recording.',
} as const;

export interface Meeting {
  meetingId: string;
  /** Set for a meeting about an artist; absent for Blueprint only. */
  artistId?: string;
  title: string;
  source: 'recording' | 'upload';
  createdBy: string;
  createdByRole: 'bmg-admin' | 'bmg-staff';
  createdAt: string;
  /** When the recording started (or the upload was made). */
  startedAt: string;
  durationSec?: number;
  attendees: Attendee[];
  consent: { bySub: string; at: string; wording: string };
  /** Shared with the artist: they can open the note and the audio in their Library. */
  shared: boolean;
  status: MeetingStatus;
  statusReason?: string;
  folderId?: string;
  audioFileId?: string;
  noteFileId?: string;
  /** Transcription attempts so far; the job name carries the number. */
  attempts?: number;
  transcribeJob?: string;
  contentVersion: number;
  updatedAt: string;
  /** A summary, answer or plan suggestions being worked on (rev 11, spec 5.2 and 6). */
  aiJob?: AiJob;
  /** A plan update from this meeting can be undone until then; the meeting can't be deleted before. */
  undoUntil?: string;
  /** Suggested plan changes still to be decided or applied (for counts on the Plan tab). */
  suggestionsWaiting?: number;
  /** Actions (to-dos, gigs) still waiting for Do it or Ignore. */
  actionsWaiting?: number;
}

/** Everything said and written in a meeting (kept encrypted in the space's bucket). */
export interface Segment {
  id: number;
  /** Transcribe's label (`spk_0`…), or `''` when speakers weren't separated. */
  speaker: string;
  /** Seconds from the start. */
  start: number;
  end: number;
  text: string;
}

export interface Marker {
  /** Seconds from the start. */
  at: number;
  note?: string;
}

export interface MeetingContent {
  notes: string;
  markers: Marker[];
  /** `spk_0` → the attendee's name, set on "Who's speaking?". */
  speakers: Record<string, string>;
  segments: Segment[];
  /** Someone fixed words in the transcript. */
  edited?: boolean;
  /** Summaries, oldest first (the latest goes into the note). */
  summaries?: Summary[];
  /** "Ask about this meeting", oldest first. */
  answers?: Answer[];
  /** Suggested changes to the linked artist's plan. */
  suggestions?: SuggestionSet;
  /** To-dos and gigs the meeting agreed, waiting for Do it or Ignore. */
  actions?: MeetingActionSet;
  /** A question waiting for its answer. */
  pending?: { requestId: string; question: string };
}

export const emptyContent = (): MeetingContent => ({
  notes: '',
  markers: [],
  speakers: {},
  segments: [],
});

// ── Limits ────────────────────────────────────────────────────────────────
export const TITLE_MAX = 120;
export const NOTES_MAX = 20_000;
export const MARKERS_MAX = 200;
export const MAX_ATTENDEES = 30;
/** Three hours (spec 3.1); the recorder stops itself here. */
export const MAX_DURATION_SEC = 3 * 3600;
/** Transcribe separates up to 30 voices; past 10 it gets less reliable. */
export const MAX_SPEAKERS = 10;

// ── Requests ──────────────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const NO_CONTROL = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const Title = z
  .string()
  .trim()
  .min(1, 'Give the meeting a title')
  .max(TITLE_MAX, `Titles are limited to ${TITLE_MAX} characters`)
  .refine(NO_CONTROL, 'Titles cannot contain control characters');

const AttendeeBody = z
  .object({
    kind: z.enum(ATTENDEE_KINDS),
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(120).refine(NO_CONTROL),
  })
  .strict();

const Seconds = z.number().min(0).max(MAX_DURATION_SEC);

export const MeetingCreate = z
  .object({
    title: Title,
    /** Leave out for a Blueprint-only meeting. */
    artistId: z.string().regex(ARTIST_ID_PATTERN, 'Unknown artist').optional(),
    source: z.enum(['recording', 'upload']).default('recording'),
    attendees: z.array(AttendeeBody).max(MAX_ATTENDEES).default([]),
    shared: z.boolean().default(false),
    /** The consent tick. Nothing is created without it. */
    consent: z.literal(true, 'Everyone must agree to the recording first'),
    startedAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine((m) => !(m.shared && !m.artistId), {
    message: 'Only a meeting about an artist can be shared with them',
  });

export const MarkerBody = z
  .object({
    at: Seconds,
    note: z.string().trim().max(200).refine(NO_CONTROL).optional(),
  })
  .strict();

const SegmentEdit = z
  .object({
    id: z.number().int().min(0),
    text: z.string().trim().max(5000).refine(NO_CONTROL).optional(),
    speaker: z
      .string()
      .regex(/^(spk_\d{1,2})?$/)
      .optional(),
  })
  .strict();

export const MeetingPatch = z
  .object({
    title: Title.optional(),
    attendees: z.array(AttendeeBody).max(MAX_ATTENDEES).optional(),
    shared: z.boolean().optional(),
    notes: z.string().max(NOTES_MAX).refine(NO_CONTROL).optional(),
    markers: z.array(MarkerBody).max(MARKERS_MAX).optional(),
    /** `spk_0` → a name; an empty name clears it. */
    speakers: z
      .record(z.string().regex(/^spk_\d{1,2}$/), z.string().trim().max(120).refine(NO_CONTROL))
      .optional(),
    /** Fixes to the transcript: each one replaces that line's text or speaker. */
    segments: z.array(SegmentEdit).max(2000).optional(),
    /** Recording finished: how long it was. */
    durationSec: Seconds.optional(),
    /** The content version the editor started from (for notes, markers, speakers, segments). */
    contentVersion: z.number().int().min(0).optional(),
  })
  .strict();
export type MeetingPatch = z.infer<typeof MeetingPatch>;

/** Audio a meeting can be transcribed from (spec 3.3). */
export const AUDIO_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
  'video/mp4',
  'video/webm',
] as const;

/** Transcribe's media formats, from the recording's type. */
export function mediaFormat(contentType: string): string | undefined {
  const base = contentType.toLowerCase().split(';')[0]!.trim();
  if (base.endsWith('/webm')) return 'webm';
  if (base.endsWith('/ogg')) return 'ogg';
  if (base === 'audio/x-m4a' || base === 'audio/m4a' || base === 'audio/aac') return 'm4a';
  if (base.endsWith('/mp4')) return 'mp4';
  if (base === 'audio/mpeg' || base === 'audio/mp3') return 'mp3';
  if (base.includes('wav')) return 'wav';
  if (base.includes('flac')) return 'flac';
  return undefined;
}

export function isMeetingAudio(contentType: string): boolean {
  const base = contentType.toLowerCase().split(';')[0]!.trim();
  return (AUDIO_TYPES as readonly string[]).includes(base);
}

// ── Where it's filed and what it's called ─────────────────────────────────
export const MEETINGS_FOLDER = 'Meetings';
export const MEETING_TIME_ZONE = 'Australia/Melbourne';

/** The meeting's date in Melbourne: `2026-11-11`. */
export function meetingDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MEETING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `['Meetings', '2026', '11']` for a meeting on 11 Nov 2026 (Melbourne). */
export function meetingFolderPath(startedAt: string): [string, string, string] {
  const [y, m] = meetingDate(startedAt).split('-');
  return [MEETINGS_FOLDER, y!, m!];
}

export const meetingFolderLabel = (startedAt: string) => meetingFolderPath(startedAt).join(' › ');

/** `2026-11-11_Meeting with Chloe Poli_audio.webm`. */
export function meetingFileName(
  m: Pick<Meeting, 'title' | 'startedAt'>,
  kind: 'audio' | 'notes',
  original = '',
): string {
  const ext = kind === 'notes' ? '.md' : extensionOf(original) || '.webm';
  return `${meetingDate(m.startedAt)}_${gigNamePart(m.title)}_${kind}${ext}`;
}

/**
 * Transcribe job names: unique per attempt, recognisable as this
 * environment's, and carrying the meeting's space so the finished-job event
 * leads straight back to the meeting.
 */
export const jobPrefix = (project: string, env: string) => `${project}-${env}-meeting-`;
export const jobName = (
  project: string,
  env: string,
  m: Pick<Meeting, 'meetingId' | 'artistId'>,
  attempt: number,
) => `${jobPrefix(project, env)}${m.artistId ?? 'library'}-${m.meetingId}-${attempt}`;

export function meetingFromJob(
  project: string,
  env: string,
  name: string,
): { space: MeetingSpace; meetingId: string; attempt: number } | undefined {
  const m = new RegExp(
    `^${jobPrefix(project, env)}(library|art_[a-z0-9]{10,32})-([a-z0-9]{10,40})-(\\d{1,4})$`,
  ).exec(name);
  if (!m) return undefined;
  const space = parseSpaceParam(m[1]);
  return space ? { space, meetingId: m[2]!, attempt: Number(m[3]) } : undefined;
}

/** How many voices to ask Transcribe to separate. */
export function speakerCount(attendees: readonly Attendee[]): number {
  return Math.min(MAX_SPEAKERS, Math.max(2, attendees.length));
}

// ── Who can do what ───────────────────────────────────────────────────────
/** Meetings are a Blueprint feature: artists never use the meetings API. */
export const isBlueprint = (p: Pick<Principal, 'role'>) =>
  p.role === 'bmg-admin' || p.role === 'bmg-staff';

/**
 * Whether this person can open (or change) a meeting in a space: Blueprint
 * only, and for an artist's meeting, staff must be assigned to the artist.
 */
export function meetingAllowed(p: Principal, space: MeetingSpace, action: 'read' | 'write') {
  if (!isBlueprint(p)) return { allow: false, reason: 'Meetings are for the Blueprint team' };
  if (space.kind === 'library') {
    return authorize(p, action, { kind: 'org-shared', visibility: 'bmg-only' });
  }
  return authorize(p, action, {
    kind: 'artist-data',
    artistId: space.artistId,
    visibility: 'bmg-only',
  });
}

/** Who can delete a meeting: whoever recorded it, or an admin. */
export const canDeleteMeeting = (
  p: Pick<Principal, 'role' | 'sub'>,
  m: Pick<Meeting, 'createdBy'>,
) => p.role === 'bmg-admin' || p.sub === m.createdBy;

/** What decides whether a meeting may be transcribed, in order. */
export function transcriptionBlock(input: {
  /** AI choice of each artist involved (the linked artist and artist attendees). */
  artistsOptedIn: boolean[];
  /** The account's AWS AI services opt-out covers Transcribe. */
  awsOptedOut: boolean;
}): { status: 'no-ai' | 'off'; reason: string } | undefined {
  if (input.artistsOptedIn.some((on) => !on)) {
    return {
      status: 'no-ai',
      reason:
        'An artist in this meeting has turned off AI assistance, so it can’t be transcribed. The recording and your notes are kept.',
    };
  }
  if (!input.awsOptedOut) {
    return {
      status: 'off',
      reason:
        'Transcription is waiting for the AWS AI opt-out (`blueprint ai opt-out`). The recording is kept, and it’s transcribed automatically within 15 minutes of the opt-out taking effect.',
    };
  }
  return undefined;
}

/** The artists whose AI choice matters: the linked artist and any artist attendees. */
export function artistsInvolved(m: Pick<Meeting, 'artistId' | 'attendees'>): string[] {
  const ids = new Set<string>();
  if (m.artistId) ids.add(m.artistId);
  for (const a of m.attendees)
    if (a.kind === 'artist' && ARTIST_ID_PATTERN.test(a.id)) ids.add(a.id);
  return [...ids];
}

// ── Transcript ────────────────────────────────────────────────────────────
interface TranscribeItem {
  type?: string;
  start_time?: string;
  end_time?: string;
  speaker_label?: string;
  alternatives?: { content?: string }[];
}

/** A pause this long starts a new paragraph, even for the same speaker. */
const PAUSE_SEC = 2.5;
/** Long monologues are split at a sentence end after this many words. */
const PARAGRAPH_WORDS = 90;

/**
 * Turns Amazon Transcribe's output into paragraphs by speaker: words of the
 * same speaker run together, punctuation sticks to the word before it, and a
 * new paragraph starts on a change of speaker, a long pause, or at a
 * sentence end once a paragraph gets long.
 */
export function segmentsFromTranscribe(output: unknown): Segment[] {
  const results = (output as { results?: { items?: TranscribeItem[] } } | null)?.results;
  const items = Array.isArray(results?.items) ? results.items : [];
  const segments: Segment[] = [];
  let cur: (Segment & { words: number }) | undefined;
  const close = () => {
    if (cur && cur.text.trim()) {
      segments.push({
        id: cur.id,
        speaker: cur.speaker,
        start: cur.start,
        end: cur.end,
        text: cur.text.trim(),
      });
    }
    cur = undefined;
  };
  for (const item of items) {
    const word = item.alternatives?.[0]?.content ?? '';
    if (!word) continue;
    if (item.type === 'punctuation') {
      if (!cur) continue;
      cur.text += word;
      if (/[.?!]$/.test(word) && cur.words >= PARAGRAPH_WORDS) close();
      continue;
    }
    const start = Number(item.start_time ?? NaN);
    const end = Number(item.end_time ?? NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const speaker = item.speaker_label ?? '';
    if (cur && (cur.speaker !== speaker || start - cur.end > PAUSE_SEC)) close();
    if (!cur) {
      cur = { id: segments.length, speaker, start, end, text: word, words: 1 };
    } else {
      cur.text += ` ${word}`;
      cur.end = end;
      cur.words += 1;
    }
  }
  close();
  return segments.map((s, i) => ({ ...s, id: i }));
}

/** Applies "Who's speaking?" names and transcript fixes. Unknown ids are ignored. */
export function applyContentPatch(content: MeetingContent, patch: MeetingPatch): MeetingContent {
  const next: MeetingContent = structuredClone(content);
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.markers !== undefined) next.markers = [...patch.markers].sort((a, b) => a.at - b.at);
  if (patch.speakers) {
    for (const [label, name] of Object.entries(patch.speakers)) {
      if (name) next.speakers[label] = name;
      else delete next.speakers[label];
    }
  }
  if (patch.segments?.length) {
    const byId = new Map(next.segments.map((s) => [s.id, s]));
    for (const edit of patch.segments) {
      const seg = byId.get(edit.id);
      if (!seg) continue;
      if (edit.text !== undefined && edit.text !== seg.text) {
        seg.text = edit.text;
        next.edited = true;
      }
      if (edit.speaker !== undefined && edit.speaker !== seg.speaker) {
        seg.speaker = edit.speaker;
        next.edited = true;
      }
    }
    next.segments = next.segments.filter((s) => s.text.trim());
  }
  return next;
}

/** Whether a patch touches the content object (not just the meeting item). */
export const touchesContent = (p: MeetingPatch) =>
  p.notes !== undefined || p.markers !== undefined || !!p.speakers || !!p.segments?.length;

// ── The meeting note (a Markdown document in the Library) ─────────────────
/** `1:02:03`, or `2:03` under an hour. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function speakerName(content: Pick<MeetingContent, 'speakers'>, label: string): string {
  if (!label) return 'Speaker';
  const named = content.speakers[label];
  if (named) return named;
  const n = Number(/^spk_(\d+)$/.exec(label)?.[1] ?? NaN);
  return Number.isFinite(n) ? `Speaker ${n + 1}` : 'Speaker';
}

/** Markdown has no business in a heading or name: keep the characters, lose the meaning. */
const plain = (s: string) => s.replace(/([\\`*_[\]#<>|])/g, '\\$1');

function longDate(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    timeZone: MEETING_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The meeting note filed in the Library: the details, the latest summary,
 * typed notes, marked moments and the transcript with names and times.
 */
export function noteMarkdown(
  m: Pick<Meeting, 'title' | 'startedAt' | 'durationSec' | 'attendees' | 'artistId'>,
  content: MeetingContent,
  opts: { artistName?: string; summary?: string } = {},
): string {
  const lines: string[] = [`# ${plain(m.title)}`, ''];
  const facts = [longDate(m.startedAt)];
  if (m.durationSec) facts.push(clock(m.durationSec));
  facts.push(m.artistId ? `About ${plain(opts.artistName ?? 'the artist')}` : 'Blueprint only');
  lines.push(facts.join(' · '), '');
  if (m.attendees.length) {
    lines.push(`**Attendees:** ${m.attendees.map((a) => plain(a.name)).join(', ')}`, '');
  }
  lines.push('_Recorded with everyone’s agreement._', '');
  if (opts.summary?.trim()) lines.push('## Summary', '', opts.summary.trim(), '');
  if (content.notes.trim()) lines.push('## Notes', '', content.notes.trim(), '');
  if (content.markers.length) {
    lines.push('## Marked moments', '');
    for (const k of content.markers) {
      lines.push(`- ${clock(k.at)}${k.note ? ` ${plain(k.note)}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Transcript', '');
  if (!content.segments.length) lines.push('_No speech was found in the recording._', '');
  for (const s of content.segments) {
    lines.push(`**${plain(speakerName(content, s.speaker))}** (${clock(s.start)})`, '');
    lines.push(plain(s.text), '');
  }
  if (content.edited) lines.push('_The transcript has been corrected by hand._', '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** What the meetings list and page show about a meeting (no content). */
/**
 * The artists in a meeting who have AI turned off right now, from their
 * current AI choices (`aiStates`). Any of them means it can't be transcribed.
 */
export const aiOffArtists = (
  m: Pick<Meeting, 'artistId' | 'attendees'>,
  states: Record<string, boolean>,
) => artistsInvolved(m).filter((id) => states[id] !== true);

export function publicMeeting(
  m: Meeting,
  viewer: Pick<Principal, 'sub' | 'role'>,
  /** Who in the meeting has AI off right now (see `aiOffArtists`); decides `canTranscribe`. */
  aiOff: string[],
) {
  return {
    meetingId: m.meetingId,
    space: m.artistId ? m.artistId : 'library',
    artistId: m.artistId ?? null,
    title: m.title,
    source: m.source,
    createdAt: m.createdAt,
    startedAt: m.startedAt,
    durationSec: m.durationSec ?? null,
    attendees: m.attendees,
    shared: m.shared,
    status: m.status,
    statusReason: m.statusReason ?? null,
    folderId: m.folderId ?? null,
    audioFileId: m.audioFileId ?? null,
    noteFileId: m.noteFileId ?? null,
    contentVersion: m.contentVersion,
    aiJob: m.aiJob
      ? { task: m.aiJob.task, status: m.aiJob.status, error: m.aiJob.error ?? null }
      : null,
    undoUntil: m.undoUntil ?? null,
    suggestionsWaiting: m.suggestionsWaiting ?? 0,
    actionsWaiting: m.actionsWaiting ?? 0,
    consent: { at: m.consent.at, wording: m.consent.wording },
    recordedByMe: m.createdBy === viewer.sub,
    canDelete: canDeleteMeeting(viewer, m),
    /** False while an artist in it has AI off: the screens grey out Transcribe and the Transcript tab. */
    canTranscribe: aiOff.length === 0,
    transcribeBlockedReason: aiOff.length ? ('ai_opt_out' as const) : null,
    aiOffArtistIds: aiOff,
    updatedAt: m.updatedAt,
  };
}
