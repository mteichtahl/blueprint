// @vitest-environment jsdom
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectBar, useSelect, type BulkAction } from '../src/components/patterns.tsx';
import type { Meeting, MeetingContent } from '../src/lib/meetings.ts';
import { directUnread, type ConversationSummary } from '../src/pages/Messages.tsx';

/**
 * Workspace gaps: the unread count on the workspace chat icon (rev 9), Select
 * mode on lists other than the library, and editing a meeting's attendees
 * (rev 13).
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
      const body = url.endsWith('/access/team')
        ? {
            team: [
              { sub: 'u-kyra', displayName: 'Kyra Teichtahl' },
              { sub: 'u-sam', displayName: 'Sam Lee' },
            ],
          }
        : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ARTIST = 'art_aaaaaaaaaaaa';

describe('the workspace chat icon (rev 9)', () => {
  const conv = (over: Partial<ConversationSummary>): ConversationSummary =>
    ({
      conversationId: 'c',
      type: 'bmg-artist',
      artists: [{ artistId: ARTIST, displayName: 'Chloe' }],
      unreadCount: 0,
      archived: false,
      muted: false,
      ...over,
    }) as ConversationSummary;

  it("counts unread messages in Blueprint's chat with that artist only", () => {
    expect(
      directUnread(
        [
          conv({ conversationId: 'a', unreadCount: 3 }),
          conv({ conversationId: 'b', type: 'group', unreadCount: 5 }),
          conv({
            conversationId: 'c',
            artists: [{ artistId: 'art_other', displayName: 'X' }],
            unreadCount: 2,
          }),
          conv({ conversationId: 'd', unreadCount: 4, archived: true }),
        ],
        ARTIST,
      ),
    ).toBe(3);
    expect(directUnread(null, ARTIST)).toBe(0);
  });
});

function Rows({ actions, onDone }: { actions: BulkAction[]; onDone: () => void }) {
  const sel = useSelect();
  const ids = ['t1', 't2', 't3'];
  return (
    <>
      <SelectBar sel={sel} all={ids} actions={actions} onDone={onDone} />
      <ul>
        {ids.map((id) => (
          <li key={id}>
            <button type="button" onClick={() => (sel.on ? sel.toggle(id) : undefined)}>
              Row {id}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

describe('Select mode (rev 13)', () => {
  it('acts on the ticked rows it applies to, and reports what failed', async () => {
    const ran: string[] = [];
    const onDone = vi.fn();
    const action: BulkAction = {
      label: 'Mark done',
      applies: (id) => id !== 't3',
      run: async (id) => {
        ran.push(id);
        if (id === 't2') throw new Error('That to-do was deleted');
      },
      done: (n) => `Marked ${n} done`,
    };
    const { container } = render(<Rows actions={[action]} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect((screen.getByRole('button', { name: 'Mark done' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('3 selected')).toBeTruthy();
    expect((await axe.run(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await screen.findByText('Marked 1 done. 1 couldn’t be changed: That to-do was deleted');
    expect(ran).toEqual(['t1', 't2']);
    expect(onDone).toHaveBeenCalled();
    // Select mode ends; Select is back.
    expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy();
  });
});

describe('editing who was at a meeting (rev 13)', () => {
  it('adds and removes attendees and saves them with the meeting', async () => {
    served = {
      meeting: {
        meetingId: 'mtg_1',
        space: ARTIST,
        artistId: ARTIST,
        title: 'Meeting with Chloe Poli',
        source: 'recording',
        createdAt: '2026-11-11T03:00:00Z',
        startedAt: '2026-11-11T03:00:00Z',
        durationSec: 600,
        attendees: [
          { kind: 'artist', id: ARTIST, name: 'Chloe Poli' },
          { kind: 'staff', id: 'u-kyra', name: 'Kyra Teichtahl' },
        ],
        shared: false,
        status: 'ready',
        consent: { at: '2026-11-11T03:00:00Z', wording: 'Everyone agreed.' },
        recordedByMe: true,
        canDelete: true,
        canTranscribe: true,
        aiOffArtistIds: [],
        updatedAt: '2026-11-11T03:00:00Z',
      } as unknown as Meeting,
      content: { notes: '', markers: [], speakers: {}, segments: [] } as unknown as MeetingContent,
    };
    render(
      <MeetingView
        cfg={{ apiBase: 'https://api.example' } as never}
        token="t"
        artists={[{ artistId: ARTIST, displayName: 'Chloe Poli' }] as never}
        space={ARTIST}
        meetingId="mtg_1"
        onBack={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Edit details/ }));
    const sam = await screen.findByRole('button', { name: 'Sam Lee' });
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(sam);
    fireEvent.click(screen.getByRole('button', { name: 'Kyra Teichtahl' }));
    fireEvent.change(screen.getByLabelText('Someone else'), { target: { value: 'Jo Mixer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    // The artist the meeting is about stays.
    fireEvent.click(screen.getByRole('button', { name: 'Chloe Poli' }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!.body as {
      attendees: { kind: string; id: string; name: string }[];
    };
    expect(patch.attendees.map((a) => a.name)).toEqual(['Chloe Poli', 'Sam Lee', 'Jo Mixer']);
    expect(Object.keys(patch)).toEqual(['attendees']);
  });
});
