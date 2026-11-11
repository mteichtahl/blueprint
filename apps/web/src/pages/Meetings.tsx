import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { api, ApiError, type ArtistSummary, type Me } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { formatSize, linkFor, MAX_UPLOAD_BYTES } from '../lib/files.ts';
import {
  CHUNK_MS,
  clock,
  createMeeting,
  extensionFor,
  filePath,
  forgetRecording,
  getMeeting,
  KIND_LABEL,
  listMeetings,
  MAX_RECORDING_SEC,
  meetingPath,
  patchMeeting,
  recordedBlob,
  recorderType,
  saveChunk,
  saveSession,
  speakerName,
  speakersOf,
  aiOffWords,
  statusLabel,
  unfinishedSessions,
  uploadRecording,
  WARN_RECORDING_SEC,
  type AiTask,
  type Attendee,
  type Meeting,
  type MeetingContent,
  type RecordingSession,
  type Suggestion,
} from '../lib/meetings.ts';
import {
  Button,
  Card,
  Chips,
  DataTable,
  Field,
  Icon,
  Notice,
  RowCard,
  shortDate,
  Tag,
  TextArea,
} from '../components/ui.tsx';

/**
 * Meeting notes (rev 11, spec 2–7): record a meeting with everyone's
 * agreement, have it transcribed and filed in the Library, ask for a summary
 * or about it, and review suggested changes to the artist's plan.
 */

type Props = { cfg: AppConfig; token: string };

const longDate = (iso: string) =>
  new Date(iso).toLocaleString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

const problemText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

// ═════════════════════════════ Recorder ═════════════════════════════
type RecorderState =
  | { kind: 'idle' }
  | {
      kind: 'recording' | 'paused';
      meeting: Meeting;
      elapsed: number;
      level: number;
      interrupted: boolean;
    }
  | { kind: 'saving'; meeting: Meeting; elapsed: number; progress: string }
  | { kind: 'error'; meeting: Meeting; elapsed: number; message: string };

interface RecorderApi {
  state: RecorderState;
  start: (m: Meeting) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<Meeting | undefined>;
  retryUpload: () => Promise<Meeting | undefined>;
  marker: (note?: string) => void;
  markers: { at: number; note?: string }[];
  notes: string;
  setNotes: (n: string) => void;
}

const RecorderContext = createContext<RecorderApi | null>(null);
export const useRecorder = () => useContext(RecorderContext);

/**
 * One recorder for the whole Blueprint app, so staff can move around while it
 * runs. Audio is saved on the device every 10 seconds (IndexedDB) and sent
 * when the recording stops.
 */
export function RecorderProvider({ cfg, token, children }: Props & { children: ReactNode }) {
  const [state, setState] = useState<RecorderState>({ kind: 'idle' });
  const [markers, setMarkers] = useState<{ at: number; note?: string }[]>([]);
  const [notes, setNotes] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const seq = useRef(0);
  const elapsed = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval>>(undefined);
  const wake = useRef<{ release: () => Promise<void> } | null>(null);
  const meetingRef = useRef<Meeting | null>(null);
  const mime = useRef('');
  const stopped = useRef<(() => void) | null>(null);
  /** Pieces still being written to the device; stopping waits for them. */
  const saving = useRef(new Set<Promise<unknown>>());

  const keepAwake = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      wake.current = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      // Not supported, or the page isn't visible: nothing to keep awake.
    }
  }, []);

  const cleanUp = useCallback(() => {
    clearInterval(tick.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    void wake.current?.release().catch(() => undefined);
    wake.current = null;
    rec.current = null;
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (rec.current && rec.current.state !== 'inactive') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible' && rec.current) void keepAwake();
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [keepAwake]);

  const upload = useCallback(
    async (m: Meeting): Promise<Meeting | undefined> => {
      setState({
        kind: 'saving',
        meeting: m,
        elapsed: elapsed.current,
        progress: 'Saving the recording…',
      });
      try {
        const blob = await recordedBlob(m.meetingId, mime.current || 'audio/webm');
        if (!blob.size)
          throw new Error('Nothing was recorded. Check the microphone and try again.');
        if (blob.size > MAX_UPLOAD_BYTES) throw new Error('The recording is over 500 MB.');
        // Notes and moments go with the meeting first; the transcript joins them later.
        let meeting = await patchMeeting(cfg, token, m, {
          durationSec: Math.round(elapsed.current),
          notes,
          markers,
        });
        setState({
          kind: 'saving',
          meeting,
          elapsed: elapsed.current,
          progress: `Uploading ${formatSize(blob.size)}…`,
        });
        await uploadRecording(
          cfg,
          token,
          meeting,
          blob,
          `recording.${extensionFor(mime.current)}`,
          elapsed.current,
        );
        await forgetRecording(m.meetingId);
        meeting = { ...meeting, status: 'uploading' };
        setState({ kind: 'idle' });
        setMarkers([]);
        setNotes('');
        return meeting;
      } catch (e) {
        setState({ kind: 'error', meeting: m, elapsed: elapsed.current, message: problemText(e) });
        return undefined;
      }
    },
    [cfg, token, notes, markers],
  );

  const start = useCallback(
    async (m: Meeting) => {
      mime.current = recorderType();
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error(
          'This browser can’t record. Record on your phone and upload the file instead.',
        );
      }
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream.current = media;
      const recorder = new MediaRecorder(media, {
        ...(mime.current ? { mimeType: mime.current } : {}),
        audioBitsPerSecond: 32_000,
      });
      mime.current = recorder.mimeType || mime.current || 'audio/webm';
      rec.current = recorder;
      meetingRef.current = m;
      seq.current = 0;
      elapsed.current = 0;
      setMarkers([]);
      setNotes('');
      await saveSession({
        meetingId: m.meetingId,
        space: m.space,
        artistId: m.artistId,
        title: m.title,
        startedAt: m.startedAt,
        mimeType: mime.current,
        elapsed: 0,
        updatedAt: new Date().toISOString(),
      });
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        const n = seq.current++;
        const write: Promise<unknown> = saveChunk(m.meetingId, n, e.data)
          .then(() =>
            saveSession({
              meetingId: m.meetingId,
              space: m.space,
              artistId: m.artistId,
              title: m.title,
              startedAt: m.startedAt,
              mimeType: mime.current,
              elapsed: elapsed.current,
              updatedAt: new Date().toISOString(),
            }),
          )
          .catch(() => undefined)
          .finally(() => saving.current.delete(write));
        saving.current.add(write);
      };
      recorder.onstop = () => stopped.current?.();
      // A phone call or the screen locking can take the microphone away.
      for (const track of media.getAudioTracks()) {
        track.onmute = () =>
          setState((s) =>
            s.kind === 'recording' || s.kind === 'paused' ? { ...s, interrupted: true } : s,
          );
        track.onunmute = () =>
          setState((s) =>
            s.kind === 'recording' || s.kind === 'paused' ? { ...s, interrupted: false } : s,
          );
      }
      // Level meter.
      let analyser: AnalyserNode | undefined;
      try {
        audioCtx.current = new AudioContext();
        analyser = audioCtx.current.createAnalyser();
        analyser.fftSize = 512;
        audioCtx.current.createMediaStreamSource(media).connect(analyser);
      } catch {
        analyser = undefined;
      }
      const buf = new Uint8Array(512);
      recorder.start(CHUNK_MS);
      await keepAwake();
      setState({ kind: 'recording', meeting: m, elapsed: 0, level: 0, interrupted: false });
      tick.current = setInterval(() => {
        const r = rec.current;
        if (!r) return;
        if (r.state === 'recording') elapsed.current += 0.25;
        let level = 0;
        if (analyser) {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += ((v - 128) / 128) ** 2;
          level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        }
        setState((s) =>
          s.kind === 'recording' || s.kind === 'paused'
            ? {
                ...s,
                kind: r.state === 'paused' ? 'paused' : 'recording',
                elapsed: elapsed.current,
                level,
              }
            : s,
        );
        if (elapsed.current >= MAX_RECORDING_SEC && r.state === 'recording') r.pause();
      }, 250);
    },
    [keepAwake],
  );

  const stop = useCallback(async () => {
    const r = rec.current;
    const m = meetingRef.current;
    if (!r || !m) return undefined;
    await new Promise<void>((resolve) => {
      stopped.current = resolve;
      if (r.state === 'inactive') resolve();
      else r.stop();
    });
    // The last piece arrives as the recorder stops; wait until every piece is on the device.
    await new Promise((res) => setTimeout(res, 50));
    await Promise.all([...saving.current]);
    cleanUp();
    return upload(m);
  }, [cleanUp, upload]);

  const value: RecorderApi = {
    state,
    start,
    pause: () => rec.current?.state === 'recording' && rec.current.pause(),
    resume: () => rec.current?.state === 'paused' && rec.current.resume(),
    stop,
    retryUpload: async () => (state.kind === 'error' ? upload(state.meeting) : undefined),
    marker: (note) =>
      setMarkers((list) => [
        ...list,
        { at: Math.round(elapsed.current), ...(note ? { note } : {}) },
      ]),
    markers,
    notes,
    setNotes,
  };
  return <RecorderContext.Provider value={value}>{children}</RecorderContext.Provider>;
}

