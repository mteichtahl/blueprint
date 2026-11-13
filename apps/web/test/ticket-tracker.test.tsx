// @vitest-environment jsdom
import axe from 'axe-core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/lib/config.ts';

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

vi.mock('../src/lib/api.ts', () => ({
  api: vi.fn((_cfg: unknown, _token: unknown, _m: string, path: string) => {
    if (path === '/events')
      return Promise.resolve({
        events: [
          {
            eventId: 'e1',
            name: 'Industry Mixer Night',
            date: soon(5),
            venue: 'The Toff',
            capacity: 80,
            ticketTarget: 70,
            ticketsSold: 12,
            ticketPriceCents: 2500,
            takingsCents: 0,
          },
          {
            eventId: 'w1',
            kind: 'workshop',
            name: 'Release planning workshop',
            date: soon(20),
            venue: 'Blueprint studio',
            capacity: 20,
            ticketTarget: 0,
            ticketsSold: 9,
            ticketPriceCents: 4000,
            takingsCents: 0,
          },
        ],
      });
    if (path.startsWith('/gigs'))
      return Promise.resolve({
        gigs: [
          {
            gigId: 'g1',
            artistId: 'art_chloe',
            title: 'Single launch',
            date: soon(10),
            status: 'booked',
            deal: 'ticketed',
            venueId: 'v1',
            ticketUrl: 'https://events.humanitix.com/launch',
            money: { ticketsSold: 90, takingsCents: 180000 },
          },
          {
            gigId: 'g2',
            artistId: 'art_chloe',
            title: 'Paid corporate set',
            date: soon(3),
            status: 'booked',
            deal: 'fee',
          },
        ],
      });
    return Promise.resolve({ venues: [{ venueId: 'v1', capacity: 150 }] });
  }),
}));

const { TicketTracker } = await import('../src/components/TicketTracker.tsx');

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('Studio HQ Tickets card', () => {
  it('shows events, workshops and ticketed gigs, and opens them', async () => {
    const onOpenEvent = vi.fn();
    const onOpenGig = vi.fn();
    render(
      <TicketTracker
        cfg={{} as AppConfig}
        token="t"
        artistNames={{ art_chloe: 'Chloe Poli' }}
        onOpenEvent={onOpenEvent}
        onOpenGig={onOpenGig}
        onNavigate={() => {}}
      />,
    );
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual([
      'Industry Mixer NightThe Toff',
      'Single launchChloe Poli',
      'Release planning workshopBlueprint studio',
    ]);
    // The fee gig has no tickets to sell; the Mixer is behind (12 of 70, 5 days out).
    expect(screen.queryByText('Paid corporate set')).toBeNull();
    expect(within(rows[0]!).getByText('Behind')).toBeTruthy();
    expect(within(rows[1]!).getByText('90 / 150 cap.')).toBeTruthy();
    expect(within(rows[1]!).getByText('Humanitix')).toBeTruthy();
    expect(screen.getByText('111')).toBeTruthy(); // tickets sold in total

    const res = await axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);

    fireEvent.click(rows[0]!);
    expect(onOpenEvent).toHaveBeenCalledWith('e1');
    fireEvent.click(rows[1]!);
    expect(onOpenGig).toHaveBeenCalledWith(expect.objectContaining({ gigId: 'g1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Artist gigs', pressed: false }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
  });
});
