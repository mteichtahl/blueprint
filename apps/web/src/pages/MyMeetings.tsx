import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { useLive } from '../lib/live.ts';
import { Button, Card, DataTable, Notice, RowCard, Tag, WaveLoader } from '../components/ui.tsx';

/**
 * Rev 18, the artist's "My meetings": every meeting Blueprint put them in, and
 * any meeting about them that Blueprint shared. Title, when, how long and who
 * else was there. When a meeting about them is shared, its note and recording
 * open from here (they live in the artist's Library). Transcripts, summaries
 * and plan suggestions stay with Blueprint.
 */

export interface ArtistMeeting {
  meetingId: string;
  title: string;
  startedAt: string;
  durationSec: number | null;
  with: string[];
  attended: boolean;
  aboutMe: boolean;
  shared: boolean;
  recording: boolean;
  noteFileId: string | null;
  audioFileId: string | null;
}

export const meetingWhen = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/** "1 h 5 min", "25 min"; empty when not known. */
export function meetingLength(sec: number | null): string {
  if (!sec || sec < 60) return '';
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
}

const withText = (m: ArtistMeeting) => (m.with.length ? m.with.join(', ') : 'Blueprint');

function Badges({ m }: { m: ArtistMeeting }) {
  return (
    <>
      {m.recording && <Tag tone="c">Being recorded</Tag>}
      {m.aboutMe && <Tag tone="n">About you</Tag>}
      {m.shared && <Tag tone="s">Shared with you</Tag>}
    </>
  );
}

function Open({ m, onOpenFile }: { m: ArtistMeeting; onOpenFile: (fileId: string) => void }) {
  if (!m.noteFileId && !m.audioFileId) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {m.noteFileId && (
        <Button size="sm" variant="ghost" onClick={() => onOpenFile(m.noteFileId!)}>
          Open the note
        </Button>
      )}
      {m.audioFileId && (
        <Button size="sm" variant="ghost" onClick={() => onOpenFile(m.audioFileId!)}>
          Recording
        </Button>
      )}
    </span>
  );
}

export function MyMeetings({
  cfg,
  token,
  artistId,
  compact = false,
  onOpenFile,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  compact?: boolean;
  /** Opens one of the artist's own files (the meeting note or recording) in the Library. */
  onOpenFile: (fileId: string) => void;
}) {
  const [meetings, setMeetings] = useState<ArtistMeeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await api<{ meetings: ArtistMeeting[] }>(cfg, token, 'GET', '/meetings/mine');
      setMeetings(res.meetings);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token]);
  const live = useLive(['meetings'], artistId);
  useEffect(() => void load(), [load, live]);

  return (
    <Card title={<span className="eyebrow">Meetings with Blueprint</span>}>
      {error && <Notice tone="error">{error}</Notice>}
      {meetings === null ? (
        !error && <WaveLoader />
      ) : meetings.length === 0 ? (
        <p className="src m-0">
          No meetings yet. When Blueprint records a meeting with you, it shows here.
        </p>
      ) : compact ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Meetings">
          {meetings.map((m) => (
            <RowCard
              key={m.meetingId}
              title={m.title}
              sub={[meetingWhen(m.startedAt), meetingLength(m.durationSec)]
                .filter(Boolean)
                .join(' · ')}
              tags={
                <>
                  <span className="src">With {withText(m)}</span>
                  <Badges m={m} />
                </>
              }
              actions={<Open m={m} onOpenFile={onOpenFile} />}
            />
          ))}
        </ul>
      ) : (
        <DataTable label="Meetings">
          <thead>
            <tr>
              <th scope="col">Meeting</th>
              <th scope="col">When</th>
              <th scope="col">Length</th>
              <th scope="col">With</th>
              <th scope="col">
                <span className="sr-only">Note and recording</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((m) => (
              <tr key={m.meetingId}>
                <td>
                  <b>{m.title}</b>
                  <span className="mt-1 flex flex-wrap gap-1">
                    <Badges m={m} />
                  </span>
                </td>
                <td>{meetingWhen(m.startedAt)}</td>
                <td>{meetingLength(m.durationSec) || '—'}</td>
                <td>{withText(m)}</td>
                <td>
                  <Open m={m} onOpenFile={onOpenFile} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <p className="src m-0">
        Blueprint keeps the recording and transcript. When they share a meeting about you, its note
        and recording open from here and from your Library.
      </p>
    </Card>
  );
}
