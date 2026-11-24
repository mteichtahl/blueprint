// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/lib/config.ts';
import { countsLine, DeleteArtistPage, DeletedArtists } from '../src/pages/DeleteArtist.tsx';

/** Rev 22: deleting an artist, and the Deleted list. */

const cfg: AppConfig = {
  clientId: 'test',
  region: 'ap-southeast-2',
  userPoolId: 'ap-southeast-2_test',
  apiBase: '/v1',
};
const A = 'art_abcdefghij123456';
type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
let routes: [RegExp, unknown][] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
      const path = url.replace(/^\/v1/, '').split('?')[0]!;
      const hit = init.method === 'GET' ? routes.find(([re]) => re.test(path)) : undefined;
      return {
        ok: true,
        status: init.method === 'POST' ? 202 : 200,
        text: async () => JSON.stringify(hit ? hit[1] : { ok: true }),
      };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

const COUNTS = {
  files: 48,
  chats: 6,
  plan: 1,
  todos: 23,
  gigs: 9,
  submissions: 4,
  meetings: 0,
  other: 3,
};

describe('the confirm page', () => {
  it('says what will be archived, needs a reason and the typed name, then starts', async () => {
    routes = [
      [
        /\/access\/artists\/.+\/delete$/,
        {
          artistId: A,
          displayName: 'Chloe Poli',
          status: 'active',
          counts: COUNTS,
          upcomingGigs: [],
        },
      ],
    ];
    const started = vi.fn();
    render(
      <DeleteArtistPage
        cfg={cfg}
        token="t"
        artistId={A}
        onBack={() => undefined}
        onStarted={started}
        onReauth={() => undefined}
      />,
    );
    await settle();
    expect(
      screen.getByText(/48 files, 6 chats, 1 plan, 23 to-dos, 9 gigs, 4 submissions/),
    ).toBeTruthy();
    const del = screen.getByRole('button', { name: 'Delete artist' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'left' } });
    fireEvent.change(screen.getByLabelText('Type Chloe Poli to confirm'), {
      target: { value: 'chloe' },
    });
    expect(del.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type Chloe Poli to confirm'), {
      target: { value: ' chloe  poli ' },
    });
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    await settle();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toMatch(new RegExp(`/access/artists/${A}/delete$`));
    expect(post?.body).toMatchObject({
      reason: 'left',
      emailArtist: false,
      acknowledgeUpcoming: false,
    });
    expect(started).toHaveBeenCalledWith('Chloe Poli');
  });

  it('asks for a second tick when they have a gig this week', async () => {
    routes = [
      [
        /\/access\/artists\/.+\/delete$/,
        {
          artistId: A,
          displayName: 'SARUN',
          status: 'active',
          counts: COUNTS,
          upcomingGigs: [{ gigId: 'g1', title: 'Corner Hotel', date: '2026-11-28' }],
        },
      ],
    ];
    render(
      <DeleteArtistPage
        cfg={cfg}
        token="t"
        artistId={A}
        onBack={() => undefined}
        onStarted={() => undefined}
        onReauth={() => undefined}
      />,
    );
    await settle();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'asked' } });
    fireEvent.change(screen.getByLabelText('Type SARUN to confirm'), {
      target: { value: 'SARUN' },
    });
    const del = screen.getByRole('button', { name: 'Delete artist' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Delete them anyway'));
    expect(del.disabled).toBe(false);
  });
});

describe('the Deleted list', () => {
  it('shows progress, and Retry on a paused deletion', async () => {
    routes = [
      [
        /\/access\/deletions$/,
        {
          deletions: [
            {
              artistId: A,
              deletionId: 'd1',
              displayName: 'Chloe Poli',
              reasonLabel: 'Left Blueprint',
              note: null,
              byName: 'Kyra',
              startedAt: '2026-11-24T00:00:00Z',
              finishedAt: null,
              status: 'paused',
              stepLabel: 'Archive their data and files',
              stepNumber: 2,
              stepCount: 6,
              error: 'AccessDenied: no',
              counts: COUNTS,
              archive: null,
              retainUntil: null,
              mentions: [{ fileId: 'f1', name: 'Chloe Poli EPK.pdf', why: 'name' }],
            },
          ],
        },
      ],
    ];
    render(<DeletedArtists cfg={cfg} token="t" />);
    await settle();
    expect(screen.getByText('Paused')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Open the deletion of Chloe Poli/ }));
    await settle();
    expect(screen.getByText(/Deletion paused at step 2/)).toBeTruthy();
    expect(screen.getByText('Chloe Poli EPK.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(
      calls.some((c) => c.method === 'POST' && /\/access\/deletions\/.+\/retry$/.test(c.url)),
    ).toBe(true);
  });
});

describe('counts', () => {
  it('leaves out what they don’t have', () => {
    expect(countsLine({ ...COUNTS, files: 1, chats: 0, todos: 0, gigs: 0, submissions: 0 })).toBe(
      '1 file, 1 plan',
    );
    expect(
      countsLine({
        files: 0,
        chats: 0,
        plan: 0,
        todos: 0,
        gigs: 0,
        submissions: 0,
        meetings: 0,
        other: 0,
      }),
    ).toBe('Nothing in their workspace yet');
  });
});
