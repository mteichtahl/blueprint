// @vitest-environment jsdom
import axe from 'axe-core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Me } from '../src/lib/api.ts';
import type { AppConfig } from '../src/lib/config.ts';
import { inboxChannels } from '../src/lib/realtime.ts';
import { BmgChat } from '../src/pages/Messages.tsx';

/** Chat between Blueprint staff (rev 14): team chats on the Chat screen. */

const cfg: AppConfig = {
  clientId: 'test',
  region: 'ap-southeast-2',
  userPoolId: 'ap-southeast-2_test',
  apiBase: '/v1',
};
const KYRA = '11111111-1111-4111-8111-111111111111';
const SAM = '22222222-2222-4222-8222-222222222222';
const JO = '33333333-3333-4333-8333-333333333333';
const now = '2026-11-13T00:00:00.000Z';
const me: Me = {
  sub: KYRA,
  role: 'bmg-admin',
  artistId: null,
  jobTitle: 'Founder & Director',
  mfaLevel: 'cognito',
  stepUpRequired: false,
  consent: null,
};

const base = {
  description: null,
  artists: [],
  access: 'read-write',
  canSend: true,
  settings: null,
  previewTicks: null,
  pinned: false,
  muted: false,
  archived: false,
  private: false,
  team: true,
  isAdmin: false,
  staffSettings: null,
};
const member = (sub: string, displayName: string, jobTitle: string, extra = {}) => ({
  sub,
  displayName,
  jobTitle,
  admin: false,
  active: true,
  me: sub === KYRA,
  ...extra,
});
const direct = {
  ...base,
  conversationId: `sd-${KYRA}-${SAM}`,
  type: 'staff-direct',
  title: 'Sam Lee',
  lastMessageAt: now,
  preview: 'Venue confirmed',
  previewSender: null,
  unreadCount: 1,
  lastSeen: now,
  members: [member(KYRA, 'Kyra', 'Founder & Director'), member(SAM, 'Sam Lee', 'Booking Manager')],
};
const group = {
  ...base,
  conversationId: 'sg-abcdefghij12',
  type: 'staff-group',
  title: 'Mixer crew',
  lastMessageAt: '2026-11-12T00:00:00.000Z',
  preview: 'Run sheet v2',
  previewSender: 'Jo',
  unreadCount: 0,
  lastSeen: null,
  isAdmin: true,
  staffSettings: { onlyAdminsSend: false, onlyAdminsEditInfo: false },
  members: [
    member(KYRA, 'Kyra', 'Founder & Director', { admin: true }),
    member(SAM, 'Sam Lee', 'Booking Manager'),
  ],
};
const artistChat = {
  ...base,
  team: undefined,
  members: undefined,
  conversationId: 'dm-art_chloepoli000',
  type: 'bmg-artist',
  title: 'Chloe Poli',
  artists: [{ artistId: 'art_chloepoli000', displayName: 'Chloe Poli' }],
  lastMessageAt: '2026-11-11T00:00:00.000Z',
  preview: 'New mix is up',
  previewSender: 'Chloe Poli',
  unreadCount: 0,
  lastSeen: null,
};
const team = [
  { sub: KYRA, displayName: 'Kyra', jobTitle: 'Founder & Director', me: true, lastSeen: now },
  { sub: SAM, displayName: 'Sam Lee', jobTitle: 'Booking Manager', me: false, lastSeen: now },
  { sub: JO, displayName: 'Jo Park', jobTitle: 'Events', me: false, lastSeen: null },
];

const posts: { path: string; body: unknown }[] = [];

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/v1/, '').split('?')[0]!;
    const method = init?.method ?? 'GET';
    let body: unknown = { detail: 'Not found in the test fixtures' };
    let status = 200;
    if (method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      body = { conversationId: `sd-${KYRA}-${JO}` };
      status = 201;
    } else if (path === '/conversations') body = { conversations: [direct, group, artistChat] };
    else if (path === '/directory') body = { artists: [], team };
    else if (/^\/conversations\/[^/]+\/messages$/.test(path))
      body = {
        conversationId: direct.conversationId,
        type: 'staff-direct',
        access: 'read-write',
        canSend: true,
        firstUnreadMessageId: null,
        nextBefore: null,
        messages: [],
      };
    else status = 404;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.scrollTo = () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  window.addEventListener('unhandledrejection', (e) => e.preventDefault());
});
afterEach(cleanup);

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function show() {
  render(<BmgChat cfg={cfg} token="t" me={me} artists={[]} />);
  await settle();
  await settle();
}

describe('team chats on the Chat screen (rev 14)', () => {
  it('listens on the person’s own team channel as well as Blueprint’s', () => {
    expect(inboxChannels('bmg-staff', null, SAM)).toEqual(['/inbox/bmg', `/inbox/staff-${SAM}`]);
    expect(inboxChannels('artist', 'art_x', 'whatever')).toEqual([
      '/inbox/artist-art_x',
      '/inbox/all-artists',
    ]);
  });

  it('tags team chats and filters them with Team', async () => {
    await show();
    const list = screen.getByRole('region', { name: 'Chats' });
    expect(within(list).getAllByText('Team').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(within(list).getByRole('button', { name: 'Team' }));
    expect(within(list).queryByText('Chloe Poli')).toBeNull();
    expect(within(list).getByText('Mixer crew')).toBeTruthy();
    expect(within(list).getByText('Sam Lee')).toBeTruthy();
  });

  it('shows the team lock note in a team chat', async () => {
    await show();
    expect(
      screen.getByText(/Team chat\. Only the Blueprint people in it can see these messages\./),
    ).toBeTruthy();
  });

  it('lists the Blueprint team in New chat and starts a direct chat', async () => {
    await show();
    posts.length = 0;
    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0]!);
    await settle();
    expect(screen.getByText('Blueprint team')).toBeTruthy();
    expect(screen.getByText('Message yourself')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Jo Park/ }));
    await settle();
    expect(posts).toEqual([{ path: '/conversations', body: { kind: 'direct', staffSub: JO } }]);
  });

  it('makes a team group when only team members are picked', async () => {
    await show();
    posts.length = 0;
    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0]!);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /New group/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sam Lee' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/Only the Blueprint team can see this group\./)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('e.g. Mixer crew'), {
      target: { value: 'Stand-up' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await settle();
    expect(posts[0]).toEqual({
      path: '/conversations',
      body: {
        kind: 'group',
        title: 'Stand-up',
        description: '',
        staffSubs: [SAM],
        staffSettings: { onlyAdminsSend: false, onlyAdminsEditInfo: false },
      },
    });
  });

  it('passes the accessibility checks', async () => {
    await show();
    const res = await axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target}`))).toEqual([]);
  });
});
