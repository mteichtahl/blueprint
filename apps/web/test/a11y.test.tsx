// @vitest-environment jsdom
import axe from 'axe-core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Me } from '../src/lib/api.ts';
import type { AppConfig } from '../src/lib/config.ts';
import { Home } from '../src/pages/Home.tsx';
import { SignIn } from '../src/pages/SignIn.tsx';

/**
 * Phase 6 gate: WCAG 2.2 AA checks (axe-core) on every screen of the BMG
 * desktop and the artist phone app, rendered with realistic API data.
 * Colour contrast can't be measured without a layout engine, so it is
 * checked separately on the brand tokens (contrast.test.ts).
 */

const cfg: AppConfig = {
  clientId: 'test',
  region: 'ap-southeast-2',
  userPoolId: 'ap-southeast-2_test',
  apiBase: '/v1',
};
const ARTIST = 'art_chloepoli000';
const now = '2026-11-10T00:00:00.000Z';
const artist = {
  artistId: ARTIST,
  displayName: 'Chloe Poli',
  status: 'active',
  createdAt: now,
};
const todo = {
  todoId: 'todo000000001',
  artistId: ARTIST,
  title: 'Book rehearsal',
  notes: null,
  due: '2026-11-20',
  dueTime: '18:00',
  reminder: '1d',
  remindAt: null,
  reminderFailed: true,
  phaseId: null,
  submissionId: null,
  done: false,
  source: 'bmg',
  bmgOnly: false,
  createdAt: now,
  updatedAt: null,
};
const file = {
  fileId: 'file000000001',
  name: 'press-shot.jpg',
  size: 2_400_000,
  contentType: 'image/jpeg',
  status: 'available',
  rejectReason: null,
  visibility: 'normal',
  uploadedByMe: true,
  uploaderRole: 'artist',
  createdAt: now,
  sharedWith: [],
  asset: {
    category: 'press-photo',
    title: 'Press shot',
    approvedFor: ['press'],
    status: 'approved',
    width: 3000,
    height: 2000,
  },
};
const plan = {
  exists: true,
  gaps: ['M2 is not fed by any milestone.'],
  phaseLibrary: ['Foundations', 'Live confidence'],
  stages: [],
  plan: {
    version: 1,
    updatedAt: now,
    outcome: 'Release an EP and play six shows',
    measures: [{ id: 'M1', label: 'Six shows played' }],
    phases: [
      {
        id: 'p1',
        name: 'Foundations',
        goal: 'Set up the basics',
        milestones: [{ id: 'm1', title: 'Photos done', done: true, measures: ['M1'] }],
      },
    ],
  },
};

