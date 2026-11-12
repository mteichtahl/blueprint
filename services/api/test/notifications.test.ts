import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  emailText,
  inQuietHours,
  plan,
  planGroups,
  type Recipient,
} from '../src/notifications/model.ts';

const A = 'art_aaaaaaaaaaaa';
const B = 'art_bbbbbbbbbbbb';
const people: Recipient[] = [
  { sub: 'kyra', role: 'bmg-admin', email: 'k@x' },
  { sub: 'staffA', role: 'bmg-staff', assignedArtistIds: [A] },
  { sub: 'staffB', role: 'bmg-staff', assignedArtistIds: [B] },
  { sub: 'chloe', role: 'artist', artistId: A },
  { sub: 'sarun', role: 'artist', artistId: B },
];
const subs = (r?: { to: Recipient[] }) => r?.to.map((x) => x.sub).sort();

describe('who hears about what', () => {
  it('tells Blueprint (admins and the assigned staff) about a new submission', () => {
    expect(
      subs(plan({ type: 'submission.created', artistId: A, submissionId: 's' }, people)),
    ).toEqual(['kyra', 'staffA']);
  });
  it('tells the artist when Blueprint changes timing or gives feedback', () => {
    expect(
      subs(
        plan(
          {
            type: 'submission.updated',
            artistId: A,
            submissionId: 's',
            priority: 'high',
            neededBy: '2026-12-01',
          },
          people,
        ),
      ),
    ).toEqual(['chloe']);
    expect(
      subs(
        plan(
          { type: 'submission.feedbackGiven', artistId: B, submissionId: 's', todos: 2 },
          people,
        ),
      ),
    ).toEqual(['sarun']);
  });
  it('tells whoever asked for the review when it is complete', () => {
    const done = plan(
      {
        type: 'submission.completed',
        artistId: B,
        submissionId: 's',
        requesterSub: 'sarun',
        completedBySub: 'kyra',
        todos: 2,
        feedback: true,
      },
      people,
    )!;
    expect(subs(done)).toEqual(['sarun']);
    expect(done.draft.title).toBe('Your review is complete');
    expect(done.draft.body).toMatch(/2 new to-dos/);
    // No requester on record (older submissions): the artist is told.
    expect(
      subs(
        plan(
          {
            type: 'submission.completed',
            artistId: B,
            submissionId: 's',
            todos: 0,
            feedback: false,
          },
          people,
        ),
      ),
    ).toEqual(['sarun']);
  });

  it('never tells Blueprint about artist-to-artist messages, and never the sender', () => {
    const e = {
      type: 'message.created' as const,
      conversationId: 'aa-x',
      conversationType: 'artist-to-artist' as const,
      artistIds: [A, B],
      senderSub: 'chloe',
      senderName: 'Chloe',
    };
    expect(subs(plan(e, people))).toEqual(['sarun']);
  });
  it('tells the artist and Blueprint about a direct chat, minus the sender', () => {
    const e = {
      type: 'message.created' as const,
      conversationId: `dm-${A}`,
      conversationType: 'bmg-artist' as const,
      artistIds: [A],
      senderSub: 'chloe',
      senderName: 'Chloe',
    };
    expect(subs(plan(e, people))).toEqual(['kyra', 'staffA']);
  });
  it('skips members who muted the chat', () => {
    const e = {
      type: 'message.created' as const,
      conversationId: 'grp-x',
      conversationType: 'group' as const,
      artistIds: [A, B],
      senderSub: 'kyra',
      senderName: 'Blueprint',
      mutedMembers: [`ARTIST#${B}`],
    };
    expect(subs(plan(e, people))).toEqual(['chloe']);
    expect(subs(plan({ ...e, senderSub: 'chloe', mutedMembers: ['BMG'] }, people))).toEqual([
      'sarun',
    ]);
  });
  it('sends announcements to the listed artists only', () => {
    const d = plan(
      {
        type: 'message.created',
        conversationId: 'ann-xxxxxxxxxx',
        conversationType: 'announcement',
        artistIds: [A],
        senderSub: 'kyra',
        senderName: 'Kyra',
      },
      people,
    )!;
    expect(subs(d)).toEqual(['chloe']);
    expect(d.draft.title).toBe('Announcement from Kyra');
  });
  it('never puts message text in a notification', () => {
    const d = plan(
      {
        type: 'message.created',
        conversationId: `dm-${A}`,
        conversationType: 'bmg-artist',
        artistIds: [A],
        senderSub: 'kyra',
        senderName: 'Blueprint',
      },
      people,
    )!.draft;
    expect(d.body).toBe('Open the app to read it.');
    expect(d.throttleKey).toBe(`dm-${A}`);
  });
});

