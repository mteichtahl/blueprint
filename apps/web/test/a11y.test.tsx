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
/** Chloe's profile picture (1px PNG), from GET /avatars. */
const CHLOE_PIC =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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
  title: 'Press shot',
  displayName: 'Press shot',
  fileType: { kind: 'image', label: 'JPEG image', ext: 'jpg', mime: 'image/jpeg', detected: true },
  hasThumbnail: false,
  thumbnailUrl: null,
  size: 2_400_000,
  contentType: 'image/jpeg',
  status: 'available',
  rejectReason: null,
  visibility: 'normal',
  uploadedByMe: true,
  uploaderRole: 'artist',
  ownerId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  ownerRole: 'artist',
  ownerName: 'Chloe Poli',
  ownerJobTitle: 'Artist',
  ownedByMe: true,
  editAccess: 'chosen',
  editorIds: ['7c9e6679-7425-40de-944b-e07fc1f90ae7'],
  locked: false,
  canEdit: true,
  canManage: true,
  version: 2,
  versionUploadedBy: '0f8fad5b-d9cb-469f-a165-70867728950e',
  versionUploadedByName: 'Chloe Poli',
  versionCreatedAt: now,
  versionNote: 'Brighter edit',
  versions: [
    {
      v: 1,
      name: 'press-shot-old.jpg',
      size: 2_000_000,
      fileType: {
        kind: 'image',
        label: 'JPEG image',
        ext: 'jpg',
        mime: 'image/jpeg',
        detected: true,
      },
      uploadedBy: '0f8fad5b-d9cb-469f-a165-70867728950e',
      uploadedByName: 'Chloe Poli',
      createdAt: now,
      note: null,
    },
  ],
  pendingVersion: null,
  createdAt: now,
  sharedWith: [],
  sharedWithArtistIds: [],
  scope: 'artist',
  artistId: 'art_chloepoli000',
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
const meeting = {
  meetingId: 'mtg0000000001',
  space: ARTIST,
  artistId: ARTIST,
  title: 'Meeting with Chloe Poli',
  source: 'recording',
  createdAt: now,
  startedAt: now,
  durationSec: 1834,
  attendees: [
    { kind: 'staff', id: 'u1', name: 'Kyra Teichtahl' },
    { kind: 'artist', id: ARTIST, name: 'Chloe Poli' },
  ],
  shared: false,
  status: 'ready',
  statusReason: null,
  folderId: 'fold000000001',
  audioFileId: 'file000000009',
  noteFileId: 'file000000010',
  contentVersion: 3,
  aiJob: null,
  undoUntil: null,
  suggestionsWaiting: 2,
  actionsWaiting: 1,
  consent: {
    at: now,
    wording: 'Everyone in this meeting knows it’s being recorded and has agreed.',
  },
  recordedByMe: true,
  canDelete: true,
  canTranscribe: true,
  transcribeBlockedReason: null,
  aiOffArtistIds: [] as string[],
  updatedAt: now,
};
/** Serve the meeting as one Chloe has turned AI off for (spec 8). */
let meetingAiOff = false;
const aiOffMeeting = () => ({
  ...meeting,
  status: 'no-ai',
  statusReason: 'An artist in this meeting has turned off AI assistance.',
  suggestionsWaiting: 0,
  canTranscribe: false,
  transcribeBlockedReason: 'ai_opt_out',
  aiOffArtistIds: [ARTIST],
});
const meetingContent = {
  notes: 'Push the EP to January',
  actions: {
    requestId: 'r1',
    createdAt: now,
    createdBy: 'k',
    items: [
      {
        id: 'a1',
        kind: 'todo',
        why: 'Kyra will send the stems to the mixer.',
        refs: [0],
        todo: { title: 'Send the stems to the mixer', due: '2026-12-01' },
        status: 'waiting',
      },
      {
        id: 'a2',
        kind: 'gig',
        why: 'The Lantern Room show was booked.',
        refs: [],
        gig: { title: 'Lantern Room', date: '2026-12-12', startTime: '20:00' },
        status: 'done',
        resultId: 'gig1',
      },
    ],
  },
  markers: [{ at: 61, note: 'budget agreed' }],
  speakers: { spk_0: 'Kyra Teichtahl' },
  segments: [
    {
      id: 0,
      speaker: 'spk_0',
      start: 3,
      end: 9,
      text: 'Let’s move the EP release to late January.',
    },
    { id: 1, speaker: 'spk_1', start: 10, end: 14, text: 'Agreed. The mastering is done.' },
  ],
  summaries: [
    {
      id: 's1',
      kind: 'full',
      createdAt: now,
      sections: [
        { heading: 'Decisions', points: [{ text: 'The EP moves to late January.', refs: [0] }] },
      ],
      actions: [{ text: 'Tell the distributor', owner: 'Kyra', refs: [0] }],
    },
  ],
  answers: [
    { id: 'a1', question: 'When is the EP?', answer: 'Late January.', refs: [0], createdAt: now },
  ],
  suggestions: {
    setId: 'set1',
    createdAt: now,
    basePlanVersion: 3,
    suggestions: [
      {
        id: 'c1',
        change: {
          kind: 'stage.dates',
          phaseId: 'p3',
          end: '2027-01-30',
          reason: 'Agreed to move the EP',
          refs: [0],
        },
        where: 'Album release',
        before: '1 Nov 2026 – 12 Dec 2026',
        after: '1 Nov 2026 – 30 Jan 2027',
        checkThis: true,
        status: 'waiting',
      },
      {
        id: 'c2',
        change: {
          kind: 'milestone.done',
          phaseId: 'p3',
          milestoneId: 'm1',
          done: true,
          reason: 'Mastering is done',
          refs: [1],
        },
        where: 'Album release › Master the EP',
        before: 'Not done',
        after: 'Done',
        checkThis: false,
        status: 'accepted',
      },
    ],
  },
};