/** API answers by path; anything else is a 404, which every screen must handle. */
function answer(method: string, path: string): [number, unknown] {
  const p = path.replace(/^\/v1/, '').split('?')[0]!;
  if (method !== 'GET') return [200, {}];
  const routes: [RegExp, unknown][] = [
    [/^\/artists$/, { artists: [artist] }],
    [/^\/artists\/[^/]+$/, artist],
    [/^\/artists\/[^/]+\/plan$/, plan],
    [/^\/artists\/[^/]+\/todos$/, { todos: [todo] }],
    [/^\/todos$/, { todos: [todo] }],
    [/^\/artists\/[^/]+\/files$/, { files: [file] }],
    [
      /^\/artists\/[^/]+\/brand-kit$/,
      {
        version: 1,
        logos: [{ fileId: file.fileId, label: 'Main logo' }],
        logoRules: 'Keep clear space',
        colours: [
          { name: 'Ink', hex: '#011935', role: 'text' },
          { name: 'Paper', hex: '#FFFFFF', role: 'background' },
          { name: 'Coral', hex: '#D9534F', role: 'primary' },
        ],
        fonts: { headline: 'League Spartan', body: 'Archivo Narrow' },
        voice: { words: 'Warm, honest', sayLike: '', avoid: '', bio: 'Melbourne singer.' },
        socials: { instagram: '@chloe', tiktok: '', youtube: '', spotify: '', website: '' },
        imagery: { note: '', fileIds: [] },
        updatedAt: now,
        updatedByName: 'Kyra',
      },
    ],
    [/^\/library\/files$/, { files: [] }],
    [/^\/review-queue$/, { submissions: [] }],
    [/^\/artists\/[^/]+\/submissions$/, { submissions: [] }],
    [/^\/gigs$/, { gigs: [] }],
    [/^\/artists\/[^/]+\/gigs$/, { gigs: [] }],
    [/^\/notifications$/, { notifications: [], unread: 0 }],
    [/^\/conversations$/, { conversations: [] }],
    [
      /^\/events$/,
      {
        events: [
          {
            eventId: 'evt000000001',
            name: 'Industry Mixer Night',
            date: '2027-02-12',
            startTime: '18:00',
            endTime: '23:00',
            venue: 'The Toff in Town',
            capacity: 200,
            ticketTarget: 150,
            ticketPriceCents: 2500,
            ticketsSold: 40,
            takingsCents: 0,
            compsTarget: 20,
            surveyAfter: true,
          },
        ],
      },
    ],
    [
      /^\/events\/evt000000001$/,
      {
        event: {
          eventId: 'evt000000001',
          name: 'Industry Mixer Night',
          date: '2027-02-12',
          startTime: '18:00',
          endTime: '23:00',
          venue: 'The Toff in Town',
          capacity: 200,
          ticketTarget: 150,
          ticketPriceCents: 2500,
          ticketsSold: 40,
          takingsCents: 0,
          compsTarget: 20,
          surveyAfter: true,
        },
        guests: [],
        speakers: [],
        crew: [],
        run: [],
        budget: [],
        summary: {
          ticketsSold: 40,
          ticketTarget: 150,
          compsAccepted: 0,
          compsTarget: 20,
          inRoom: 40,
          capacity: 200,
          budgetCents: 0,
          spentCents: 0,
          ticketIncomeCents: 100000,
          takingsCents: 0,
          profitCents: 0,
        },
      },
    ],
    [
      /^\/venues$/,
      {
        venues: [
          {
            venueId: 'ven000000001',
            name: 'The Toff in Town',
            capacity: 200,
            backline: true,
            website: '',
            address: '252 Swanston St',
            suburb: 'Melbourne',
            manager: null,
            booker: null,
            autoLogo: false,
            logo: null,
            archived: false,
            addedByArtist: false,
            canEdit: true,
            bookings: 3,
          },
        ],
      },
    ],
    [
      /^\/access\/settings$/,
      {
        artistDirectChats: true,
        artistGroups: false,
        artistGigSharing: true,
        version: 2,
        updatedAt: now,
        updatedByName: 'Kyra Teichtahl',
      },
    ],
    [
      /^\/access\/team$/,
      {
        team: [
          {
            sub: 'u1',
            email: 'kyra@example.com',
            displayName: 'Kyra Teichtahl',
            jobTitle: 'Founder & Director',
            role: 'bmg-admin',
            enabled: true,
            status: 'CONFIRMED',
            artistIds: [],
            createdAt: now,
          },
          {
            sub: 'u2',
            email: 'sam@example.com',
            displayName: 'Sam Lee',
            jobTitle: 'Events coordinator',
            role: 'bmg-staff',
            enabled: true,
            status: 'FORCE_CHANGE_PASSWORD',
            artistIds: [ARTIST],
            createdAt: now,
          },
        ],
      },
    ],
  ];
  for (const [re, body] of routes) if (re.test(p)) return [200, body];
  return [404, { detail: 'Not found in the test fixtures' }];
}

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const [status, body] = answer(init?.method ?? 'GET', String(input));
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
  // Stop stray rejections from fixture gaps failing the run; violations still do.
  window.addEventListener('unhandledrejection', (e) => e.preventDefault());
});
afterEach(cleanup);

const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));

async function violations(): Promise<string[]> {
  if (process.env.A11Y_DEBUG)
    console.log(
      'SCREEN',
      (document.querySelector('main') ?? document.body).textContent?.slice(0, 110),
    );
  const res = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false } },
    // jsdom can't run axe inside frames (the venue map is a Google iframe).
    iframes: false,
  });
  return res.violations.flatMap((v) =>
    v.nodes.map(
      (n) =>
        `${v.id}: ${v.help} -> ${n.target.join(' ')}${process.env.A11Y_DEBUG ? ' ' + n.html.slice(0, 160) : ''}`,
    ),
  );
}

const meOf = (role: Me['role']): Me =>
  ({
    sub: 'u1',
    role,
    artistId: role === 'artist' ? ARTIST : null,
    mfaLevel: 'cognito',
    stepUpRequired: false,
    consent: { termsVersion: '2026-11-09', aiOptIn: true },
  }) as unknown as Me;

const props = (role: Me['role']) => ({
  cfg,
  token: 't',
  me: meOf(role),
  userName: role === 'artist' ? 'Chloe Poli' : 'Kyra Teichtahl',
  onSignOut: () => undefined,
  onReauth: () => undefined,
});

describe('WCAG 2.2 AA (axe-core)', () => {
  it('sign-in screen', async () => {
    render(<SignIn cfg={cfg} onSignedIn={() => undefined} />);
    await settle();
    expect(await violations()).toEqual([]);
  });

  const BMG_VIEWS = [
    'Overview',
    'Chloe Poli',
    'Artist gigs',
    'Artists & applications',
    'Plan templates',
    'Chat',
    'Tasks & to-dos',
    'Document library',
    'Review queue',
    'Insights',
    'Events',
    'Newsroom',
    'Connectors',
    'Access & permissions',
    'AI prompts',
  ];
  it.each(BMG_VIEWS)('BMG desktop: %s', async (label) => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    const nav = screen.queryAllByRole('button', { name: new RegExp(`^${label}`) })[0];
    if (nav) fireEvent.click(nav);
    await settle();
    expect(await violations()).toEqual([]);
  });

  const TABS = ['Overview', 'Plan', 'To-do', 'Library', 'Assets', 'Brand kit'];
  it.each(TABS)('BMG artist workspace tab: %s', async (tab) => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    await settle();
    expect(await violations()).toEqual([]);
  });

  const PHONE = ['Home', 'Chat', 'To-do', 'Gigs', 'Library'];
  it.each(PHONE)('artist phone: %s', async (label) => {
    render(<Home {...props('artist')} />);
    await settle();
    const nav = screen.queryAllByRole('button', { name: new RegExp(`^${label}`) });
    if (nav.length) fireEvent.click(nav[nav.length - 1]!);
    await settle();
    expect(await violations()).toEqual([]);
  });

  it('artist phone: My brand kit', async () => {
    render(<Home {...props('artist')} />);
    await settle();
    const lib = screen.queryAllByRole('button', { name: /^Library/ });
    fireEvent.click(lib[lib.length - 1]!);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'My brand kit' }));
    await settle();
    expect(await violations()).toEqual([]);
  });
});

