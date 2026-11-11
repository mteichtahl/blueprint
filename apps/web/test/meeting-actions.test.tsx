// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meeting, MeetingContent } from '../src/lib/meetings.ts';

/**
 * Rev 11 change: actions found in a meeting (to-dos, gigs, the plan update)
 * are listed with Do it and Ignore, and nothing happens until someone presses one.
 */

let served: { meeting: Meeting; content: MeetingContent };
vi.mock('../src/lib/meetings.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib/meetings.ts')>();
  return { ...real, getMeeting: async () => structuredClone(served) };
});
const { MeetingView } = await import('../src/pages/Meetings.tsx');

const calls: { method: string; url: string; body: unknown }[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, text: async () => '{}' };
    }),
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
    audioFileId: null,
    noteFileId: null,
    contentVersion: 0,
    aiJob: null,
    undoUntil: null,
    suggestionsWaiting: 0,
    actionsWaiting: 0,
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

const content: MeetingContent = {
  notes: '',
  markers: [],
  speakers: { spk_0: 'Kyra' },
  segments: [{ id: 0, speaker: 'spk_0', start: 61, end: 64, text: 'I’ll send the stems Friday.' }],
  actions: {
    requestId: 'r1',
    createdAt: '2026-11-11T03:00:00Z',
    createdBy: 'k',
    items: [
      {
        id: 'a1',
        kind: 'todo',
        why: 'Kyra will send the stems to the mixer.',
        refs: [0],
        todo: { title: 'Send the stems to the mixer', due: '2026-11-13' },
        status: 'waiting',
      },
      {
        id: 'a2',
        kind: 'gig',
        why: 'The Lantern Room show is booked.',
        refs: [],
        gig: { title: 'Lantern Room', date: '2026-12-12', startTime: '20:00' },
        status: 'waiting',
      },
      {
        id: 'a3',
        kind: 'todo',
        why: 'Book the photographer.',
        refs: [],
        todo: { title: 'Book the photographer' },
        status: 'done',
        resultId: 't9',
      },
    ],
  },
};

async function openActions(over: Partial<Meeting> = {}, c: MeetingContent = content) {
  served = { meeting: meeting({ actionsWaiting: 2, ...over }), content: c };
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
  const tab = await screen.findByRole('tab', { name: /^Actions/ });
  fireEvent.click(tab);
  return tab;
}

describe('actions from a meeting', () => {
  it('lists each waiting action with Do it and Ignore, and counts them on the tab', async () => {
    const tab = await openActions();
    expect(tab.textContent).toContain('2');
    expect(screen.getAllByRole('button', { name: 'Do it' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Ignore' })).toHaveLength(2);
    expect(screen.getByText('Add to-do')).toBeTruthy();
    expect(screen.getByText('Create gig')).toBeTruthy();
    expect(screen.getByText(/I’ll send the stems Friday/)).toBeTruthy();
    // The meeting isn't shared with Chloe, so its to-dos are BMG only.
    expect(screen.getByText(/added to Chloe Poli’s to-dos \(BMG only\)/)).toBeTruthy();
    expect(screen.getByText(/its to-dos are BMG only/)).toBeTruthy();
  });

  it('Do it asks the server to carry the action out', async () => {
    await openActions();
    fireEvent.click(screen.getAllByRole('button', { name: 'Do it' })[0]!);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: `https://api.example/meetings/${ARTIST}/mtg_1/actions/a1/do`,
        body: {},
      }),
    );
  });

  it('sends only what staff changed when they edit first', async () => {
    await openActions();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    fireEvent.change(screen.getByLabelText('Venue (optional)'), {
      target: { value: 'The Corner' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Do it' })[1]!);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        edits: { gig: { venue: 'The Corner' } },
      }),
    );
  });

  it('Ignore sets it aside', async () => {
    await openActions();
    fireEvent.click(screen.getAllByRole('button', { name: 'Ignore' })[0]!);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
        url: `https://api.example/meetings/${ARTIST}/mtg_1/actions`,
        body: { updates: [{ id: 'a1', status: 'ignored' }] },
      }),
    );
  });

  it('shows the plan update as an action that opens the review', async () => {
    await openActions(
      { suggestionsWaiting: 3 },
      {
        ...content,
        suggestions: { setId: 's', createdAt: '', basePlanVersion: 1, suggestions: [] },
      },
    );
    expect(screen.getByText('Update Chloe Poli’s plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and update' }));
    expect(screen.getByRole('tab', { name: /^Plan update/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});