function answer(method: string, path: string): [number, unknown] {
  const p = path.replace(/^\/v1/, '').split('?')[0]!;
  if (method !== 'GET') return [200, {}];
  const routes: [RegExp, unknown][] = [
    // Meeting notes (rev 11).
    [/^\/meetings\/items$/, { meetings: [meetingAiOff ? aiOffMeeting() : meeting] }],
    [
      /^\/meetings\/[^/]+\/[^/]+$/,
      meetingAiOff
        ? {
            meeting: aiOffMeeting(),
            content: { notes: '', markers: [], speakers: {}, segments: [] },
          }
        : { meeting, content: meetingContent },
    ],
    [/^\/artists$/, { artists: [artist] }],
    [/^\/avatars$/, { artists: { [ARTIST]: CHLOE_PIC }, users: {} }],
    [/^\/artists\/[^/]+$/, artist],
    [/^\/artists\/[^/]+\/plan$/, plan],
    [/^\/artists\/[^/]+\/todos$/, { todos: [todo] }],
    [/^\/todos$/, { todos: [todo] }],
    [/^\/artists\/[^/]+\/files$/, { files: [file] }],
    // Folders (rev 10).
    [
      /^\/(library|artists\/[^/]+)\/folders$/,
      {
        root: { level: 'manage' },
        folders: [
          {
            folderId: 'fold000000001',
            name: 'Contracts',
            parentId: null,
            sharedWithMe: false,
            path: [],
            level: 'manage',
            customAccess: true,
            ownerId: 'u1',
            ownerName: 'Kyra Teichtahl',
            ownedByMe: true,
            createdAt: '2026-11-10T00:00:00Z',
            updatedAt: '2026-11-10T00:00:00Z',
          },
        ],
      },
    ],
    [
      /^\/(library|artists\/[^/]+)\/folders\/access$/,
      {
        item: { kind: 'folder', id: 'fold000000001', name: 'Contracts' },
        level: 'manage',
        canManage: true,
        legacySharing: false,
        inherit: true,
        entries: [
          { key: 'g:artists', label: 'All artists', level: 'none', source: { kind: 'here' } },
          { key: 'g:team', label: 'Blueprint team', level: 'edit', source: { kind: 'default' } },
        ],
        candidates: [
          { key: 'g:team', label: 'Blueprint team', detail: 'Group' },
          { key: 'p:u2', label: 'Sam Lee', detail: 'Events coordinator', sub: 'u2' },
        ],
      },
    ],
    [
      /^\/artists\/[^/]+\/files\/[^/]+$/,
      {
        ...file,
        uses: [
          {
            kind: 'asset',
            id: 'file000000001',
            title: 'Asset library',
            detail: 'Press shot',
            blocks: true,
          },
          { kind: 'chat', id: 'dm-art_chloepoli000', title: 'Chat with Blueprint', blocks: false },
        ],
        hiddenUses: 1,
        inUse: true,
        people: [
          {
            sub: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
            displayName: 'Kyra Teichtahl',
            jobTitle: 'Founder',
            isArtist: false,
          },
        ],
      },
    ],
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
    [
      /^\/access\/invitations$/,
      {
        invitations: [
          {
            artistId: 'art_newartist001',
            displayName: 'Mia Ray',
            email: 'mia@example.com',
            status: 'pending',
            invitedAt: now,
            lastSentAt: now,
            expiresAt: now,
            acceptedAt: null,
            revokedAt: null,
            resend: true,
            revoke: true,
          },
          {
            artistId: ARTIST,
            displayName: 'Chloe Poli',
            email: 'chloe@example.com',
            status: 'accepted',
            invitedAt: now,
            lastSentAt: now,
            expiresAt: now,
            acceptedAt: now,
            revokedAt: null,
            resend: false,
            revoke: false,
          },
        ],
      },
    ],
    [/^\/review-queue$/, { submissions: [] }],
    [/^\/artists\/[^/]+\/submissions$/, { submissions: [] }],
    [/^\/gigs$/, { gigs: [] }],
    [
      /^\/artists\/[^/]+\/gigs$/,
      {
        gigs: [
          {
            gigId: 'gig000000001',
            artistId: ARTIST,
            title: 'Corner Hotel launch',
            date: '2026-12-05',
            startTime: '19:30',
            endTime: '23:00',
            venue: 'Corner Hotel',
            status: 'booked',
            deal: 'door-split',
            checklist: [{ id: 'c1', title: 'Confirm set list', done: false }],
            plannedBy: 'artist',
            shared: true,
            help: {
              text: 'Can you help with promo?',
              topics: ['promo'],
              askedAt: now,
              status: 'open',
            },
          },
        ],
      },
    ],
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

/**
 * Opens a workspace screen (rev 9): four tabs (Overview, Plan, Work, Files)
 * with a section switch under each; Assets is a Type filter in Library and
 * Chat is a side panel. Tab names may carry a count ("Work 2").
 */
async function openWorkspace(name: string) {
  const tab = (n: string) =>
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${n}( \\d+)?$`) }));
  const path: Record<string, string[]> = {
    Overview: ['Overview'],
    Stats: ['Overview', 'Stats'],
    Plan: ['Plan'],
    Stages: ['Plan', 'Stages'],
    Timeline: ['Plan', 'Timeline'],
    'To-do': ['Plan', 'To-dos'],
    Submissions: ['Work', 'Submissions'],
    Gigs: ['Work', 'Gigs'],
    Library: ['Files', 'Library'],
    Assets: ['Files', 'Library'],
    'Brand kit': ['Files', 'Brand kit'],
  };
  if (name === 'Chat') {
    fireEvent.click(document.querySelector('[aria-controls="ws-chat"]')!);
  } else {
    for (const n of path[name]!) {
      tab(n);
      await settle();
    }
    if (name === 'Assets') fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
  }
  await settle();
}

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
    await openWorkspace(tab);
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
    await click(/your account$/i);
    expect(screen.getByRole('menu', { name: 'Your account' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('artist phone: profile (from the account menu)', async () => {
    await phone();
    await click(/your account$/i);
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
    await click('Ask BMG');
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
    await openWorkspace(tab);
    expect(await violations()).toEqual([]);
  });

  it('BMG: plan stages edit one at a time, with Remove stage in the danger area (rev 13)', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    await openWorkspace('Stages');
    // No edit mode for the whole plan, and no third row of plan tabs.
    expect(screen.queryByRole('button', { name: 'Edit plan' })).toBeNull();
    expect(screen.getAllByRole('tablist', { name: 'Plan sections' })).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /^Stages/ }).getAttribute('aria-selected')).toBe('true');
    const edits = screen.getAllByRole('button', { name: 'Edit stage' });
    expect(edits.length).toBeGreaterThan(0);
    fireEvent.click(edits[0]!);
    await settle();
    expect(screen.getByRole('button', { name: 'Save stage' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Remove stage: Remove / })).toBeTruthy();
    // Only one part is open for editing at a time.
    expect(screen.queryByRole('button', { name: 'Edit stage' })).toBeNull();
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(screen.getAllByRole('button', { name: 'Edit stage' }).length).toBe(edits.length);
  });

  it('BMG: plan in edit mode (Markdown editors)', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    await openWorkspace('Plan');
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
    // The back link ("← Industry Mixer Night") names the event too.
    expect(screen.getByRole('button', { name: '← Industry Mixer Night' })).toBeTruthy();
    const card = screen
      .getAllByRole('button', { name: /Industry Mixer Night/ })
      .find((b) => !b.textContent?.startsWith('←'))!;
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
    // Rev 13: a record page has Edit and no Delete; Delete is on the edit screen.
    expect(screen.getByRole('button', { name: '← Venues' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    await click('Edit');
    expect(screen.getByRole('heading', { name: 'Edit venue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← The Toff in Town' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete The Toff in Town' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('artist phone: a document’s detail page, then its Edit page (rev 8)', async () => {
    await phone();
    const lib = screen.queryAllByRole('button', { name: /^Library/ });
    fireEvent.click(lib[lib.length - 1]!);
    await settle();
    await click(/^Press shot/);
    expect(screen.getByRole('heading', { name: 'Document' })).toBeTruthy();
    expect(screen.getByText('Kyra Teichtahl', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Version history' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Where it’s used' })).toBeTruthy();
    expect(screen.getByText('+ 1 place you don’t have access to')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore version 1' })).toBeTruthy();
    expect(await violations()).toEqual([]);
    await click('Edit');
    expect(screen.getByRole('heading', { name: 'Edit document' })).toBeTruthy();
    // Used in the asset library, so it can't be deleted yet (rev 8).
    expect(
      (screen.getByRole('button', { name: /^Delete Press shot/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/used in 1 place/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Who can edit it' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Upload a new version' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('BMG: workspace Library opens a document page', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    await openWorkspace('Library');
    await click('Press shot');
    expect(screen.getByRole('heading', { name: 'Document' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('BMG: asset details open', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    await openWorkspace('Assets');
    expect(screen.getByRole('complementary', { name: 'Asset details' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });
});

describe('WCAG 2.2 AA (axe-core): folders (rev 10)', () => {
  it('BMG: the library shows folders, and a folder’s details, Access panel and edit screen', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Document library/ })[0]!);
    await settle();
    expect(screen.getByRole('navigation', { name: 'Folder path' })).toBeTruthy();
    expect(screen.getAllByText('Contracts').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /New folder/ })).toBeTruthy();
    expect(await violations()).toEqual([]);
    // Rev 13: no ⋯ on folder rows. Open the folder, then Folder details.
    expect(screen.queryByRole('button', { name: 'More for Contracts' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /^Contracts/ }).at(-1)!);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Folder details' }));
    expect(screen.getByRole('heading', { name: 'Folder' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Contracts' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    await settle();
    expect(screen.getByRole('dialog', { name: /Access · Contracts/ })).toBeTruthy();
    expect(screen.getByText('Set here')).toBeTruthy();
    expect(screen.getByLabelText('Access for All artists')).toBeTruthy();
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

describe('profile pictures', () => {
  it("shows an artist's profile picture instead of initials wherever they appear", async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    // Sidebar and Studio HQ show Chloe's picture once it's fetched.
    expect(document.querySelectorAll(`img.av[src="${CHLOE_PIC}"]`).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    // Her workspace header too, with no "CP" initials left anywhere.
    const header = document.querySelector('header.page-head')!;
    expect(header.querySelector(`img.av[src="${CHLOE_PIC}"]`)).toBeTruthy();
    expect([...document.querySelectorAll('span.av')].some((e) => e.textContent === 'CP')).toBe(
      false,
    );
    expect(await violations()).toEqual([]);
  });
});

describe('WCAG 2.2 AA (axe-core): phone layouts (tables as row cards)', () => {
  // Read in beforeAll: the file's own beforeAll sets matchMedia after this block is defined.
  let desktop: typeof window.matchMedia;
  beforeAll(() => {
    desktop = window.matchMedia;
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
    await openWorkspace('To-do');
    expect(screen.getAllByRole('list', { name: 'To-dos' }).length).toBeGreaterThan(0);
    expect(await violations()).toEqual([]);
  });

  it('BMG phone: a to-do opens its own panel, with Mark done and Edit details (rev 13)', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    await openWorkspace('To-do');
    // No tick on the row: Mark done is on the to-do.
    expect(screen.queryByRole('checkbox', { name: /Mark "Book rehearsal" done/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open "Book rehearsal"/ }));
    await settle();
    expect(screen.getByRole('dialog', { name: 'To-do' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeTruthy();
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    await settle();
    expect(screen.getByRole('dialog', { name: 'Edit to-do' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('BMG phone: adding a gig is its own page, not a form above the list', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    await openWorkspace('Gigs');
    expect(screen.getByRole('heading', { name: 'All gigs' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Add a gig for/ }));
    await settle();
    // The list and its filters are gone; the page has its own way back.
    expect(screen.queryByRole('heading', { name: 'All gigs' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filter gigs' })).toBeNull();
    expect(screen.getByRole('button', { name: '← Gigs' })).toBeTruthy();
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '← Gigs' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'All gigs' })).toBeTruthy();
  });

  it('BMG: a gig opens its work page, and Edit details opens the edit screen (rev 13)', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    await openWorkspace('Gigs');
    expect(screen.queryByRole('button', { name: /^Edit Corner/ })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /Corner Hotel launch/ })[0]!);
    await settle();
    expect(screen.getByRole('heading', { name: 'Gig' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Checklist/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tickets, takings and profit' })).toBeTruthy();
    expect(screen.getByText(/Help request/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Gigs' })).toBeTruthy();
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Edit gig' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Corner Hotel launch' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('artist phone: Plan a gig is its own page with a way back', async () => {
    render(<Home {...props('artist')} />);
    await settle();
    const tabs = screen.getAllByRole('button', { name: /^Gigs/ });
    fireEvent.click(tabs[tabs.length - 1]!);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Plan a gig' }));
    await settle();
    expect(screen.queryByRole('group', { name: 'Show gigs' })).toBeNull();
    expect(screen.getByRole('button', { name: '← My gigs' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('artist phone: to-dos are cards and edit opens in a panel', async () => {
    render(<Home {...props('artist')} />);
    await settle();
    const tabs = screen.getAllByRole('button', { name: /^To-do/ });
    fireEvent.click(tabs[tabs.length - 1]!);
    await settle();
    const list = screen.getByRole('list', { name: 'From Blueprint' });
    expect(list.querySelectorAll('li').length).toBe(1);
    expect(screen.queryByRole('dialog', { name: 'To-do' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open "Book rehearsal"/ }));
    await settle();
    expect(screen.getByRole('dialog', { name: 'To-do' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    await settle();
    const panel = screen.getByRole('dialog', { name: 'Edit to-do' });
    expect(panel.querySelector('input[value="Book rehearsal"]')).toBeTruthy();
    expect(await violations()).toEqual([]);
    // Back from editing goes to the to-do, then Back again to the list.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await settle();
    expect(screen.getByRole('dialog', { name: 'To-do' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await settle();
    expect(screen.queryByRole('dialog', { name: 'To-do' })).toBeNull();
  });
});

describe('WCAG 2.2 AA (axe-core): meetings (rev 11)', () => {
  async function openMeetings() {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Meetings/ })[0]!);
    await settle();
  }

  it('BMG: the meetings list', async () => {
    await openMeetings();
    expect(screen.getByText('Meeting with Chloe Poli')).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('BMG: a new meeting asks for everyone’s agreement before recording', async () => {
    await openMeetings();
    fireEvent.click(screen.getByRole('button', { name: /New meeting/ }));
    await settle();
    const start = screen.getByRole('button', { name: 'Start recording' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(await violations()).toEqual([]);
  });

  it.each(['Summary', 'Actions', 'Transcript', 'Plan update', 'Details'])(
    'BMG: a meeting’s %s',
    async (section) => {
      await openMeetings();
      fireEvent.click(screen.getAllByRole('button', { name: 'Meeting with Chloe Poli' })[0]!);
      await settle();
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${section}`) }));
      await settle();
      expect(await violations()).toEqual([]);
    },
  );

  it('BMG: Invite artist lists invitations, and one opens with Resend and Revoke', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Invite artist/ })[0]!);
    await settle();
    expect(screen.getByText('Mia Ray')).toBeTruthy();
    // "Waiting" hides accepted ones; "All" shows them.
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getAllByText('Accepted').length).toBeGreaterThan(0);
    expect(await violations()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /Open the invitation for Mia Ray/ }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Invitation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resend invitation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Revoke Mia Ray/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Invitations' })).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('BMG: a meeting’s Edit details has the title, sharing and the danger area (rev 13)', async () => {
    await openMeetings();
    fireEvent.click(screen.getAllByRole('button', { name: 'Meeting with Chloe Poli' })[0]!);
    await settle();
    expect(screen.getByRole('button', { name: '← Meetings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Edit details/ }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Edit meeting' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Meeting with Chloe Poli' })).toBeTruthy();
    expect(screen.getByLabelText('Title')).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('BMG: a meeting with AI off greys out Transcript and disables Transcribe', async () => {
    meetingAiOff = true;
    try {
      await openMeetings();
      expect(screen.getByText('Audio only (AI off)')).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: 'Meeting with Chloe Poli' })[0]!);
      await settle();
      const tab = screen.getByRole('tab', { name: /^Transcript/ });
      expect(tab.getAttribute('aria-disabled')).toBe('true');
      expect(
        (screen.getByRole('button', { name: 'Transcribe now' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(await violations()).toEqual([]);
    } finally {
      meetingAiOff = false;
    }
  });

  it('BMG: the workspace offers Record meeting and the plan review', async () => {
    render(<Home {...props('bmg-admin')} />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Chloe Poli/ })[0]!);
    await settle();
    expect(screen.getAllByRole('button', { name: /Record meeting/ }).length).toBeGreaterThan(0);
    await openWorkspace('Plan');
    expect(screen.getByText(/suggested changes? from/)).toBeTruthy();
    expect(await violations()).toEqual([]);
  });
});
