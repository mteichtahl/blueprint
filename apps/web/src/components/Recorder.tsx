import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppConfig } from '../lib/config.ts';
import { formatSize, MAX_UPLOAD_BYTES } from '../lib/files.ts';
import {
  CHUNK_MS,
  clock,
  extensionFor,
  forgetRecording,
  MAX_RECORDING_SEC,
  patchMeeting,
  recordedBlob,
  recorderType,
  saveChunk,
  saveSession,
  uploadRecording,
  type Meeting,
} from '../lib/meetings.ts';

/*
 * The meeting recorder lives outside the Meetings screens: it wraps the whole
 * Blueprint app, while the screens themselves load on first use.
 */

type Props = { cfg: AppConfig; token: string };

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
