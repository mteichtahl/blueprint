import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  calendarEventBody,
  calendarEventId,
  challengeOf,
  CONNECTORS,
  connectorFor,
  connectorsFor,
  followerSeries,
  latestOf,
  ManualStatsBody,
  rangeParam,
  SettingsBody,
  sourceName,
  websiteWeek,
  type Snapshot,
} from '../src/connectors/catalog.ts';
import { humanitixIdOf } from '../src/connectors/sync.ts';
import {
  exchangeCode,
  humanitixTicketsSold,
  pullStats,
  refreshTokens,
  setFetch,
  VendorError,
} from '../src/connectors/vendors.ts';
import { plan, type Recipient } from '../src/notifications/model.ts';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => setFetch((...a) => fetch(...a)));

describe('catalog', () => {
  it('matches the design: Blueprint connectors and artist connectors', () => {
    expect(connectorsFor('bmg').map((c) => c.label)).toEqual([
      'Squarespace',
      'Humanitix',
      'Mailchimp',
      'Google Workspace',
      'Meta Business Suite',
      'TikTok',
      'LinkedIn',
    ]);
    expect(connectorsFor('artist').map((c) => c.id)).toEqual([
      'humanitix',
      'meta',
      'tiktok',
      'youtube',
      'gcal',
      'spotify',
    ]);
  });

  it('refuses a connector for the wrong owner', () => {
    expect(connectorFor('artist', 'linkedin')).toBeUndefined();
    expect(connectorFor('bmg', 'spotify')).toBeUndefined();
    expect(connectorFor('bmg', '__proto__')).toBeUndefined();
    expect(connectorFor('artist', 'meta')?.id).toBe('meta');
  });

  it('only allows 30, 60 or 90 day ranges', () => {
    expect(rangeParam('60')).toBe(60);
    expect(rangeParam('7')).toBe(30);
    expect(rangeParam(undefined)).toBe(30);
  });
});

