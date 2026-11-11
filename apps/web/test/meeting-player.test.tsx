// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meeting, MeetingContent } from '../src/lib/meetings.ts';

/**
 * The meeting player: recordings made in the browser don't say how long they
 * are, and some browsers then "play" in silence until something seeks. The
 * player seeks for them, on load and on the first play.
 */

let served: { meeting: Meeting; content: MeetingContent };
vi.mock('../src/lib/meetings.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib/meetings.ts')>();
  return { ...real, getMeeting: async () => structuredClone(served) };
});
const { MeetingView } = await import('../src/pages/Meetings.tsx');

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ url: 'https://files.example/rec.webm' }),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ARTIST = 'art_aaaaaaaaaaaa';
const cfg = { apiBase: 'https://api.example' } as never;
const artists = [{ artistId: ARTIST, displayName: 'Chloe Poli' }] as never;

function meeting(over: Partial<Meeting> = {}): Meeting {
  return {
    meetingId: 'mtg_1',
    space: ARTIST,
    artistId: ARTIST,
    title: 'Meeting with Chloe Poli',
    source: 'recording',
    createdAt: '2026-11-11T03:00:00Z',
    startedAt: '2026-11-11T03:00:00Z',
    durationSec: 600,
    attendees: [],
    shared: false,
    status: 'ready',
    statusReason: null,
    folderId: null,
    audioFileId: 'fil_audio0001',
    noteFileId: null,
    contentVersion: 0,
    aiJob: null,
    undoUntil: null,
    suggestionsWaiting: 0,
    consent: { at: '2026-11-11T03:00:00Z', wording: 'Everyone agreed.' },
    recordedByMe: true,
    canDelete: true,
    canTranscribe: true,
    transcribeBlockedReason: null,
    aiOffArtistIds: [],
    updatedAt: '2026-11-11T03:00:00Z',
    ...over,
  };
}

async function player(duration: number) {
  served = {
    meeting: meeting(),
    content: { notes: '', markers: [], speakers: {}, segments: [] },
  };
  render(
    <MeetingView
      cfg={cfg}
      token="t"
      artists={artists}
      space={ARTIST}
      meetingId="mtg_1"
      onBack={() => {}}
    />,
  );
  const a = (await screen.findByLabelText('Meeting recording')) as HTMLAudioElement;
  await waitFor(() => expect(a.getAttribute('src')).toBe('https://files.example/rec.webm'));
  const seeks: number[] = [];
  let now = 0;
  Object.defineProperty(a, 'duration', { configurable: true, get: () => duration });
  Object.defineProperty(a, 'currentTime', {
    configurable: true,
    get: () => now,
    set: (v: number) => {
      seeks.push(v);
      now = v;
    },
  });
  return { a, seeks };
}

describe('the meeting player', () => {
  it('works out the length of a recording that doesn’t say, then goes back', async () => {
    const { a, seeks } = await player(Infinity);
    fireEvent.loadedMetadata(a);
    expect(seeks).toEqual([Number.MAX_SAFE_INTEGER]);
    fireEvent.durationChange(a);
    expect(seeks).toEqual([Number.MAX_SAFE_INTEGER, 0]);
    // Only once.
    fireEvent.seeked(a);
    expect(seeks).toHaveLength(2);
  });

  it('goes back even when the browser can’t work out the length', async () => {
    const { a, seeks } = await player(Infinity);
    fireEvent.loadedMetadata(a);
    fireEvent.seeked(a);
    expect(seeks.at(-1)).toBe(0);
  });

  it('leaves a recording with a known length alone until it plays', async () => {
    const { a, seeks } = await player(600);
    fireEvent.loadedMetadata(a);
    expect(seeks).toEqual([]);
  });

  it('seeks once on the first play, which starts the sound', async () => {
    const { a, seeks } = await player(600);
    fireEvent.loadedMetadata(a);
    fireEvent.play(a);
    expect(seeks).toEqual([0]);
    fireEvent.play(a);
    expect(seeks).toEqual([0]);
  });
});