describe('quiet hours (Melbourne time)', () => {
  it('holds email overnight and sends during the day', () => {
    // 2026-11-09 12:30Z = 23:30 AEDT; 02:00Z = 13:00 AEDT
    expect(inQuietHours(DEFAULT_PREFERENCES, new Date('2026-11-09T12:30:00Z'))).toBe(true);
    expect(inQuietHours(DEFAULT_PREFERENCES, new Date('2026-11-09T02:00:00Z'))).toBe(false);
    expect(
      inQuietHours({ ...DEFAULT_PREFERENCES, quietHours: null }, new Date('2026-11-09T12:30:00Z')),
    ).toBe(false);
  });
});

describe('email', () => {
  it('escapes names in the HTML', () => {
    const m = emailText(
      { kind: 'review', title: 'A <b>', body: 'x & y', link: 'review' },
      'https://app',
    );
    expect(m.html).toContain('A &lt;b&gt;');
    expect(m.html).toContain('x &amp; y');
    expect(m.text).toContain('https://app');
  });
});

import { PushSubscriptionBody, pushPayload, pushSk } from '../src/notifications/model.ts';

describe('web push', () => {
  it('accepts browser subscriptions over HTTPS only', () => {
    const ok = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'BOrn1234567890', auth: 'abcdefgh' },
    };
    expect(PushSubscriptionBody.safeParse(ok).success).toBe(true);
    expect(PushSubscriptionBody.safeParse({ ...ok, endpoint: 'http://x.example/p' }).success).toBe(
      false,
    );
  });
  it('keys devices by a hash of the endpoint', () => {
    expect(pushSk('https://a')).toMatch(/^PUSH#[0-9a-f]{40}$/);
    expect(pushSk('https://a')).not.toBe(pushSk('https://b'));
  });
  it('carries only the title, body and link', () => {
    const p = JSON.parse(
      pushPayload({
        kind: 'message',
        title: 'New message from Kyra',
        body: 'Open the app to read it.',
        link: 'chat:x',
        throttleKey: 'x',
      }),
    );
    expect(Object.keys(p).sort()).toEqual(['body', 'link', 'tag', 'title']);
  });
});

describe('gig help', () => {
  it('tells Blueprint what the artist needs a hand with', () => {
    const p = plan(
      {
        type: 'gig.helpRequested',
        artistId: 'art_aaaaaaaaaaaa',
        gigId: 'g1',
        title: 'Headline set',
        topics: ['pitch', 'budget'],
        artistName: 'Chloe Poli',
      },
      [
        { sub: 'a', role: 'bmg-admin' },
        { sub: 'c', role: 'artist', artistId: 'art_aaaaaaaaaaaa' },
      ] as never,
    );
    expect(p?.to.map((r) => r.sub)).toEqual(['a']);
    expect(p?.draft.body).toBe('“Headline set”: help with the pitch email, the budget.');
  });
});

describe('to-do threads (rev 7)', () => {
  const ev = (over: Record<string, unknown>) =>
    ({
      type: 'todo.commented',
      artistId: A,
      todoId: 't1',
      title: 'Send the EPK',
      authorSub: 'x',
      authorName: 'Someone',
      byRole: 'artist',
      ...over,
    }) as never;
  const team = [
    { sub: 'admin', role: 'bmg-admin' },
    { sub: 'staffA', role: 'bmg-staff', assignedArtistIds: [A] },
    { sub: 'staffB', role: 'bmg-staff', assignedArtistIds: [B] },
    { sub: 'artA', role: 'artist', artistId: A },
    { sub: 'artB', role: 'artist', artistId: B },
  ] as never;

  it('tells Blueprint (on this artist) when the artist comments', () => {
    const p = plan(ev({ authorSub: 'artA', byRole: 'artist' }), team);
    expect(subs(p)).toEqual(['admin', 'staffA']);
    expect(p?.draft).toMatchObject({
      kind: 'todo',
      link: 'todos',
      title: 'Someone commented on a to-do',
    });
  });

  it('tells the artist and the rest of the team when Blueprint comments', () => {
    expect(subs(plan(ev({ authorSub: 'staffA', byRole: 'bmg-staff' }), team))).toEqual([
      'admin',
      'artA',
    ]);
  });

  it('keeps BMG-only to-do threads away from the artist', () => {
    expect(
      subs(plan(ev({ authorSub: 'admin', byRole: 'bmg-admin', bmgOnly: true }), team)),
    ).toEqual(['staffA']);
  });
});