describe('sign-in links', () => {
  const opts = {
    clientId: 'cid',
    redirectUri: 'https://app.example/connectors/callback',
    state: 's'.repeat(43),
  };

  it('asks Google for offline access with PKCE', () => {
    const u = new URL(authorizeUrl(CONNECTORS.website, { ...opts, verifier: 'v'.repeat(64) }));
    expect(u.host).toBe('accounts.google.com');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/analytics.readonly');
    expect(u.searchParams.get('code_challenge')).toBe(challengeOf('v'.repeat(64)));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('uses comma scopes for Meta and client_key for TikTok', () => {
    const m = new URL(authorizeUrl(CONNECTORS.meta, opts));
    expect(m.pathname).toBe('/v26.0/dialog/oauth');
    expect(m.searchParams.get('scope')).toContain('instagram_basic,');
    const t = new URL(authorizeUrl(CONNECTORS.tiktok, opts));
    expect(t.searchParams.get('client_key')).toBe('cid');
    expect(t.searchParams.get('scope')).toBe('user.info.basic user.info.stats');
  });

  it('has no sign-in link for API-key or manual connectors', () => {
    expect(() => authorizeUrl(CONNECTORS.humanitix, opts)).toThrow();
    expect(() => authorizeUrl(CONNECTORS.spotify, opts)).toThrow();
  });
});

describe('request bodies', () => {
  it('needs at least one number for hand-entered stats, and a real date', () => {
    expect(
      ManualStatsBody.safeParse({ source: 'spotify', date: '2026-11-09', listeners: 2310 }).success,
    ).toBe(true);
    expect(ManualStatsBody.safeParse({ source: 'spotify', date: '2026-11-09' }).success).toBe(
      false,
    );
    expect(
      ManualStatsBody.safeParse({ source: 'website', date: '2026-11-09', followers: 1 }).success,
    ).toBe(false);
    expect(
      ManualStatsBody.safeParse({ source: 'tiktok', date: '9/11/26', followers: 1 }).success,
    ).toBe(false);
  });

  it('rejects unknown settings', () => {
    expect(SettingsBody.safeParse({ ga4PropertyId: '123456' }).success).toBe(true);
    expect(SettingsBody.safeParse({ ga4PropertyId: 'abc' }).success).toBe(false);
    expect(SettingsBody.safeParse({ token: 'x' }).success).toBe(false);
  });
});

describe('insights', () => {
  const s = (date: string, source: Snapshot['source'], followers: number): Snapshot => ({
    date,
    source,
    followers,
  });

  it('carries the last known value forward and sums platforms', () => {
    const snaps = [
      s('2026-10-01', 'instagram', 400),
      s('2026-11-07', 'instagram', 410),
      s('2026-11-08', 'tiktok', 180),
      s('2026-11-09', 'instagram', 412),
      { date: '2026-11-09', source: 'spotify' as const, listeners: 2310 },
    ];
    const { series, split } = followerSeries(snaps, '2026-11-09', 3);
    expect(series.map((p) => p.followers)).toEqual([410, 590, 592]);
    expect(split).toEqual([
      { source: 'instagram', followers: 412 },
      { source: 'tiktok', followers: 180 },
    ]);
    expect(latestOf(snaps, 'spotify', 'listeners')).toBe(2310);
  });

  it('starts from earlier snapshots outside the window', () => {
    const { series } = followerSeries([s('2026-09-01', 'linkedin', 90)], '2026-11-09', 30);
    expect(series).toHaveLength(30);
    expect(series.every((p) => p.followers === 90)).toBe(true);
  });

  it('totals the website week and compares it with the week before', () => {
    const snaps: Snapshot[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.UTC(2026, 10, 9 - i)).toISOString().slice(0, 10);
      snaps.push({
        date: d,
        source: 'website',
        visits: i < 7 ? 120 : 100,
        users: 80,
        pageViews: 200,
      });
    }
    const w = websiteWeek(snaps, '2026-11-09');
    expect(w.visits).toBe(840);
    expect(w.users).toBe(560);
    expect(w.deltaPct).toBe(20);
    expect(w.daily).toHaveLength(7);
    expect(w.daily.at(-1)?.date).toBe('2026-11-09');
  });

  it('names traffic sources', () => {
    expect(sourceName('l.instagram.com')).toBe('Instagram');
    expect(sourceName('(direct)')).toBe('Direct');
    expect(sourceName('example.org')).toBe('Other');
  });
});

describe('calendar', () => {
  it('makes stable ids Google accepts (0-9, a-v)', () => {
    const id = calendarEventId('gig', 'mabcdefgh0123456789');
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(id).toBe(calendarEventId('gig', 'mabcdefgh0123456789'));
    expect(id).not.toBe(calendarEventId('event', 'mabcdefgh0123456789'));
  });

  it('writes timed gigs in Melbourne time and others as all-day', () => {
    const timed = calendarEventBody({
      title: 'Launch',
      date: '2026-12-11',
      time: '20:30',
      venue: 'Northcote',
    });
    expect(timed.start).toEqual({
      dateTime: '2026-12-11T20:30:00',
      timeZone: 'Australia/Melbourne',
    });
    expect(timed.end).toEqual({ dateTime: '2026-12-11T22:30:00', timeZone: 'Australia/Melbourne' });
    const late = calendarEventBody({ title: 'Late', date: '2026-12-11', time: '22:15' });
    expect(late.end).toEqual({ dateTime: '2026-12-11T23:59:00', timeZone: 'Australia/Melbourne' });
    const allDay = calendarEventBody({ title: 'Festival', date: '2026-12-31' });
    expect(allDay.end).toEqual({ date: '2027-01-01' });
  });
});

describe('humanitix', () => {
  it('reads an event id only from Humanitix links', () => {
    expect(humanitixIdOf('https://events.humanitix.com/x?eventId=abc123')).toBe('abc123');
    expect(humanitixIdOf('https://evil.example/?eventId=abc123')).toBeUndefined();
    expect(humanitixIdOf('not a url')).toBeUndefined();
  });

  it('counts tickets that are not cancelled, across pages', async () => {
    const page = (n: number, status = 'complete') => Array.from({ length: n }, () => ({ status }));
    const calls: string[] = [];
    setFetch(async (url) => {
      calls.push(String(url));
      return reply({
        tickets: calls.length === 1 ? [...page(98), ...page(2, 'cancelled')] : page(5),
      });
    });
    expect(await humanitixTicketsSold('key', 'ev1')).toBe(103);
    expect(calls).toHaveLength(2);
  });
});

describe('tokens', () => {
  const google = CONNECTORS.youtube;
  const creds = { clientId: 'id', clientSecret: 'secret' };

  it('leaves valid tokens alone', async () => {
    const t = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
    expect(await refreshTokens(google, creds, t)).toEqual({ tokens: t, changed: false });
  });

  it('refreshes Google tokens that are about to expire', async () => {
    setFetch(async () => reply({ access_token: 'new', expires_in: 3599 }));
    const r = await refreshTokens(google, creds, {
      accessToken: 'old',
      refreshToken: 'r',
      expiresAt: Date.now(),
    });
    expect(r.changed).toBe(true);
    expect(r.tokens.accessToken).toBe('new');
    expect(r.tokens.refreshToken).toBe('r');
  });

  it('asks for a new sign-in when LinkedIn expires', async () => {
    await expect(
      refreshTokens(CONNECTORS.linkedin, creds, { accessToken: 'a', expiresAt: Date.now() - 1 }),
    ).rejects.toMatchObject({ reauth: true });
  });

  it('treats a 401 from a vendor as needing a new sign-in, and keeps the body out of errors', async () => {
    setFetch(async () => reply({ error: 'secret detail' }, 401));
    const err = await pullStats(CONNECTORS.tiktok, { accessToken: 'a' }, {}, '2026-11-09').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).reauth).toBe(true);
    expect((err as Error).message).not.toContain('secret');
  });

  it('pulls TikTok followers', async () => {
    setFetch(async () =>
      reply({ data: { user: { follower_count: 188, display_name: 'Blueprint' } } }),
    );
    const r = await pullStats(CONNECTORS.tiktok, { accessToken: 'a' }, {}, '2026-11-09');
    expect(r.snapshots).toEqual([{ source: 'tiktok', followers: 188 }]);
  });

  it('refuses a Mailchimp API host that is not Mailchimp', async () => {
    setFetch(async (url) =>
      String(url).includes('/metadata')
        ? reply({ api_endpoint: 'https://attacker.example' })
        : reply({ access_token: 't' }),
    );
    await expect(
      exchangeCode(CONNECTORS.mailchimp, creds, 'code', 'https://app/connectors/callback'),
    ).rejects.toBeInstanceOf(VendorError);
  });
});

