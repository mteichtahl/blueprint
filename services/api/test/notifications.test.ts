import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  emailText,
  inQuietHours,
  plan,
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
