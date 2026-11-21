// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emitLive,
  LIVE_DEBOUNCE_MS,
  liveMatches,
  useLive,
  type LiveTopic,
} from '../src/lib/live.ts';

afterEach(cleanup);
beforeEach(() => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

describe('live updates: matching', () => {
  it('matches the topic, and the artist when the screen is for one artist', () => {
    expect(liveMatches({ live: 'gigs', artistId: 'a1' }, ['gigs'])).toBe(true);
    expect(liveMatches({ live: 'gigs', artistId: 'a1' }, ['gigs'], 'a1')).toBe(true);
    expect(liveMatches({ live: 'gigs', artistId: 'a2' }, ['gigs'], 'a1')).toBe(false);
    expect(liveMatches({ live: 'todos', artistId: 'a1' }, ['gigs'], 'a1')).toBe(false);
    expect(liveMatches({ live: 'venues' }, ['venues'], 'a1')).toBe(true);
  });

  it('treats a catch-up as a change to everything', () => {
    expect(liveMatches({ live: '*' }, ['plan'], 'a1')).toBe(true);
  });
});

function Probe({ topics, artistId }: { topics: LiveTopic[]; artistId?: string }) {
  return <p data-testid="tick">{useLive(topics, artistId)}</p>;
}

describe('live updates: useLive', () => {
  it('refreshes once for a burst of changes, without a reload', () => {
    render(<Probe topics={['todos']} artistId="a1" />);
    expect(screen.getByTestId('tick').textContent).toBe('0');
    act(() => {
      emitLive({ live: 'todos', artistId: 'a1' });
      emitLive({ live: 'todos', artistId: 'a1' });
      emitLive({ live: 'todos', artistId: 'a1' });
      vi.advanceTimersByTime(LIVE_DEBOUNCE_MS);
    });
    expect(screen.getByTestId('tick').textContent).toBe('1');
  });

  it("ignores other topics and other artists' changes", () => {
    render(<Probe topics={['gigs']} artistId="a1" />);
    act(() => {
      emitLive({ live: 'todos', artistId: 'a1' });
      emitLive({ live: 'gigs', artistId: 'a2' });
      vi.advanceTimersByTime(LIVE_DEBOUNCE_MS * 2);
    });
    expect(screen.getByTestId('tick').textContent).toBe('0');
  });
});
