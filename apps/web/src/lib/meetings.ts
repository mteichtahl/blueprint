import { api } from './api.ts';
import type { AppConfig } from './config.ts';
import { postToS3 } from './files.ts';

/**
 * Meeting notes (rev 11): Blueprint records a meeting, it's transcribed and
 * filed in the Library, and staff can ask for a summary and suggested plan
 * changes. The API contract is in services/api/src/handlers/meetings.ts.
 */

export type MeetingStatus =
  'recording' | 'uploading' | 'transcribing' | 'ready' | 'failed' | 'no-ai' | 'off';

export interface Attendee {
  kind: 'staff' | 'artist' | 'contact';
  id: string;
  name: string;
}

export type AiTask = 'quick' | 'full' | 'ask' | 'suggest';

export interface Meeting {
  meetingId: string;
  /** `library` or the artist's id. */
  space: string;
  artistId: string | null;
  title: string;
  source: 'recording' | 'upload';
  createdAt: string;
  startedAt: string;
  durationSec: number | null;
  attendees: Attendee[];
  shared: boolean;
  status: MeetingStatus;
  statusReason: string | null;
  folderId: string | null;
  audioFileId: string | null;
  noteFileId: string | null;
  contentVersion: number;
  aiJob: { task: AiTask; status: 'working' | 'failed'; error: string | null } | null;
  undoUntil: string | null;
  suggestionsWaiting: number;
  consent: { at: string; wording: string };
  recordedByMe: boolean;
  canDelete: boolean;
  updatedAt: string;
}

export interface Segment {
  id: number;
  speaker: string;
  start: number;
  end: number;
  text: string;
}
export interface Marker {
  at: number;
  note?: string;
}
export interface SummaryPoint {
  text: string;
  refs: number[];
}
export interface Summary {
  id: string;
  kind: 'quick' | 'full';
  createdAt: string;
  sections: { heading: string; points: SummaryPoint[] }[];
  actions: (SummaryPoint & { owner?: string; due?: string })[];
}
export interface Answer {
  id: string;
  question: string;
  answer: string;
  refs: number[];
  createdAt: string;
}

export type ChangeKind =
  | 'outcome.edit'
  | 'measure.edit'
  | 'stage.add'
  | 'stage.rename'
  | 'stage.goal'
  | 'stage.dates'
  | 'stage.remove'
  | 'milestone.add'
  | 'milestone.rename'
  | 'milestone.due'
  | 'milestone.done'
  | 'milestone.move'
  | 'milestone.remove';

export interface Suggestion {
  id: string;
  change: { kind: ChangeKind; reason: string; refs: number[] } & Record<string, unknown>;
  where: string;
  before: string;
  after: string;
  checkThis: boolean;
  dependsOn?: string;
  status: 'waiting' | 'accepted' | 'rejected';
  edited?: boolean;
  stale?: boolean;
}

export interface SuggestionSet {
  setId: string;
  createdAt: string;
  basePlanVersion: number;
  suggestions: Suggestion[];
  none?: boolean;
  applied?: {
    at: string;
    planVersion: number;
    undoUntil: string;
    changeCount: number;
    undoneAt?: string;
  };
}

export interface MeetingContent {
  notes: string;
  markers: Marker[];
  speakers: Record<string, string>;
  segments: Segment[];
  edited?: boolean;
  summaries?: Summary[];
  answers?: Answer[];
  suggestions?: SuggestionSet;
}

export const STATUS_LABEL: Record<MeetingStatus, [tone: 'c' | 's' | 'n' | 'k', text: string]> = {
  recording: ['c', 'Recording'],
  uploading: ['s', 'Uploading'],
  transcribing: ['s', 'Transcribing'],
  ready: ['n', 'Ready'],
  failed: ['k', 'Not transcribed'],
  'no-ai': ['s', 'Audio only'],
  off: ['s', 'Audio only'],
};

export const KIND_LABEL: Record<ChangeKind, string> = {
  'outcome.edit': 'Edit outcome',
  'measure.edit': 'Edit success measure',
  'stage.add': 'Add stage',
  'stage.rename': 'Rename stage',
  'stage.goal': 'Edit stage goal',
  'stage.dates': 'Change dates',
  'stage.remove': 'Remove stage',
  'milestone.add': 'Add milestone',
  'milestone.rename': 'Rename milestone',
  'milestone.due': 'Change due date',
  'milestone.done': 'Mark milestone',
  'milestone.move': 'Move milestone',
  'milestone.remove': 'Remove milestone',
};

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

/** Speaker labels in the order they first speak. */
export function speakersOf(segments: readonly Segment[]): string[] {
  const out: string[] = [];
  for (const s of segments) if (s.speaker && !out.includes(s.speaker)) out.push(s.speaker);
  return out;
}

export const meetingPath = (m: Pick<Meeting, 'space' | 'meetingId'>) =>
  `/meetings/${m.space}/${m.meetingId}`;

/** The meeting's recording or note, as a files API path. */
export const filePath = (m: Pick<Meeting, 'artistId'>, fileId: string) =>
  m.artistId ? `/artists/${m.artistId}/files/${fileId}` : `/library/files/${fileId}`;

// ── API ──────────────────────────────────────────────────────────────────
export const listMeetings = (cfg: AppConfig, token: string, artistId?: string) =>
  api<{ meetings: Meeting[] }>(
    cfg,
    token,
    'GET',
    `/meetings/items${artistId ? `?artistId=${encodeURIComponent(artistId)}` : ''}`,
  ).then((r) => r.meetings);