describe('to-dos shared from a meeting (rev 11 change)', () => {
  const team = [
    { sub: 'admin', role: 'bmg-admin' },
    { sub: 'staffA', role: 'bmg-staff', assignedArtistIds: [A] },
    { sub: 'artA', role: 'artist', artistId: A },
    { sub: 'artB', role: 'artist', artistId: B },
  ] as never;
  const ev = (titles: string[], count = titles.length) =>
    ({ type: 'todo.shared', artistId: A, count, titles, bySub: 'staffA' }) as never;

  it('tells only that artist, once, naming the to-dos', () => {
    const p = plan(ev(['Send the stems', 'Book the photographer']), team);
    expect(subs(p)).toEqual(['artA']);
    expect(p?.draft).toEqual({
      kind: 'todo',
      title: 'Blueprint added 2 to-dos for you',
      body: '“Send the stems”, “Book the photographer”.',
      link: 'todos',
    });
  });

  it('keeps it short when there are many', () => {
    const p = plan(ev(['A', 'B', 'C', 'D', 'E'], 7), team);
    expect(p?.draft.body).toBe('“A”, “B”, “C” and 4 more.');
    expect(plan(ev(['Only one']), team)?.draft.title).toBe('Blueprint added a to-do for you');
  });
});

describe('documents (rev 8)', () => {
  it('tells the owner and chosen editors about a new version, never the uploader', () => {
    const [g] = planGroups(
      {
        type: 'file.versionAdded',
        fileId: 'f1',
        scope: 'artist',
        artistId: A,
        name: 'Rider',
        v: 3,
        uploadedBy: 'staffA',
        ownerSub: 'chloe',
        editorSubs: ['staffA', 'kyra'],
      },
      people,
    );
    expect(subs(g)).toEqual(['chloe', 'kyra']);
    expect(g!.draft).toMatchObject({
      kind: 'file',
      title: 'New version of “Rider”',
      link: `doc:${A}/f1`,
    });
  });

  it('words a brought-back version as such', () => {
    const [g] = planGroups(
      {
        type: 'file.versionAdded',
        fileId: 'f1',
        scope: 'library',
        name: 'Rider',
        v: 4,
        uploadedBy: 'kyra',
        ownerSub: 'staffA',
        editorSubs: [],
        restoredFrom: 2,
      },
      people,
    );
    expect(subs(g)).toEqual(['staffA']);
    expect(g!.draft.body).toBe('Version 2 was brought back as version 4.');
    expect(g!.draft.link).toBe('doc:library/f1');
  });

  it('tells new editors and a new owner, each in their own words', () => {
    const groups = planGroups(
      {
        type: 'file.editorsAdded',
        fileId: 'f1',
        scope: 'library',
        name: 'Rider',
        editorSubs: ['staffA', 'staffB'],
        ownerSub: 'kyra',
        bySub: 'staffB',
        byName: 'Sam',
      },
      people,
    );
    expect(groups.map((g) => [subs(g), g.draft.title])).toEqual([
      [['kyra'], 'Sam handed you “Rider”'],
      [['staffA'], 'Sam gave you edit access to “Rider”'],
    ]);
  });
});

describe('account security', () => {
  it('tells only that person when a recovery code was used, and how many are left', () => {
    const p = plan({ type: 'account.recovered', sub: 'chloe', left: 0 }, people);
    expect(subs(p)).toEqual(['chloe']);
    expect(p!.draft).toMatchObject({
      kind: 'account',
      title: 'Your two-step verification was reset',
      link: 'profile',
    });
    expect(p!.draft.body).toContain('no recovery codes left');
  });
});
