// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting, MeetingContent } from '../src/lib/meetings.ts';

/**
 * Rev 11, spec 5 and 8: when an artist in a meeting has AI off, Transcribe
 * is disabled (not hidden) and the Transcript tab is greyed out, with why.
 */

let served: { meeting: Meeting; content: MeetingContent };
vi.mock('../src/lib/meetings.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib/meetings.ts')>();
  return { ...real, getMeeting: async () => structuredClone(served) };
});
const { MeetingView, UnfinishedRecording } = await import('../src/pages/Meetings.tsx');

afterEach(cleanup);

const ARTIST = 'art_aaaaaaaaaaaa';
const cfg = {} as never;
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
    status: 'no-ai',
    statusReason: 'An artist in this meeting has turned off AI assistance…',
    folderId: null,
    audioFileId: null,
    noteFileId: null,
    contentVersion: 0,
    aiJob: null,
    undoUntil: null,
    suggestionsWaiting: 0,
    consent: { at: '2026-11-11T03:00:00Z', wording: 'Everyone agreed.' },
    recordedByMe: true,
    canDelete: true,
    canTranscribe: false,
    transcribeBlockedReason: 'ai_opt_out',
    aiOffArtistIds: [ARTIST],
    updatedAt: '2026-11-11T03:00:00Z',
    ...over,
  };
}
const empty: MeetingContent = { notes: '', markers: [], speakers: {}, segments: [] };

const show = () =>
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

describe('a meeting with AI off', () => {
  it('greys out the Transcript tab, opens on Details and disables Transcribe now', async () => {
    served = { meeting: meeting(), content: empty };
    show();
    const tab = await screen.findByRole('tab', { name: /Transcript/ });
    expect(tab.getAttribute('aria-disabled')).toBe('true');
    expect(tab.tabIndex).toBe(-1);
    expect(tab.title).toBe('Transcripts are off because Chloe Poli has turned off AI assistance.');
    expect(screen.getByRole('tab', { name: 'Details' }).getAttribute('aria-selected')).toBe('true');

    // Clicking the greyed tab does nothing.
    fireEvent.click(tab);
    expect(tab.getAttribute('aria-selected')).toBe('false');

    const button = screen.getByRole('button', { name: 'Transcribe now' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText(
        'Chloe Poli has turned off AI assistance, so this meeting can’t be transcribed. You can keep the recording and your notes.',
      ),
    ).toBeTruthy();
  });

  it('turns both back on once the artist opts in', async () => {
    served = {
      meeting: meeting({ canTranscribe: true, transcribeBlockedReason: null, aiOffArtistIds: [] }),
      content: empty,
    };
    show();
    const tab = await screen.findByRole('tab', { name: /Transcript/ });
    expect(tab.getAttribute('aria-disabled')).toBeNull();
    const button = screen.getByRole('button', { name: 'Transcribe now' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('keeps a transcript made before the artist opted out', async () => {
    served = {
      meeting: meeting({ status: 'ready' }),
      content: { ...empty, segments: [{ id: 0, speaker: '', start: 0, end: 2, text: 'Hi' }] },
    };
    show();
    const tab = await screen.findByRole('tab', { name: /Transcript/ });
    expect(tab.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('an unfinished recording with AI off', () => {
  it('offers Finish and save, with Finish and transcribe disabled', () => {
    render(
      <UnfinishedRecording
        cfg={cfg}
        token="t"
        session={{
          meetingId: 'mtg_1',
          space: ARTIST,
          artistId: ARTIST,
          title: 'Meeting with Chloe Poli',
          startedAt: '2026-11-11T03:00:00Z',
          mimeType: 'audio/webm',
          elapsed: 120,
          updatedAt: '2026-11-11T03:02:00Z',
        }}
        aiOff={{
          notice: 'Chloe Poli has turned off AI assistance…',
          tooltip: 'Transcripts are off.',
        }}
        onDone={() => {}}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Finish and save' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Finish and transcribe' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