export interface NewMeeting {
  title: string;
  artistId?: string;
  source: 'recording' | 'upload';
  attendees: Attendee[];
  shared: boolean;
  consent: true;
  startedAt?: string;
}
export const createMeeting = (cfg: AppConfig, token: string, body: NewMeeting) =>
  api<{ meeting: Meeting }>(cfg, token, 'POST', '/meetings/items', body).then((r) => r.meeting);

export const getMeeting = (cfg: AppConfig, token: string, space: string, id: string) =>
  api<{ meeting: Meeting; content: MeetingContent }>(cfg, token, 'GET', `/meetings/${space}/${id}`);

export const patchMeeting = (
  cfg: AppConfig,
  token: string,
  m: Pick<Meeting, 'space' | 'meetingId'>,
  body: Record<string, unknown>,
) => api<{ meeting: Meeting }>(cfg, token, 'PATCH', meetingPath(m), body).then((r) => r.meeting);

/** The recording's type as the upload is pinned to it: `audio/webm`, not `audio/webm;codecs=opus`. */
export const baseType = (t: string) => t.toLowerCase().split(';')[0]!.trim();

/** Sends the meeting's recording through the files API (scanned and filed like any upload). */
export async function uploadRecording(
  cfg: AppConfig,
  token: string,
  m: Pick<Meeting, 'artistId' | 'meetingId'>,
  blob: Blob,
  name: string,
  durationSec?: number,
) {
  const collection = m.artistId ? `/artists/${m.artistId}/files` : '/library/files';
  const contentType = baseType(blob.type || 'audio/webm');
  const res = await api<{ upload: { url: string; fields: Record<string, string> } }>(
    cfg,
    token,
    'POST',
    collection,
    {
      meetingId: m.meetingId,
      name,
      size: blob.size,
      contentType,
      ...(durationSec !== undefined ? { durationSec } : {}),
    },
  );
  // S3 checks the type against the signed one, so send exactly that.
  await postToS3(
    res.upload,
    blob.type === contentType ? blob : new Blob([blob], { type: contentType }),
  );
}

// ── Recording safely on the device ───────────────────────────────────────
/**
 * Every 10 seconds of audio is saved in IndexedDB as it's recorded, so a
 * closed tab or a crash loses a few seconds at most. "Finish and transcribe"
 * picks up from there. Nothing leaves the device until the recording stops.
 */
const DB = 'bmg-recordings';
export const CHUNK_MS = 10_000;

export interface RecordingSession {
  meetingId: string;
  space: string;
  artistId: string | null;
  title: string;
  startedAt: string;
  mimeType: string;
  /** Seconds recorded so far (excluding pauses). */
  elapsed: number;
  updatedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('No storage on this device'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions'))
        db.createObjectStore('sessions', { keyPath: 'meetingId' });
      if (!db.objectStoreNames.contains('chunks'))
        db.createObjectStore('chunks', { keyPath: ['meetingId', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Storage unavailable'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Storage failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage failed'));
  });
}

export async function saveSession(s: RecordingSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(s);
  await done(tx);
  db.close();
}

export async function saveChunk(meetingId: string, seq: number, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').put({ meetingId, seq, blob });
  await done(tx);
  db.close();
}

export async function unfinishedSessions(): Promise<RecordingSession[]> {
  try {
    const db = await openDb();
    const tx = db.transaction('sessions', 'readonly');
    const req = tx.objectStore('sessions').getAll();
    const list = await new Promise<RecordingSession[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as RecordingSession[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return list;
  } catch {
    return [];
  }
}

/** The whole recording, its pieces in order. */
export async function recordedBlob(meetingId: string, mimeType: string): Promise<Blob> {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readonly');
  const range = IDBKeyRange.bound([meetingId, 0], [meetingId, Number.MAX_SAFE_INTEGER]);
  const req = tx.objectStore('chunks').getAll(range);
  const rows = await new Promise<{ seq: number; blob: Blob }[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as { seq: number; blob: Blob }[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  rows.sort((a, b) => a.seq - b.seq);
  return new Blob(
    rows.map((r) => r.blob),
    { type: mimeType },
  );
}

export async function forgetRecording(meetingId: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
    tx.objectStore('sessions').delete(meetingId);
    tx.objectStore('chunks').delete(
      IDBKeyRange.bound([meetingId, 0], [meetingId, Number.MAX_SAFE_INTEGER]),
    );
    await done(tx);
    db.close();
  } catch {
    // Nothing stored, or storage unavailable: nothing to forget.
  }
}

/** The recorder's preferred format: Opus in WebM (Chrome, Android, Firefox), else AAC in MP4 (Safari). */
export function recorderType(): string {
  const MR = typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder;
  if (!MR) return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MR.isTypeSupported?.(t)) return t;
  }
  return '';
}

export const extensionFor = (mime: string) =>
  baseType(mime) === 'audio/mp4' ? 'm4a' : baseType(mime).split('/')[1] || 'webm';

/** Three hours (spec 3.1); the recorder warns at 2 h 45 and stops itself at 3 h. */
export const MAX_RECORDING_SEC = 3 * 3600;
export const WARN_RECORDING_SEC = MAX_RECORDING_SEC - 15 * 60;