/** "● Recording 12:41" across the top of every other screen while a meeting records. */
export function RecordingBar({ onOpen }: { onOpen: () => void }) {
  const r = useRecorder();
  if (!r || r.state.kind === 'idle') return null;
  const s = r.state;
  const label =
    s.kind === 'saving'
      ? s.progress
      : s.kind === 'error'
        ? 'The recording wasn’t sent'
        : `${s.kind === 'paused' ? 'Paused' : 'Recording'} ${clock(s.elapsed)}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="sticky top-0 z-30 -mx-1 mb-3 flex min-h-11 w-[calc(100%+0.5rem)] items-center gap-2 rounded-lg bg-[#8E2F2C] px-4 text-left font-bold text-white"
    >
      <span aria-hidden="true" className="size-2.5 rounded-full bg-white" />
      <span className="flex-1">
        {label} · {s.meeting.title}
      </span>
      <span className="underline">Open</span>
    </button>
  );
}

// ═════════════════════════════ Meetings page ═════════════════════════════
export type MeetingsTarget =
  | { kind: 'list' }
  | { kind: 'new'; artistId?: string }
  | { kind: 'recorder' }
  | { kind: 'open'; space: string; meetingId: string };

/** Meetings (BMG sidebar): the list, a new meeting, the recorder, and each meeting. */
export function MeetingsPage({
  cfg,
  token,
  me,
  artists,
  target,
  onTarget,
}: Props & {
  me: Me;
  artists: ArtistSummary[];
  target: MeetingsTarget;
  onTarget: (t: MeetingsTarget) => void;
}) {
  if (target.kind === 'new') {
    return (
      <NewMeeting
        cfg={cfg}
        token={token}
        me={me}
        artists={artists}
        artistId={target.artistId}
        onCancel={() => onTarget({ kind: 'list' })}
        onRecording={() => onTarget({ kind: 'recorder' })}
        onUploaded={(m) => onTarget({ kind: 'open', space: m.space, meetingId: m.meetingId })}
      />
    );
  }
  if (target.kind === 'recorder') {
    return (
      <Recorder
        onDone={(m) =>
          onTarget(m ? { kind: 'open', space: m.space, meetingId: m.meetingId } : { kind: 'list' })
        }
      />
    );
  }
  if (target.kind === 'open') {
    return (
      <MeetingView
        cfg={cfg}
        token={token}
        artists={artists}
        space={target.space}
        meetingId={target.meetingId}
        onBack={() => onTarget({ kind: 'list' })}
      />
    );
  }
  return (
    <MeetingsList
      cfg={cfg}
      token={token}
      artists={artists}
      onNew={() => onTarget({ kind: 'new' })}
      onOpen={(m) => onTarget({ kind: 'open', space: m.space, meetingId: m.meetingId })}
    />
  );
}

type ListFilter = 'all' | 'mine' | 'review' | 'library';
const FILTERS: { id: ListFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'review', label: 'Waiting on plan review' },
  { id: 'library', label: 'Blueprint only' },
];

function MeetingsList({
  cfg,
  token,
  artists,
  onNew,
  onOpen,
}: Props & {
  artists: ArtistSummary[];
  onNew: () => void;
  onOpen: (m: Meeting) => void;
}) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ListFilter>('all');
  const [unfinished, setUnfinished] = useState<RecordingSession[]>([]);
  const recorder = useRecorder();
  const load = useCallback(() => {
    listMeetings(cfg, token)
      .then(setMeetings)
      .catch((e) => setError(problemText(e)));
  }, [cfg, token]);
  useEffect(() => {
    load();
    const recording = recorder?.state.kind !== 'idle' ? recorder?.state : undefined;
    void unfinishedSessions().then((list) =>
      setUnfinished(
        list.filter(
          (s) =>
            !(recording && 'meeting' in recording && recording.meeting.meetingId === s.meetingId),
        ),
      ),
    );
    // Only on first open: the recorder's own meeting isn't "unfinished".
  }, [load]); // recorder is read once on purpose
  const name = (id: string | null) =>
    id ? (artists.find((a) => a.artistId === id)?.displayName ?? 'An artist') : 'Blueprint only';
  const shown = (meetings ?? []).filter((m) =>
    filter === 'mine'
      ? m.recordedByMe
      : filter === 'review'
        ? m.suggestionsWaiting > 0
        : filter === 'library'
          ? !m.artistId
          : true,
  );

  return (
    <div className="flex flex-col gap-4">
      {unfinished.map((s) => (
        <UnfinishedRecording
          key={s.meetingId}
          cfg={cfg}
          token={token}
          session={s}
          aiOff={(() => {
            const m = meetings?.find((x) => x.meetingId === s.meetingId);
            return m
              ? (aiOffWords(m, (id) => artists.find((a) => a.artistId === id)?.displayName) ??
                  undefined)
              : undefined;
          })()}
          onDone={() => {
            setUnfinished((l) => l.filter((x) => x.meetingId !== s.meetingId));
            load();
          }}
        />
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Chips label="Show" value={filter} onChange={setFilter} options={FILTERS} />
        <Button variant="cta" className="ml-auto" onClick={onNew}>
          <Icon name="mic" size={16} /> New meeting
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        {meetings === null ? (
          <p className="src">Loading meetings…</p>
        ) : shown.length === 0 ? (
          <p className="src">
            {meetings.length
              ? 'No meetings match.'
              : 'No meetings yet. Start one with New meeting.'}
          </p>
        ) : (
          <DataTable
            label="Meetings"
            cards={shown.map((m) => (
              <RowCard
                key={m.meetingId}
                title={m.title}
                sub={`${name(m.artistId)} · ${shortDate(m.startedAt)}${m.durationSec ? ` · ${clock(m.durationSec)}` : ''}`}
                status={<Tag tone={statusLabel(m)[0]}>{statusLabel(m)[1]}</Tag>}
                tags={m.suggestionsWaiting ? <Tag tone="c">Plan review</Tag> : undefined}
                onOpen={() => onOpen(m)}
                openLabel={`Open ${m.title}`}
              />
            ))}
          >
            <thead>
              <tr>
                <th>Meeting</th>
                <th>About</th>
                <th>When</th>
                <th>Length</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.meetingId}>
                  <td>
                    <button
                      type="button"
                      className="text-left font-bold underline"
                      onClick={() => onOpen(m)}
                    >
                      {m.title}
                    </button>
                  </td>
                  <td>{name(m.artistId)}</td>
                  <td>{longDate(m.startedAt)}</td>
                  <td>{m.durationSec ? clock(m.durationSec) : '—'}</td>
                  <td>
                    <span className="flex flex-wrap gap-1.5">
                      <Tag tone={statusLabel(m)[0]}>{statusLabel(m)[1]}</Tag>
                      {m.suggestionsWaiting > 0 && <Tag tone="c">Plan review</Tag>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </div>
  );
}

/** "You have an unfinished recording": finish it from what the device saved, or let it go. */
export function UnfinishedRecording({
  cfg,
  token,
  session,
  aiOff,
  onDone,
}: Props & {
  session: RecordingSession;
  /** Set when an artist in it has AI off: it can be saved, not transcribed (spec 8). */
  aiOff?: { notice: string; tooltip: string };
  onDone: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const finish = async () => {
    setBusy('Uploading…');
    setError('');
    try {
      const blob = await recordedBlob(session.meetingId, session.mimeType);
      await patchMeeting(
        cfg,
        token,
        { space: session.space, meetingId: session.meetingId },
        {
          durationSec: Math.round(session.elapsed),
        },
      );
      await uploadRecording(
        cfg,
        token,
        { artistId: session.artistId, meetingId: session.meetingId },
        blob,
        `recording.${extensionFor(session.mimeType)}`,
        session.elapsed,
      );
      await forgetRecording(session.meetingId);
      onDone();
    } catch (e) {
      setError(problemText(e));
      setBusy('');
    }
  };
  const discard = async () => {
    setBusy('Discarding…');
    await forgetRecording(session.meetingId);
    await api(cfg, token, 'DELETE', `/meetings/${session.space}/${session.meetingId}`).catch(
      () => undefined,
    );
    onDone();
  };
  return (
    <Card>
      <p className="m-0">
        You have an unfinished recording: <b>{session.title}</b>, from {longDate(session.startedAt)}{' '}
        ({clock(session.elapsed)}).
      </p>
      {aiOff && <Notice>{aiOff.notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        {aiOff ? (
          <>
            <Button variant="cta" disabled={!!busy} onClick={() => void finish()}>
              {busy || 'Finish and save'}
            </Button>
            <span title={aiOff.tooltip}>
              <Button variant="ghost" disabled aria-describedby={`ai-off-${session.meetingId}`}>
                Finish and transcribe
              </Button>
            </span>
            <span id={`ai-off-${session.meetingId}`} className="sr-only">
              {aiOff.tooltip}
            </span>
          </>
        ) : (
          <Button variant="cta" disabled={!!busy} onClick={() => void finish()}>
            {busy || 'Finish and transcribe'}
          </Button>
        )}
        <Button variant="ghost" disabled={!!busy} onClick={() => void discard()}>
          Discard
        </Button>
      </div>
    </Card>
  );
}

// ── New meeting (spec 2) ──
interface TeamMember {
  sub: string;
  displayName: string;
  jobTitle?: string;
}

function NewMeeting({
  cfg,
  token,
  me,
  artists,
  artistId: preset,
  onCancel,
  onRecording,
  onUploaded,
}: Props & {
  me: Me;
  artists: ArtistSummary[];
  artistId?: string;
  onCancel: () => void;
  onRecording: () => void;
  onUploaded: (m: Meeting) => void;
}) {
  const recorder = useRecorder();
  const [artistId, setArtistId] = useState(preset ?? '');
  const artist = artists.find((a) => a.artistId === artistId);
  const [title, setTitle] = useState(artist ? `Meeting with ${artist.displayName}` : '');
  const [titleTouched, setTitleTouched] = useState(false);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [guest, setGuest] = useState('');
  const [shared, setShared] = useState(false);
  const [consent, setConsent] = useState(false);
  const [mode, setMode] = useState<'recording' | 'upload'>('recording');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ team: TeamMember[] }>(cfg, token, 'GET', '/access/team')
      .then((r) => setTeam(r.team))
      .catch(() => setTeam([]));
  }, [cfg, token]);
  useEffect(() => {
    // The artist joins the attendees when picked; the title follows until it's typed over.
    if (!titleTouched) setTitle(artist ? `Meeting with ${artist.displayName}` : '');
    setAttendees((list) => [
      ...list.filter((a) => a.kind !== 'artist'),
      ...(artist
        ? [{ kind: 'artist' as const, id: artist.artistId, name: artist.displayName }]
        : []),
    ]);
    if (!artist) setShared(false);
  }, [artist, titleTouched]);

  const has = (kind: Attendee['kind'], id: string) =>
    attendees.some((a) => a.kind === kind && a.id === id);
  const toggle = (a: Attendee) =>
    setAttendees((list) =>
      has(a.kind, a.id) ? list.filter((x) => !(x.kind === a.kind && x.id === a.id)) : [...list, a],
    );
  const busyRecording = recorder && recorder.state.kind !== 'idle';
  const ready = title.trim() && consent && (mode === 'recording' || file);

  const go = async () => {
    setError('');
    setBusy(mode === 'recording' ? 'Starting…' : 'Uploading…');
    try {
      const meeting = await createMeeting(cfg, token, {
        title: title.trim(),
        ...(artistId ? { artistId } : {}),
        source: mode,
        attendees,
        shared,
        consent: true,
        ...(mode === 'upload' && file
          ? { startedAt: new Date(file.lastModified || Date.now()).toISOString() }
          : {}),
      });
      if (mode === 'recording') {
        await recorder!.start(meeting);
        onRecording();
      } else if (file) {
        await uploadRecording(cfg, token, meeting, file, file.name);
        onUploaded({ ...meeting, status: 'uploading' });
      }
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'The microphone is blocked. Allow it for Blueprint in your browser settings, then try again.'
          : problemText(e),
      );
      setBusy('');
    }
  };

  return (
    <Card title="New meeting" className="max-w-[640px]">
      {busyRecording && (
        <Notice>A meeting is already being recorded. Stop it before starting another one.</Notice>
      )}
      <Field
        label="Title"
        value={title}
        maxLength={120}
        required
        onChange={(e) => {
          setTitle(e.target.value);
          setTitleTouched(true);
        }}
      />
      <label className="flex flex-col gap-1.5">
        <span className="text-[15px] font-bold">About an artist</span>
        <select
          className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base"
          value={artistId}
          onChange={(e) => setArtistId(e.target.value)}
        >
          <option value="">Blueprint only</option>
          {artists.map((a) => (
            <option key={a.artistId} value={a.artistId}>
              {a.displayName}
            </option>
          ))}
        </select>
        <span className="src">
          {artist
            ? `Saved in ${artist.displayName}’s Library › Meetings. Linking an artist lets the app suggest changes to their plan.`
            : 'Saved in Blueprint’s library › Meetings.'}
        </span>
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-[15px] font-bold">Attendees</legend>
        <div className="flex flex-wrap gap-2">
          {team.map((t) => (
            <button
              key={t.sub}
              type="button"
              className="chip min-h-8"
              aria-pressed={has('staff', t.sub)}
              onClick={() => toggle({ kind: 'staff', id: t.sub, name: t.displayName })}
            >
              {t.displayName}
              {t.sub === me.sub ? ' (you)' : ''}
            </button>
          ))}
          {attendees
            .filter((a) => a.kind !== 'staff')
            .map((a) => (
              <button
                key={`${a.kind}:${a.id}`}
                type="button"
                className="chip min-h-8"
                aria-pressed="true"
                onClick={() => (a.kind === 'artist' ? undefined : toggle(a))}
              >
                {a.name}
              </button>
            ))}
        </div>
        <div className="flex gap-2">
          <Field
            label="Someone else"
            value={guest}
            maxLength={120}
            placeholder="Name"
            onChange={(e) => setGuest(e.target.value)}
          />
          <Button
            variant="ghost"
            className="self-end"
            disabled={!guest.trim()}
            onClick={() => {
              toggle({ kind: 'contact', id: `guest-${Date.now()}`, name: guest.trim() });
              setGuest('');
            }}
          >
            Add
          </Button>
        </div>
      </fieldset>
      {artist && (
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <span>
            Also share with {artist.displayName}
            <span className="src block">
              Off by default: meeting notes often hold Blueprint’s own views. You can share later.
            </span>
          </span>
        </label>
      )}
      <div className="seg" role="tablist" aria-label="Recording">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'recording'}
          onClick={() => setMode('recording')}
        >
          Record now
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'upload'}
          onClick={() => setMode('upload')}
        >
          Upload a recording
        </button>
      </div>
      {mode === 'upload' && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[15px] font-bold">Recording</span>
          <input
            type="file"
            accept="audio/*,video/mp4,video/webm,.m4a,.mp3,.wav,.flac,.ogg,.webm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span className="src">
            {file
              ? `${file.name} · ${formatSize(file.size)}${file.size > MAX_UPLOAD_BYTES ? ' — over the 500 MB limit' : ''}`
              : 'MP3, M4A, WAV, FLAC, Ogg, WebM or MP4, up to 500 MB and 3 hours.'}
          </span>
        </label>
      )}
      <label className="flex items-start gap-2 rounded-lg bg-secondary p-3">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>
          <b>
            {mode === 'recording'
              ? 'Everyone in this meeting knows it’s being recorded and has agreed.'
              : 'I have everyone’s agreement to this recording.'}
          </b>
          <span className="src block">
            Say it out loud at the start too. Your tick, and when you ticked it, are kept with the
            meeting.
          </span>
        </span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="cta"
          disabled={
            !ready ||
            !!busy ||
            (mode === 'recording' && !!busyRecording) ||
            (file?.size ?? 0) > MAX_UPLOAD_BYTES
          }
          onClick={() => void go()}
        >
          {busy || (mode === 'recording' ? 'Start recording' : 'Upload and transcribe')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={!!busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// ── Recording screen (spec 3.1) ──
function Recorder({ onDone }: { onDone: (m?: Meeting) => void }) {
  const r = useRecorder();
  const [confirmStop, setConfirmStop] = useState(false);
  const [markNote, setMarkNote] = useState('');
  if (!r || r.state.kind === 'idle') {
    return (
      <Card>
        <p className="m-0">Nothing is being recorded.</p>
        <Button variant="ghost" onClick={() => onDone()}>
          Back to meetings
        </Button>
      </Card>
    );
  }
  const s = r.state;
  const live = s.kind === 'recording' || s.kind === 'paused';
  return (
    <div className="flex flex-col gap-4">
      <Card title={s.meeting.title}>
        <div className="flex flex-col items-center gap-3 py-2">
          <span className="t text-[56px] leading-none tabular-nums" aria-live="off">
            {clock(s.elapsed)}
          </span>
          {live && (
            <div
              className="h-2.5 w-full max-w-[360px] overflow-hidden rounded-full bg-secondary"
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(s.level * 100)}
            >
              <div
                className="h-full bg-cta transition-[width]"
                style={{ width: `${Math.round(s.level * 100)}%` }}
              />
            </div>
          )}
          <p className="src m-0" role="status">
            {s.kind === 'recording' &&
              'Recording. Keep this page open; you can use the rest of the app.'}
            {s.kind === 'paused' && 'Paused.'}
            {s.kind === 'saving' && s.progress}
            {s.kind === 'error' && ''}
          </p>
          {live && s.interrupted && (
            <Notice tone="error">
              The microphone stopped at {clock(s.elapsed)} (a call, or the screen locked). Tap
              Resume when you’re back.
            </Notice>
          )}
          {live && s.elapsed >= WARN_RECORDING_SEC && (
            <Notice>Recordings stop at 3 hours. Stop and save soon.</Notice>
          )}
          {s.kind === 'error' && (
            <Notice tone="error">{s.message} Your recording is still saved on this device.</Notice>
          )}
        </div>
        {live && (
          <div className="flex flex-wrap justify-center gap-2">
            {s.kind === 'recording' ? (
              <Button variant="ghost" onClick={r.pause}>
                Pause
              </Button>
            ) : (
              <Button variant="navy" onClick={r.resume}>
                Resume
              </Button>
            )}
            {confirmStop ? (
              <>
                <Button
                  variant="cta"
                  onClick={() => {
                    void r.stop().then((m) => m && onDone(m));
                  }}
                >
                  Yes, stop and save
                </Button>
                <Button variant="ghost" onClick={() => setConfirmStop(false)}>
                  Keep recording
                </Button>
                <span className="src basis-full text-center">
                  Stop recording? You can’t add to it afterwards.
                </span>
              </>
            ) : (
              <Button variant="cta" onClick={() => setConfirmStop(true)}>
                Stop and save
              </Button>
            )}
          </div>
        )}
        {s.kind === 'error' && (
          <Button variant="cta" onClick={() => void r.retryUpload().then((m) => m && onDone(m))}>
            Try sending it again
          </Button>
        )}
      </Card>
      {live && (
        <Card title="Mark this moment">
          <div className="flex gap-2">
            <Field
              label="Note (optional)"
              value={markNote}
              maxLength={200}
              placeholder="budget agreed"
              onChange={(e) => setMarkNote(e.target.value)}
            />
            <Button
              variant="navy"
              className="self-end"
              onClick={() => {
                r.marker(markNote.trim() || undefined);
                setMarkNote('');
              }}
            >
              Mark
            </Button>
          </div>
          {r.markers.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Marked moments">
              {r.markers.map((k, i) => (
                <li key={i}>
                  <Tag tone="s">
                    {clock(k.at)}
                    {k.note ? ` ${k.note}` : ''}
                  </Tag>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {(live || s.kind === 'error') && (
        <Card title="Notes">
          <TextArea
            label="Your notes (kept separate from the transcript)"
            value={r.notes}
            maxLength={20_000}
            onChange={(e) => r.setNotes(e.target.value)}
          />
        </Card>
      )}
    </div>
  );
}

// ═════════════════════════════ A meeting (spec 5) ═════════════════════════════
type Section = 'summary' | 'transcript' | 'plan' | 'details';

export function MeetingView({
  cfg,
  token,
  artists,
  space,
  meetingId,
  onBack,
}: Props & {
  artists: ArtistSummary[];
  space: string;
  meetingId: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<{ meeting: Meeting; content: MeetingContent } | null>(null);
  const [error, setError] = useState('');
  const [section, pick] = useState<Section>('summary');
  const [picked, setPicked] = useState(false);
  const setSection = (x: Section) => {
    pick(x);
    setPicked(true);
  };
  const audio = useRef<HTMLAudioElement>(null);
  const load = useCallback(
    () =>
      getMeeting(cfg, token, space, meetingId)
        .then((d) => {
          setData(d);
          setError('');
        })
        .catch((e) => setError(problemText(e))),
    [cfg, token, space, meetingId],
  );
  useEffect(() => void load(), [load]);
  // While something is on its way, look again every few seconds.
  const waiting =
    !!data &&
    (['uploading', 'transcribing'].includes(data.meeting.status) ||
      data.meeting.aiJob?.status === 'working');
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [waiting, load]);

  const playAt = useCallback((sec: number) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = sec;
    void a.play().catch(() => undefined);
  }, []);

  if (!data) {
    return error ? (
      <Notice tone="error">{error}</Notice>
    ) : (
      <p className="src">Loading the meeting…</p>
    );
  }
  const { meeting: m, content } = data;
  const artist = artists.find((a) => a.artistId === m.artistId);
  const aiOff = aiOffWords(m, (id) => artists.find((a) => a.artistId === id)?.displayName);
  // Nothing to show and nothing can be made: the tab stays, greyed out (spec 5, 8).
  // A transcript made before the artist opted out is still shown.
  const transcriptOff = !!aiOff && content.segments.length === 0;
  const sections: { id: Section; label: string; count?: number }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'transcript', label: 'Transcript' },
    ...(m.artistId
      ? [{ id: 'plan' as const, label: 'Plan update', count: m.suggestionsWaiting }]
      : []),
    { id: 'details', label: 'Details' },
  ];
  const ctx = { cfg, token, meeting: m, content, reload: load, setData, playAt };
  // Opens on Details when there's no transcript to make; picking a tab still works.
  const shown: Section =
    transcriptOff && (section === 'transcript' || (section === 'summary' && !picked))
      ? 'details'
      : section;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <Icon name="back" size={16} /> Meetings
        </Button>
        <Tag tone={statusLabel(m)[0]}>{statusLabel(m)[1]}</Tag>
        {m.shared && <Tag tone="n">Shared with {artist?.displayName ?? 'the artist'}</Tag>}
      </div>
      <Card
        title={<h2 className="t text-[24px]">{m.title}</h2>}
        action={<span className="src">{longDate(m.startedAt)}</span>}
      >
        <p className="m-0">
          {artist ? `About ${artist.displayName}` : 'Blueprint only'}
          {m.durationSec ? ` · ${clock(m.durationSec)}` : ''}
          {m.attendees.length ? ` · ${m.attendees.map((a) => a.name).join(', ')}` : ''}
        </p>
        {m.audioFileId && m.status !== 'uploading' && (
          <Player cfg={cfg} token={token} meeting={m} audio={audio} markers={content.markers} />
        )}
        <StatusNotice meeting={m} cfg={cfg} token={token} reload={load} aiOff={aiOff} />
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <div role="tablist" aria-label="Meeting sections" className="seg">
        {sections.map((x) => {
          const off = x.id === 'transcript' && transcriptOff;
          return (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={shown === x.id}
              aria-disabled={off || undefined}
              tabIndex={off ? -1 : undefined}
              title={off ? aiOff!.tooltip : undefined}
              onClick={off ? undefined : () => setSection(x.id)}
            >
              {x.label} {x.count ? <span className="cnt cnt-hot">{x.count}</span> : null}
            </button>
          );
        })}
      </div>
      {shown === 'summary' && <SummarySection {...ctx} />}
      {shown === 'transcript' && <TranscriptSection {...ctx} />}
      {shown === 'plan' && (
        <PlanSection {...ctx} artistName={artist?.displayName ?? 'the artist'} />
      )}
      {shown === 'details' && (
        <DetailsSection {...ctx} artistName={artist?.displayName} onDeleted={onBack} />
      )}
    </div>
  );
}

interface Ctx {
  cfg: AppConfig;
  token: string;
  meeting: Meeting;
  content: MeetingContent;
  reload: () => Promise<void>;
  setData: (d: { meeting: Meeting; content: MeetingContent }) => void;
  playAt: (sec: number) => void;
}

function StatusNotice({
  meeting: m,
  cfg,
  token,
  reload,
  aiOff,
}: Pick<Ctx, 'meeting' | 'cfg' | 'token' | 'reload'> & {
  aiOff: { notice: string; tooltip: string } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (m.status === 'ready' || m.status === 'recording') return null;
  if (m.status === 'uploading' || m.status === 'transcribing') {
    const step = m.status === 'uploading' ? 'Checking the recording for malware' : 'Transcribing';
    return (
      <Notice>
        {step}… This usually takes a few minutes. You can leave this page; you’ll get a notification
        when the transcript is ready.
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Notice tone={m.status === 'failed' && !aiOff ? 'error' : 'info'}>
        {aiOff ? aiOff.notice : m.statusReason}
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      {/* Disabled buttons don't show a tooltip, so the wrapper carries it. */}
      <div className="self-start" title={aiOff?.tooltip}>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !!aiOff}
          aria-describedby={aiOff ? `ai-off-${m.meetingId}` : undefined}
          onClick={() => {
            setBusy(true);
            api(cfg, token, 'POST', `${meetingPath(m)}/transcribe`)
              .then(() => reload())
              .catch((e) => setError(problemText(e)))
              .finally(() => setBusy(false));
          }}
        >
          {m.status === 'failed' ? 'Try again' : 'Transcribe now'}
        </Button>
        {aiOff && (
          <span id={`ai-off-${m.meetingId}`} className="sr-only">
            {aiOff.tooltip}
          </span>
        )}
      </div>
    </div>
  );
}

/** Play, skip and speed, with marked moments. Links last 5 minutes, so an expired one is renewed in place. */
function Player({
  cfg,
  token,
  meeting: m,
  audio,
  markers,
}: Pick<Ctx, 'cfg' | 'token' | 'meeting'> & {
  audio: RefObject<HTMLAudioElement | null>;
  markers: MeetingContent['markers'];
}) {
  const [src, setSrc] = useState('');
  const [rate, setRate] = useState(1);
  const [error, setError] = useState('');
  const renew = useCallback(async () => {
    try {
      const at = audio.current?.currentTime ?? 0;
      const playing = audio.current ? !audio.current.paused : false;
      setSrc(await linkFor(cfg, token, filePath(m, m.audioFileId!)));
      if (audio.current && at) {
        audio.current.currentTime = at;
        if (playing) void audio.current.play().catch(() => undefined);
      }
    } catch (e) {
      setError(problemText(e));
    }
  }, [cfg, token, m, audio]);
  // A fresh link when the recording changes (renew itself reads the latest player state).
  const audioFileId = m.audioFileId;
  useEffect(() => void renew(), [audioFileId]);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate, audio]);
  const skip = (d: number) => {
    if (audio.current) audio.current.currentTime = Math.max(0, audio.current.currentTime + d);
  };
  if (error) return <Notice tone="error">The recording can’t be played: {error}</Notice>;
  return (
    <div className="flex flex-col gap-2">
      {/* The transcript below is the recording's text alternative. */}
      <audio
        ref={audio}
        controls
        preload="metadata"
        src={src || undefined}
        className="w-full"
        aria-label="Meeting recording"
        onError={() => src && void renew()}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => skip(-15)}>
          Back 15 s
        </Button>
        <Button variant="ghost" size="sm" onClick={() => skip(15)}>
          Forward 15 s
        </Button>
        <Chips
          label="Speed"
          value={String(rate) as '1' | '1.5' | '2'}
          onChange={(v) => setRate(Number(v))}
          options={[
            { id: '1', label: '1×' },
            { id: '1.5', label: '1.5×' },
            { id: '2', label: '2×' },
          ]}
        />
      </div>
      {markers.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Marked moments">
          {markers.map((k, i) => (
            <button
              key={i}
              type="button"
              className="chip min-h-8"
              onClick={() => {
                if (audio.current) {
                  audio.current.currentTime = k.at;
                  void audio.current.play().catch(() => undefined);
                }
              }}
            >
              {clock(k.at)}
              {k.note ? ` · ${k.note}` : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A transcript time that plays from there. */
function TimeLink({ at, playAt }: { at: number; playAt: (sec: number) => void }) {
  return (
    <button type="button" className="font-bold text-[#B5403C] underline" onClick={() => playAt(at)}>
      {clock(at)}
    </button>
  );
}

function Refs({
  refs,
  content,
  playAt,
}: {
  refs: number[];
  content: MeetingContent;
  playAt: (s: number) => void;
}) {
  const segs = refs
    .map((r) => content.segments.find((s) => s.id === r))
    .filter((s): s is MeetingContent['segments'][number] => !!s)
    .slice(0, 3);
  if (!segs.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1.5 text-sm">
      {segs.map((s) => (
        <TimeLink key={s.id} at={s.start} playAt={playAt} />
      ))}
    </span>
  );
}

/** Starts AI work and reports its errors. */
function useAi(ctx: Ctx) {
  const [error, setError] = useState('');
  const run = async (task: AiTask, question?: string) => {
    setError('');
    try {
      await api(ctx.cfg, ctx.token, 'POST', `${meetingPath(ctx.meeting)}/ai`, {
        task,
        ...(question ? { question } : {}),
      });
      await ctx.reload();
    } catch (e) {
      setError(problemText(e));
    }
  };
  const job = ctx.meeting.aiJob;
  return {
    run,
    error,
    working: job?.status === 'working' ? job.task : null,
    failed: job?.status === 'failed' ? job : null,
  };
}

const WORKING: Record<AiTask, string> = {
  quick: 'Writing a quick summary…',
  full: 'Writing the meeting notes…',
  ask: 'Looking for the answer…',
  suggest: 'Reading the meeting against the plan…',
};

// ── Summary (spec 5.2) ──
function SummarySection(ctx: Ctx) {
  const { meeting: m, content, playAt } = ctx;
  const ai = useAi(ctx);
  const [question, setQuestion] = useState('');
  const latest = content.summaries?.at(-1);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [made, setMade] = useState('');
  const [todoError, setTodoError] = useState('');
  if (m.status !== 'ready') {
    return (
      <Card>
        <p className="src m-0">Summaries come once the transcript is in.</p>
      </Card>
    );
  }
  const makeTodos = async () => {
    if (!latest || !m.artistId) return;
    setTodoError('');
    let n = 0;
    try {
      for (const i of [...ticked].sort((a, b) => a - b)) {
        const a = latest.actions[i]!;
        await api(ctx.cfg, ctx.token, 'POST', `/artists/${m.artistId}/todos`, {
          title: a.text.slice(0, 200),
          notes: `From the meeting “${m.title}”${a.owner ? ` (${a.owner})` : ''}`.slice(0, 2000),
          ...(a.due && a.due >= new Date().toISOString().slice(0, 10) ? { due: a.due } : {}),
        });
        n++;
      }
      setMade(`${n} to-do${n === 1 ? '' : 's'} added to the artist’s list.`);
      setTicked(new Set());
    } catch (e) {
      setTodoError(`${n ? `${n} added, then: ` : ''}${problemText(e)}`);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Card
        title={latest ? (latest.kind === 'full' ? 'Meeting notes' : 'Quick summary') : 'Summary'}
        action={
          <>
            <Button
              size="sm"
              variant={latest ? 'ghost' : 'navy'}
              disabled={!!ai.working}
              onClick={() => void ai.run('quick')}
            >
              {latest ? 'Quick summary again' : 'Quick summary'}
            </Button>
            <Button
              size="sm"
              variant={latest ? 'ghost' : 'cta'}
              disabled={!!ai.working}
              onClick={() => void ai.run('full')}
            >
              {latest?.kind === 'full' ? 'Full notes again' : 'Full notes'}
            </Button>
          </>
        }
      >
        {ai.working && ai.working !== 'ask' && ai.working !== 'suggest' && (
          <Notice>{WORKING[ai.working]}</Notice>
        )}
        {ai.error && <Notice tone="error">{ai.error}</Notice>}
        {ai.failed && ai.failed.task !== 'ask' && ai.failed.task !== 'suggest' && (
          <Notice tone="error">{ai.failed.error}</Notice>
        )}
        {!latest ? (
          <p className="src m-0">
            Ask for a quick summary (five to eight lines) or full notes with decisions, open
            questions and action items. Each point links to the moment it came from.
          </p>
        ) : (
          <>
            {latest.sections.map((s) => (
              <section key={s.heading} className="flex flex-col gap-1.5">
                {latest.sections.length > 1 && <h3 className="t m-0 text-[17px]">{s.heading}</h3>}
                <ul className="m-0 flex flex-col gap-1.5 pl-5">
                  {s.points.map((p, i) => (
                    <li key={i}>
                      {p.text}
                      <Refs refs={p.refs} content={content} playAt={playAt} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {latest.actions.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <h3 className="t m-0 text-[17px]">Action items</h3>
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {latest.actions.map((a, i) => (
                    <li key={i} className="flex items-start gap-2">
                      {m.artistId && (
                        <input
                          type="checkbox"
                          aria-label={`Make a to-do: ${a.text}`}
                          checked={ticked.has(i)}
                          onChange={(e) =>
                            setTicked((t) => {
                              const next = new Set(t);
                              if (e.target.checked) next.add(i);
                              else next.delete(i);
                              return next;
                            })
                          }
                        />
                      )}
                      <span>
                        {a.owner && <b>{a.owner}: </b>}
                        {a.text}
                        {a.due ? ` (by ${shortDate(a.due)})` : ''}
                        <Refs refs={a.refs} content={content} playAt={playAt} />
                      </span>
                    </li>
                  ))}
                </ul>
                {m.artistId && (
                  <div>
                    <Button
                      size="sm"
                      variant="navy"
                      disabled={!ticked.size}
                      onClick={() => void makeTodos()}
                    >
                      Create {ticked.size || ''} to-do{ticked.size === 1 ? '' : 's'}
                    </Button>
                  </div>
                )}
                {made && <Notice tone="success">{made}</Notice>}
                {todoError && <Notice tone="error">{todoError}</Notice>}
              </section>
            )}
            <span className="src">
              Saved at the top of the meeting note in the Library. {shortDate(latest.createdAt)}
            </span>
          </>
        )}
      </Card>
      <Card title="Ask about this meeting">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!question.trim()) return;
            void ai.run('ask', question.trim()).then(() => setQuestion(''));
          }}
        >
          <Field
            label="Question"
            value={question}
            maxLength={500}
            placeholder="What did we agree about the EP budget?"
            onChange={(e) => setQuestion(e.target.value)}
          />
          <Button variant="navy" className="self-end" disabled={!question.trim() || !!ai.working}>
            Ask
          </Button>
        </form>
        {ai.working === 'ask' && <Notice>{WORKING.ask}</Notice>}
        {ai.failed?.task === 'ask' && <Notice tone="error">{ai.failed.error}</Notice>}
        {[...(content.answers ?? [])].reverse().map((a) => (
          <div key={a.id} className="li flex-col items-start gap-1">
            <b>{a.question}</b>
            <span>
              {a.answer}
              <Refs refs={a.refs} content={content} playAt={playAt} />
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── Transcript (spec 5.1) ──
function TranscriptSection(ctx: Ctx) {
  const { meeting: m, content, playAt } = ctx;
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [names, setNames] = useState<Record<string, string>>(content.speakers);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const speakers = useMemo(() => speakersOf(content.segments), [content.segments]);
  const unnamed = speakers.filter((s) => !content.speakers[s]);
  const q = query.trim().toLowerCase();
  const rows = q
    ? content.segments.filter((s) => s.text.toLowerCase().includes(q))
    : content.segments;
  const save = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError('');
    try {
      const meeting = await patchMeeting(ctx.cfg, ctx.token, m, {
        ...body,
        contentVersion: m.contentVersion,
      });
      await ctx.reload();
      // Refile the note with the names and fixes.
      await api(ctx.cfg, ctx.token, 'POST', `${meetingPath(meeting)}/note`).catch(() => undefined);
      return true;
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'Someone else changed this meeting. Reload and try again.'
          : problemText(e),
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  if (m.status !== 'ready') {
    return (
      <Card>
        <p className="src m-0">The transcript appears here once it’s ready.</p>
        {content.notes && (
          <>
            <h3 className="t m-0 text-[17px]">Notes</h3>
            <p className="m-0 whitespace-pre-wrap">{content.notes}</p>
          </>
        )}
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {speakers.length > 0 && (unnamed.length > 0 || editing) && (
        <Card title="Who’s speaking?">
          <p className="src m-0">Play a sample of each voice and pick who it is.</p>
          {speakers.map((label) => {
            const first = content.segments.find((s) => s.speaker === label)!;
            return (
              <div key={label} className="flex flex-wrap items-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => playAt(first.start)}>
                  Play {speakerName(content, label)}
                </Button>
                <label className="flex min-w-[200px] flex-1 flex-col gap-1">
                  <span className="text-sm font-bold">{speakerName(content, label)}</span>
                  <input
                    className="min-h-11 rounded-lg border border-input bg-white px-3"
                    list={`attendees-${m.meetingId}`}
                    value={names[label] ?? ''}
                    maxLength={120}
                    onChange={(e) => setNames((n) => ({ ...n, [label]: e.target.value }))}
                  />
                </label>
              </div>
            );
          })}
          <datalist id={`attendees-${m.meetingId}`}>
            {m.attendees.map((a) => (
              <option key={`${a.kind}:${a.id}`} value={a.name} />
            ))}
          </datalist>
          <div>
            <Button variant="navy" disabled={saving} onClick={() => void save({ speakers: names })}>
              Save names
            </Button>
          </div>
        </Card>
      )}
      <Card
        title="Transcript"
        action={
          editing ? (
            <>
              <Button
                size="sm"
                variant="cta"
                disabled={saving}
                onClick={() =>
                  void save({
                    segments: Object.entries(draft).map(([id, text]) => ({ id: Number(id), text })),
                  }).then((ok) => ok && (setEditing(false), setDraft({})))
                }
              >
                Save fixes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setDraft({}))}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={14} /> Edit transcript
            </Button>
          )
        }
      >
        <Field
          label="Search the transcript"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && <Notice tone="error">{error}</Notice>}
        {content.notes && !q && (
          <div className="rounded-lg bg-secondary p-3">
            <b>Notes</b>
            <p className="m-0 whitespace-pre-wrap">{content.notes}</p>
          </div>
        )}
        {rows.length === 0 && (
          <p className="src">{q ? 'No matches.' : 'No speech was found in the recording.'}</p>
        )}
        <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Transcript">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-sm">
                <b>{speakerName(content, s.speaker)}</b>
                <TimeLink at={s.start} playAt={playAt} />
              </span>
              {editing ? (
                <textarea
                  aria-label={`Line at ${clock(s.start)}`}
                  className="min-h-16 rounded-lg border border-input bg-white px-3 py-2"
                  value={draft[s.id] ?? s.text}
                  maxLength={5000}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.id]: e.target.value }))}
                />
              ) : (
                <p className="m-0">{highlight(s.text, q)}</p>
              )}
            </li>
          ))}
        </ol>
        {content.edited && <span className="src">The transcript has been corrected by hand.</span>}
      </Card>
    </div>
  );
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const out: ReactNode[] = [];
  let i = 0;
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, i)) {
    out.push(text.slice(i, at), <mark key={at}>{text.slice(at, at + q.length)}</mark>);
    i = at + q.length;
  }
  out.push(text.slice(i));
  return out;
}

// ── Plan update (spec 6) ──
type Review = 'all' | 'waiting' | 'accepted' | 'rejected';

function PlanSection(ctx: Ctx & { artistName: string }) {
  const { meeting: m, content, playAt, artistName } = ctx;
  const ai = useAi(ctx);
  const set = content.suggestions;
  const [filter, setFilter] = useState<Review>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [notify, setNotify] = useState(true);
  const [done, setDone] = useState('');
  const patch = async (
    updates: { id: string; status?: Suggestion['status']; change?: Record<string, unknown> }[],
  ) => {
    setBusy(true);
    setError('');
    try {
      await api(ctx.cfg, ctx.token, 'PATCH', `${meetingPath(m)}/suggestions`, {
        contentVersion: m.contentVersion,
        updates,
      });
      await ctx.reload();
    } catch (e) {
      setError(problemText(e));
      await ctx.reload();
    } finally {
      setBusy(false);
    }
  };
  if (m.status !== 'ready') {
    return (
      <Card>
        <p className="src m-0">Plan suggestions come once the transcript is in.</p>
      </Card>
    );
  }
  if (!set || set.applied?.undoneAt) {
    return (
      <Card title={`Suggested changes to ${artistName}’s plan`}>
        <p className="m-0">
          The app reads the meeting against {artistName}’s plan and suggests changes that were
          agreed. Nothing changes until you accept them and update the plan.
        </p>
        {set?.applied?.undoneAt && <Notice>The last update from this meeting was undone.</Notice>}
        {ai.working === 'suggest' ? (
          <Notice>{WORKING.suggest}</Notice>
        ) : (
          <div>
            <Button variant="cta" onClick={() => void ai.run('suggest')}>
              Suggest plan changes
            </Button>
          </div>
        )}
        {ai.error && <Notice tone="error">{ai.error}</Notice>}
        {ai.failed?.task === 'suggest' && <Notice tone="error">{ai.failed.error}</Notice>}
      </Card>
    );
  }
  if (set.applied) {
    const canUndo = Date.parse(set.applied.undoUntil) > Date.now();
    return (
      <Card title="Plan updated">
        <Notice tone="success">
          {set.applied.changeCount} change{set.applied.changeCount === 1 ? '' : 's'} went into{' '}
          {artistName}’s plan on {longDate(set.applied.at)}. It shows in the plan’s History.
        </Notice>
        {done && <Notice tone="success">{done}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {canUndo && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                api(ctx.cfg, ctx.token, 'POST', `${meetingPath(m)}/plan-update/undo`)
                  .then(() => ctx.reload())
                  .catch((e) => setError(problemText(e)))
                  .finally(() => setBusy(false));
              }}
            >
              Undo this update
            </Button>
            <span className="src">
              Possible until {shortDate(set.applied.undoUntil)}, if nobody changes the plan
              meanwhile.
            </span>
          </div>
        )}
      </Card>
    );
  }
  const list = set.suggestions;
  const shown = list.filter((s) => filter === 'all' || s.status === filter);
  const accepted = list.filter((s) => s.status === 'accepted').length;
  // Grouped by where they land: the outcome and measures, then each stage.
  const groups = new Map<string, Suggestion[]>();
  for (const s of shown) {
    const g = s.where.split(' › ')[0]!;
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  return (
    <div className="flex flex-col gap-4">
      <Card
        title={`${list.length} suggested change${list.length === 1 ? '' : 's'} to ${artistName}’s plan`}
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={!!ai.working}
            onClick={() => void ai.run('suggest')}
          >
            Check again
          </Button>
        }
      >
        {set.none || list.length === 0 ? (
          <p className="m-0">Nothing in this meeting changes {artistName}’s plan.</p>
        ) : (
          <>
            <p className="src m-0">
              From the meeting on {shortDate(m.startedAt)}. Nothing is accepted until you say so.
            </p>
            <Chips
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'all', label: 'All' },
                { id: 'waiting', label: 'Waiting' },
                { id: 'accepted', label: 'Accepted' },
                { id: 'rejected', label: 'Rejected' },
              ]}
            />
          </>
        )}
        {ai.working === 'suggest' && <Notice>{WORKING.suggest}</Notice>}
        {ai.error && <Notice tone="error">{ai.error}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </Card>
      {[...groups.entries()].map(([g, items]) => (
        <section key={g} className="flex flex-col gap-3" aria-label={g}>
          <h3 className="t m-0 text-[19px]">{g}</h3>
          {items.map((s) => (
            <SuggestionCard
              key={s.id}
              s={s}
              list={list}
              content={content}
              playAt={playAt}
              busy={busy}
              onPatch={(u) => void patch([u])}
            />
          ))}
        </section>
      ))}
      {list.length > 0 && (
        <Card>
          {confirm ? (
            <>
              <p className="m-0">
                Update {artistName}’s plan with {accepted} change{accepted === 1 ? '' : 's'}?
                They’re saved together, and you can undo them for 7 days.
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={notify}
                  onChange={(e) => setNotify(e.target.checked)}
                />
                <span>
                  Tell {artistName} what changed
                  <span className="src block">They see the plan changes, not the meeting.</span>
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="cta"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError('');
                    api<{ changes: string[] }>(
                      ctx.cfg,
                      ctx.token,
                      'POST',
                      `${meetingPath(m)}/plan-update`,
                      {
                        notifyArtist: notify,
                      },
                    )
                      .then((r) => {
                        setDone(
                          `Saved. ${r.changes.length} line${r.changes.length === 1 ? '' : 's'} in the plan’s History.`,
                        );
                        setConfirm(false);
                        return ctx.reload();
                      })
                      .catch(async (e) => {
                        setError(problemText(e));
                        setConfirm(false);
                        await ctx.reload();
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  Update plan
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(false)}>
                  Back
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void patch(
                    list
                      .filter((s) => s.status !== 'accepted')
                      .map((s) => ({ id: s.id, status: 'accepted' })),
                  )
                }
              >
                Accept all
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void patch(
                    list
                      .filter((s) => s.status !== 'rejected')
                      .map((s) => ({ id: s.id, status: 'rejected' })),
                  )
                }
              >
                Reject all
              </Button>
              <Button
                variant="cta"
                className="ml-auto"
                disabled={!accepted || busy}
                onClick={() => setConfirm(true)}
              >
                Update plan ({accepted} change{accepted === 1 ? '' : 's'})
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/** What staff can retype on each kind of change. */
const EDIT_FIELDS: Partial<
  Record<Suggestion['change']['kind'], { key: string; label: string; type: 'text' | 'date' }[]>
> = {
  'outcome.edit': [{ key: 'after', label: 'Outcome', type: 'text' }],
  'measure.edit': [{ key: 'after', label: 'Measure', type: 'text' }],
  'stage.add': [
    { key: 'name', label: 'Stage name', type: 'text' },
    { key: 'start', label: 'Starts', type: 'date' },
    { key: 'end', label: 'Ends', type: 'date' },
  ],
  'stage.rename': [{ key: 'after', label: 'New name', type: 'text' }],
  'stage.goal': [{ key: 'after', label: 'Goal', type: 'text' }],
  'stage.dates': [
    { key: 'start', label: 'Starts', type: 'date' },
    { key: 'end', label: 'Ends', type: 'date' },
  ],
  'milestone.add': [
    { key: 'title', label: 'Milestone', type: 'text' },
    { key: 'due', label: 'Due', type: 'date' },
  ],
  'milestone.rename': [{ key: 'after', label: 'New name', type: 'text' }],
  'milestone.due': [{ key: 'due', label: 'Due', type: 'date' }],
};

function SuggestionCard({
  s,
  list,
  content,
  playAt,
  busy,
  onPatch,
}: {
  s: Suggestion;
  list: Suggestion[];
  content: MeetingContent;
  playAt: (sec: number) => void;
  busy: boolean;
  onPatch: (u: {
    id: string;
    status?: Suggestion['status'];
    change?: Record<string, unknown>;
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const fields = EDIT_FIELDS[s.change.kind] ?? [];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const removal = s.change.kind.endsWith('.remove');
  const parent = s.dependsOn ? list.find((x) => x.id === s.dependsOn) : undefined;
  const quotes = s.change.refs
    .map((r) => content.segments.find((x) => x.id === r))
    .filter((x): x is MeetingContent['segments'][number] => !!x)
    .slice(0, 3);
  const tone = s.status === 'accepted' ? 'n' : s.status === 'rejected' ? 's' : 'c';
  return (
    <article className="card gap-2" aria-label={`${KIND_LABEL[s.change.kind]}: ${s.where}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={removal ? 'k' : 's'}>{KIND_LABEL[s.change.kind]}</Tag>
        <b className="min-w-0 flex-1">{s.where}</b>
        {s.checkThis && <Tag tone="c">Check this</Tag>}
        {s.edited && <Tag tone="s">Edited</Tag>}
        <Tag tone={tone}>
          {s.status === 'waiting' ? 'Waiting' : s.status === 'accepted' ? 'Accepted' : 'Rejected'}
        </Tag>
      </div>
      {s.stale && <Notice tone="error">The plan has changed since. Check this again.</Notice>}
      <p className="m-0">
        {s.before && (
          <>
            <del className="text-muted-foreground">{s.before}</del>
            {s.after ? ' → ' : ''}
          </>
        )}
        {s.after && <ins className="bg-[#DCE6F2] no-underline">{s.after}</ins>}
        {removal && !s.after && <span className="font-bold text-[#B5403C]"> (removed)</span>}
      </p>
      <p className="m-0">
        <b>Why:</b> {s.change.reason}
      </p>
      {parent && (
        <span className="src">Goes with “{parent.after}” (accepting this accepts that stage).</span>
      )}
      {quotes.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-bold">From the meeting</span>
          {quotes.map((q) => (
            <blockquote key={q.id} className="m-0 border-l-4 border-input pl-3 text-sm">
              <TimeLink at={q.start} playAt={playAt} /> {speakerName(content, q.speaker)}: “{q.text}
              ”
            </blockquote>
          ))}
        </div>
      )}
      {editing && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const change: Record<string, unknown> = {};
            for (const f of fields) {
              const v = draft[f.key];
              if (v !== undefined) change[f.key] = f.type === 'date' && !v ? null : v;
            }
            onPatch({ id: s.id, change });
            setEditing(false);
          }}
        >
          {fields.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              type={f.type}
              value={draft[f.key] ?? String((s.change as Record<string, unknown>)[f.key] ?? '')}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
            />
          ))}
          <div className="flex gap-2">
            <Button variant="navy" size="sm" disabled={busy}>
              Save and accept
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!editing && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={s.status === 'accepted' ? 'navy' : 'ghost'}
            disabled={busy}
            aria-pressed={s.status === 'accepted'}
            onClick={() =>
              onPatch({ id: s.id, status: s.status === 'accepted' ? 'waiting' : 'accepted' })
            }
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant={s.status === 'rejected' ? 'navy' : 'ghost'}
            disabled={busy}
            aria-pressed={s.status === 'rejected'}
            onClick={() =>
              onPatch({ id: s.id, status: s.status === 'rejected' ? 'waiting' : 'rejected' })
            }
          >
            Reject
          </Button>
          {fields.length > 0 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

// ── Details (spec 5.3, 9) ──
function DetailsSection(ctx: Ctx & { artistName?: string; onDeleted: () => void }) {
  const { meeting: m, artistName } = ctx;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const share = async (shared: boolean) => {
    setBusy(true);
    setError('');
    try {
      await patchMeeting(ctx.cfg, ctx.token, m, { shared });
      await ctx.reload();
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      // The recording and note are documents: delete them where allowed, then the meeting.
      for (const id of [m.noteFileId, m.audioFileId]) {
        if (id) await api(ctx.cfg, ctx.token, 'DELETE', filePath(m, id)).catch(() => undefined);
      }
      await api(ctx.cfg, ctx.token, 'DELETE', meetingPath(m));
      ctx.onDeleted();
    } catch (e) {
      setError(problemText(e));
      setBusy(false);
    }
  };
  return (
    <Card title="Details">
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
        <dt className="font-bold">Recorded</dt>
        <dd className="m-0">
          {longDate(m.startedAt)}
          {m.recordedByMe ? ' by you' : ''}
          {m.source === 'upload' ? ' (uploaded)' : ''}
        </dd>
        <dt className="font-bold">Agreement</dt>
        <dd className="m-0">
          “{m.consent.wording}” Ticked {longDate(m.consent.at)}.
        </dd>
        <dt className="font-bold">Saved in</dt>
        <dd className="m-0">
          {m.artistId ? `${artistName ?? 'The artist'}’s Library` : 'Blueprint’s library'} ›
          Meetings · {m.shared ? `shared with ${artistName ?? 'the artist'}` : 'Blueprint only'}
        </dd>
        <dt className="font-bold">Files</dt>
        <dd className="m-0">
          {[m.audioFileId && 'the recording', m.noteFileId && 'the meeting note']
            .filter(Boolean)
            .join(' and ') || 'None yet'}
        </dd>
      </dl>
      {m.artistId && (
        <div>
          <Button variant="ghost" disabled={busy} onClick={() => void share(!m.shared)}>
            {m.shared
              ? `Stop sharing with ${artistName ?? 'the artist'}`
              : `Share with ${artistName ?? 'the artist'}`}
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {m.canDelete && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-[#D9534F] p-3">
          <b>Delete meeting</b>
          <span className="src">
            Deletes the meeting, its transcript and summaries, and the recording and note where you
            may delete them. A Blueprint admin can recover the files for 35 days.
          </span>
          {m.undoUntil && Date.parse(m.undoUntil) > Date.now() ? (
            <span className="src">
              Its plan update can be undone until {shortDate(m.undoUntil)}; delete it after that.
            </span>
          ) : confirm ? (
            <div className="flex gap-2">
              <Button variant="cta" disabled={busy} onClick={() => void remove()}>
                Yes, delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div>
              <Button variant="ghost" onClick={() => setConfirm(true)}>
                <Icon name="trash" size={16} /> Delete meeting
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ═════════════════════════════ Workspace pieces ═════════════════════════════
/** The artist's meetings, for the workspace (latest meeting card, plan banner). */
export function useArtistMeetings(cfg: AppConfig, token: string, artistId: string) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  useEffect(() => {
    listMeetings(cfg, token, artistId)
      .then(setMeetings)
      .catch(() => setMeetings([]));
  }, [cfg, token, artistId]);
  return meetings;
}

/** "3 suggested changes from Meeting with Chloe, 11 Nov — Review" above the plan. */
export function PlanSuggestionsBanner({
  meetings,
  onOpen,
}: {
  meetings: Meeting[];
  onOpen: (m: Meeting) => void;
}) {
  const waiting = meetings.filter((m) => m.suggestionsWaiting > 0);
  if (!waiting.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {waiting.map((m) => (
        <div
          key={m.meetingId}
          className="flex flex-wrap items-center gap-2 rounded-lg bg-[#FBE3E2] px-3 py-2.5 text-[#8E2F2C]"
        >
          <span className="flex-1">
            {m.suggestionsWaiting} suggested change{m.suggestionsWaiting === 1 ? '' : 's'} from{' '}
            <b>{m.title}</b>, {shortDate(m.startedAt)}
          </span>
          <Button size="sm" variant="cta" onClick={() => onOpen(m)}>
            Review
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Overview → Summary: the latest meeting about the artist. */
export function LatestMeetingCard({
  meetings,
  onOpen,
  onRecord,
}: {
  meetings: Meeting[];
  onOpen: (m: Meeting) => void;
  onRecord: () => void;
}) {
  const latest = meetings[0];
  return (
    <Card
      className="min-w-[min(300px,100%)] flex-[1_1_300px]"
      title={<h2 className="t text-[22px]">Latest meeting</h2>}
      action={
        <button type="button" className="font-bold underline" onClick={onRecord}>
          Record meeting
        </button>
      }
    >
      {latest ? (
        <div className="li">
          <span className="flex-1">
            <button
              type="button"
              className="text-left font-bold underline"
              onClick={() => onOpen(latest)}
            >
              {latest.title}
            </button>
            <span className="src block">{longDate(latest.startedAt)}</span>
          </span>
          {latest.suggestionsWaiting > 0 ? (
            <Tag tone="c">Waiting on plan review</Tag>
          ) : (
            <Tag tone={statusLabel(latest)[0]}>{statusLabel(latest)[1]}</Tag>
          )}
        </div>
      ) : (
        <p className="src m-0">No meetings recorded yet.</p>
      )}
    </Card>
  );
}