describe('WCAG 2.2 AA (axe-core): more screens and open states', () => {
  const phone = async () => {
    render(<Home {...props('artist')} />);
    await settle();
  };
  const click = async (name: RegExp | string) => {
    const all = screen.getAllByRole('button', { name });
    fireEvent.click(all[all.length - 1]!);
    await settle();
  };

  it.each([
    ['plan', /^Open/],
    ['stats', /^My stats/],
    ['connectors', /^Connect Instagram/],
    ['submit', /^Upload music or lyrics/],
  ] as const)('artist phone: %s', async (_view, name) => {
    await phone();
    await click(name);
    expect(await violations()).toEqual([]);
  });

  it('artist phone: account menu open', async () => {
    await phone();
    await click('Your account');
    expect(screen.getByRole('menu', { name: 'Your account' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('artist phone: profile (from the account menu)', async () => {
    await phone();
    await click('Your account');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Profile & preferences' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Upload a photo' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('artist phone: notifications open', async () => {
    await phone();
    await click(/^Notifications/);
    expect(await violations()).toEqual([]);
  });

  it('artist phone: AI assistant open', async () => {
    await phone();
    await click('Ask Blueprint AI');
    expect(await violations()).toEqual([]);
  });

  it('artist phone: editing a to-do', async () => {
    await phone();
    await click(/^To-do/);
    await click(/Book rehearsal/);
    expect(await violations()).toEqual([]);
  });

  it.each(['Chat', 'Submissions', 'Gigs', 'Stats'])('BMG artist workspace tab: %s', async (tab) => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    await settle();
    expect(await violations()).toEqual([]);
  });

  it('BMG: plan in edit mode (Markdown editors)', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Plan' }));
    await settle();
    const edit = screen.queryAllByRole('button', { name: /^Edit/ });
    if (edit.length) fireEvent.click(edit[0]!);
    await settle();
    expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();
    expect(await violations()).toEqual([]);
  });

  it('BMG: new event form', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Events/ })[0]!);
    await settle();
    await click(/^New event/);
    expect(await violations()).toEqual([]);
  });

  it('BMG: all events as cards, opening one', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Events/ })[0]!);
    await settle();
    await click(/^All events/);
    const card = screen.getByRole('button', { name: /Industry Mixer Night/ });
    expect(await violations()).toEqual([]);
    fireEvent.click(card);
    await settle();
    expect(screen.queryByRole('heading', { name: 'All events' })).toBeNull();
  });

  it('BMG: venue detail with booking count and map', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Venues/ })[0]!);
    await settle();
    await click('The Toff in Town');
    expect(screen.getByText('Booked 3 times')).toBeTruthy();
    expect(screen.getByTitle('Map of The Toff in Town')).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('BMG: asset details open', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Assets' }));
    await settle();
    expect(screen.getByRole('complementary', { name: 'Asset details' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });
});

describe('WCAG 2.2 AA (axe-core): Access & permissions', () => {
  it('BMG: editing a team member and adding one', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Access & permissions/ })[0]!);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sam' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add team member' }));
    await settle();
    expect(screen.getByRole('form', { name: 'Add team member' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });
});

describe('WCAG 2.2 AA (axe-core): phone layouts (tables as row cards)', () => {
  const desktop = window.matchMedia;
  beforeAll(() => {
    // A 375px phone: phone-width queries match, wider ones don't.
    window.matchMedia = ((q: string) => ({
      matches: /max-width:\s*(639|899)px/.test(q),
      media: q,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterAll(() => {
    window.matchMedia = desktop;
  });

  it.each(['Tasks & to-dos', 'Artists & applications', 'Review queue', 'Document library'])(
    'BMG phone: %s',
    async (label) => {
      render(<Home {...props('bmg-admin')} />);
      await settle();
      const nav = screen.queryAllByRole('button', { name: new RegExp(`^${label}`) })[0];
      if (nav) fireEvent.click(nav);
      await settle();
      expect(document.querySelector('table.dt:not(.dt-fit)')).toBeNull();
      expect(await violations()).toEqual([]);
    },
  );

  it('BMG phone: workspace To-do tab', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'To-do' }));
    await settle();
    expect(screen.getAllByRole('list', { name: 'To-dos' }).length).toBeGreaterThan(0);
    expect(await violations()).toEqual([]);
  });
});