describe('notifications', () => {
  const people: Recipient[] = [
    { sub: 'admin', role: 'bmg-admin' },
    { sub: 'staff', role: 'bmg-staff', assignedArtistIds: [] },
    { sub: 'chloe', role: 'artist', artistId: 'art_aaaaaaaaaaaa' },
    { sub: 'sarun', role: 'artist', artistId: 'art_bbbbbbbbbbbb' },
  ] as Recipient[];

  it('reminds only the artist asked', () => {
    const p = plan({ type: 'connector.reminder', artistId: 'art_aaaaaaaaaaaa' }, people);
    expect(p?.to.map((r) => r.sub)).toEqual(['chloe']);
    expect(p?.draft.link).toBe('connectors');
  });

  it('tells admins when a Blueprint connector needs a new sign-in, and artists about their own', () => {
    const org = plan(
      { type: 'connector.needsReauth', connectorId: 'linkedin', label: 'LinkedIn' },
      people,
    );
    expect(org?.to.map((r) => r.sub)).toEqual(['admin']);
    const own = plan(
      {
        type: 'connector.needsReauth',
        connectorId: 'tiktok',
        label: 'TikTok',
        artistId: 'art_bbbbbbbbbbbb',
      },
      people,
    );
    expect(own?.to.map((r) => r.sub)).toEqual(['sarun']);
  });
});
