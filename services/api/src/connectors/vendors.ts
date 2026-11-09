import {
  calendarEventBody,
  calendarEventId,
  daysBefore,
  LINKEDIN_VERSION,
  META_GRAPH,
  sourceName,
  type ConnectorDef,
  type Settings,
  type Snapshot,
} from './catalog.ts';

/**
 * Calls to each vendor's API (endpoints from the O1 vendor check). Nothing
 * here touches storage: callers seal and save what comes back.
 */

export interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

export interface MetaPage {
  id: string;
  name: string;
  token: string;
  igId?: string;
  igUsername?: string;
}

/** Everything secret about a connection; sealed before it is stored. */
export interface Tokens {
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  refreshExpiresAt?: number;
  apiKey?: string;
  /** Mailchimp API host, from its metadata endpoint. */
  apiHost?: string;
  pages?: MetaPage[];
}

export interface Connected {
  tokens: Tokens;
  account?: string;
  settings?: Settings;
  choices?: { id: string; label: string }[];
}

export class VendorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  /** The vendor no longer accepts the credentials: someone has to sign in again. */
  get reauth() {
    return this.status === 401 || this.status === 403;
  }
}

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
/** Tests swap the network. */
export function setFetch(f: Fetch) {
  fetcher = f;
}

async function http<T = Record<string, unknown>>(
  url: string,
  init: RequestInit & { form?: Record<string, string> } = {},
): Promise<T> {
  const { form, ...rest } = init;
  const res = await fetcher(url, {
    ...rest,
    ...(form
      ? {
          method: rest.method ?? 'POST',
          body: new URLSearchParams(form).toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...rest.headers },
        }
      : {}),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    // Vendor error bodies can echo request data, so only the status is kept.
    throw new VendorError(res.status, `${new URL(url).host} answered ${res.status}`);
  }
  return body as T;
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({
  headers: { authorization: `Bearer ${token}`, ...extra },
});
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
};
const inSeconds = (s: unknown) => (num(s) ? Date.now() + num(s)! * 1000 : undefined);

// ── Connect: code → tokens ────────────────────────────────────────────────
export async function exchangeCode(
  def: ConnectorDef,
  creds: ClientCreds,
  code: string,
  redirectUri: string,
  verifier?: string,
): Promise<Connected> {
  switch (def.provider) {
    case 'google': {
      const t = await http('https://oauth2.googleapis.com/token', {
        form: {
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          ...(verifier ? { code_verifier: verifier } : {}),
        },
      });
      const tokens: Tokens = {
        accessToken: String(t.access_token),
        ...(t.refresh_token ? { refreshToken: String(t.refresh_token) } : {}),
        ...(inSeconds(t.expires_in) ? { expiresAt: inSeconds(t.expires_in)! } : {}),
      };
      if (def.id === 'website') return { tokens, ...(await ga4Choices(tokens.accessToken!)) };
      if (def.id === 'youtube') {
        const c = await http<{ items?: { snippet?: { title?: string } }[] }>(
          'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
          bearer(tokens.accessToken!),
        );
        const title = c.items?.[0]?.snippet?.title;
        return { tokens, ...(title ? { account: title } : {}) };
      }
      return { tokens, account: 'Blueprint calendar' };
    }
    case 'meta': {
      const short = await http(
        `${META_GRAPH}/oauth/access_token?${new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri,
          code,
        })}`,
      );
      // A long-lived user token; Page tokens fetched with it do not expire.
      const long = await http(
        `${META_GRAPH}/oauth/access_token?${new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          fb_exchange_token: String(short.access_token),
        })}`,
      );
      const pages = await http<{
        data?: {
          id: string;
          name: string;
          access_token: string;
          instagram_business_account?: { id: string; username?: string };
        }[];
      }>(
        `${META_GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=50`,
        bearer(String(long.access_token)),
      );
      const list: MetaPage[] = (pages.data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        token: p.access_token,
        ...(p.instagram_business_account
          ? {
              igId: p.instagram_business_account.id,
              ...(p.instagram_business_account.username
                ? { igUsername: p.instagram_business_account.username }
                : {}),
            }
          : {}),
      }));
      if (!list.length) throw new VendorError(400, 'No Facebook Page was shared with the app');
      const first = list.find((p) => p.igId) ?? list[0]!;
      return {
        tokens: {
          accessToken: String(long.access_token),
          ...(inSeconds(long.expires_in) ? { expiresAt: inSeconds(long.expires_in)! } : {}),
          pages: list,
        },
        account: first.name,
        settings: { pageId: first.id },
        choices: list.map((p) => ({
          id: p.id,
          label: p.igUsername ? `${p.name} · @${p.igUsername}` : p.name,
        })),
      };
    }
    case 'mailchimp': {
      const t = await http('https://login.mailchimp.com/oauth2/token', {
        form: {
          grant_type: 'authorization_code',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri,
          code,
        },
      });
      const accessToken = String(t.access_token);
      const meta = await http<{ api_endpoint?: string; accountname?: string }>(
        'https://login.mailchimp.com/oauth2/metadata',
        { headers: { authorization: `OAuth ${accessToken}` } },
      );
      const apiHost = meta.api_endpoint ?? '';
      if (!/^https:\/\/[a-z0-9]+\.api\.mailchimp\.com$/.test(apiHost)) {
        throw new VendorError(502, 'Mailchimp returned an unexpected API host');
      }
      const lists = await http<{ lists?: { id: string; name: string }[] }>(
        `${apiHost}/3.0/lists?count=50&fields=lists.id,lists.name`,
        bearer(accessToken),
      );
      const choices = (lists.lists ?? []).map((l) => ({ id: l.id, label: l.name }));
      return {
        tokens: { accessToken, apiHost },
        ...(meta.accountname ? { account: meta.accountname } : {}),
        ...(choices[0] ? { settings: { listId: choices[0].id } } : {}),
        choices,
      };
    }
    case 'tiktok': {
      const t = await http('https://open.tiktokapis.com/v2/oauth/token/', {
        form: {
          client_key: creds.clientId,
          client_secret: creds.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        },
      });
      const tokens: Tokens = {
        accessToken: String(t.access_token),
        refreshToken: String(t.refresh_token),
        ...(inSeconds(t.expires_in) ? { expiresAt: inSeconds(t.expires_in)! } : {}),
        ...(inSeconds(t.refresh_expires_in)
          ? { refreshExpiresAt: inSeconds(t.refresh_expires_in)! }
          : {}),
      };
      const info = await tiktokInfo(tokens.accessToken!);
      return { tokens, ...(info.name ? { account: info.name } : {}) };
    }
    case 'linkedin': {
      const t = await http('https://www.linkedin.com/oauth/v2/accessToken', {
        form: {
          grant_type: 'authorization_code',
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: redirectUri,
        },
      });
      const accessToken = String(t.access_token);
      const acls = await http<{ elements?: { organization?: string }[] }>(
        'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED',
        bearer(accessToken, linkedinHeaders()),
      );
      const choices = (acls.elements ?? [])
        .map((e) => /urn:li:organization:(\d+)/.exec(e.organization ?? '')?.[1])
        .filter((id): id is string => !!id)
        .map((id) => ({ id, label: `Organisation ${id}` }));
      return {
        // No refresh on the Development tier: sign in again before day 60.
        tokens: {
          accessToken,
          ...(inSeconds(t.expires_in) ? { expiresAt: inSeconds(t.expires_in)! } : {}),
        },
        ...(choices[0] ? { settings: { organizationId: choices[0].id } } : {}),
        choices,
      };
    }
    default:
      throw new VendorError(400, `${def.label} does not use OAuth`);
  }
}

const linkedinHeaders = () => ({
  'LinkedIn-Version': LINKEDIN_VERSION,
  'X-Restli-Protocol-Version': '2.0.0',
});

async function ga4Choices(accessToken: string): Promise<Omit<Connected, 'tokens'>> {
  const res = await http<{
    accountSummaries?: {
      displayName?: string;
      propertySummaries?: { property?: string; displayName?: string }[];
    }[];
  }>(
    'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=50',
    bearer(accessToken),
  );
  const choices = (res.accountSummaries ?? []).flatMap((a) =>
    (a.propertySummaries ?? [])
      .map((p) => ({
        id: (p.property ?? '').replace('properties/', ''),
        label: `${p.displayName ?? 'Property'}${a.displayName ? ` · ${a.displayName}` : ''}`,
      }))
      .filter((c) => /^\d+$/.test(c.id)),
  );
  return {
    ...(choices[0]
      ? { account: choices[0].label, settings: { ga4PropertyId: choices[0].id } }
      : {}),
    choices,
  };
}

async function tiktokInfo(accessToken: string) {
  const res = await http<{
    data?: {
      user?: {
        display_name?: string;
        follower_count?: number;
        likes_count?: number;
        video_count?: number;
      };
    };
  }>(
    'https://open.tiktokapis.com/v2/user/info/?fields=display_name,follower_count,likes_count,video_count',
    bearer(accessToken),
  );
  const u = res.data?.user ?? {};
  return {
    name: u.display_name,
    followers: num(u.follower_count),
    likes: num(u.likes_count),
    videos: num(u.video_count),
  };
}

// ── Keep tokens fresh ───────────────────────────────────────────────────
const SKEW_MS = 5 * 60_000;

/**
 * Returns fresh tokens (unchanged if still valid). Throws a reauth VendorError
 * when only a new sign-in will do.
 */
export async function refreshTokens(
  def: ConnectorDef,
  creds: ClientCreds | undefined,
  t: Tokens,
): Promise<{ tokens: Tokens; changed: boolean }> {
  if (def.auth !== 'oauth' || !t.expiresAt || t.expiresAt - Date.now() > SKEW_MS) {
    return { tokens: t, changed: false };
  }
  if (!creds) throw new VendorError(401, 'The app is not registered with this service');
  switch (def.provider) {
    case 'google': {
      if (!t.refreshToken) throw new VendorError(401, 'Sign in again');
      const r = await http('https://oauth2.googleapis.com/token', {
        form: {
          grant_type: 'refresh_token',
          refresh_token: t.refreshToken,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        },
      });
      return {
        tokens: {
          ...t,
          accessToken: String(r.access_token),
          ...(inSeconds(r.expires_in) ? { expiresAt: inSeconds(r.expires_in)! } : {}),
        },
        changed: true,
      };
    }
    case 'tiktok': {
      if (!t.refreshToken || (t.refreshExpiresAt && t.refreshExpiresAt < Date.now())) {
        throw new VendorError(401, 'Sign in again');
      }
      const r = await http('https://open.tiktokapis.com/v2/oauth/token/', {
        form: {
          client_key: creds.clientId,
          client_secret: creds.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: t.refreshToken,
        },
      });
      return {
        tokens: {
          ...t,
          accessToken: String(r.access_token),
          refreshToken: String(r.refresh_token ?? t.refreshToken),
          ...(inSeconds(r.expires_in) ? { expiresAt: inSeconds(r.expires_in)! } : {}),
          ...(inSeconds(r.refresh_expires_in)
            ? { refreshExpiresAt: inSeconds(r.refresh_expires_in)! }
            : {}),
        },
        changed: true,
      };
    }
    case 'meta':
      // Page tokens keep working after the user token lapses.
      if (t.pages?.length) return { tokens: t, changed: false };
      throw new VendorError(401, 'Sign in again');
    default:
      // LinkedIn has no refresh on the Development tier; Mailchimp never expires.
      throw new VendorError(401, 'Sign in again');
  }
}

// ── Sync: tokens → snapshots ──────────────────────────────────────────────
export interface WebDetail {
  topPages: { page: string; visits: number }[];
  sources: { source: string; share: number }[];
}

export interface Pulled {
  snapshots: Omit<Snapshot, 'date'>[];
  web?: WebDetail;
  /** Extra daily rows with their own dates (GA4 gives a week at a time). */
  daily?: Snapshot[];
}

export async function pullStats(
  def: ConnectorDef,
  t: Tokens,
  settings: Settings,
  today: string,
): Promise<Pulled> {
  switch (def.id) {
    case 'website':
      if (!settings.ga4PropertyId) return { snapshots: [] };
      return ga4(t.accessToken!, settings.ga4PropertyId, today);
    case 'meta': {
      const page = t.pages?.find((p) => p.id === settings.pageId) ?? t.pages?.[0];
      if (!page) return { snapshots: [] };
      const out: Omit<Snapshot, 'date'>[] = [];
      const fb = await http(
        `${META_GRAPH}/${page.id}?fields=followers_count,fan_count`,
        bearer(page.token),
      );
      const fbFollowers = num(fb.followers_count) ?? num(fb.fan_count);
      if (fbFollowers !== undefined) out.push({ source: 'facebook', followers: fbFollowers });
      if (page.igId) {
        const ig = await http(
          `${META_GRAPH}/${page.igId}?fields=followers_count,media_count`,
          bearer(page.token),
        );
        const f = num(ig.followers_count);
        if (f !== undefined) out.push({ source: 'instagram', followers: f });
      }
      return { snapshots: out };
    }
    case 'tiktok': {
      const i = await tiktokInfo(t.accessToken!);
      return i.followers === undefined
        ? { snapshots: [] }
        : { snapshots: [{ source: 'tiktok', followers: i.followers }] };
    }
    case 'linkedin': {
      if (!settings.organizationId) return { snapshots: [] };
      const r = await http(
        `https://api.linkedin.com/rest/networkSizes/urn:li:organization:${settings.organizationId}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
        bearer(t.accessToken!, linkedinHeaders()),
      );
      const f = num(r.firstDegreeSize);
      return f === undefined
        ? { snapshots: [] }
        : { snapshots: [{ source: 'linkedin', followers: f }] };
    }
    case 'youtube': {
      const r = await http<{ items?: { statistics?: Record<string, string> }[] }>(
        'https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true',
        bearer(t.accessToken!),
      );
      const s = r.items?.[0]?.statistics ?? {};
      const f = num(s.subscriberCount);
      return f === undefined
        ? { snapshots: [] }
        : { snapshots: [{ source: 'youtube', followers: f }] };
    }
    case 'mailchimp': {
      if (!settings.listId || !t.apiHost) return { snapshots: [] };
      const r = await http<{ stats?: { member_count?: number } }>(
        `${t.apiHost}/3.0/lists/${settings.listId}?fields=stats.member_count`,
        bearer(t.accessToken!),
      );
      const n = num(r.stats?.member_count);
      return n === undefined
        ? { snapshots: [] }
        : { snapshots: [{ source: 'mailchimp', subscribers: n }] };
    }
    default:
      return { snapshots: [] };
  }
}

async function ga4(accessToken: string, propertyId: string, today: string): Promise<Pulled> {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  type Report = {
    rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  };
  const run = (body: unknown) =>
    http<Report>(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const [daily, pages, sources] = await Promise.all([
    run({
      dateRanges: [{ startDate: daysBefore(today, 13), endDate: today }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' }],
    }),
    run({
      dateRanges: [{ startDate: daysBefore(today, 6), endDate: today }],
      dimensions: [{ name: 'pageTitle' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 5,
    }),
    run({
      dateRanges: [{ startDate: daysBefore(today, 6), endDate: today }],
      dimensions: [{ name: 'sessionSource' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 25,
    }),
  ]);
  const rows: Snapshot[] = (daily.rows ?? []).flatMap((r) => {
    const raw = r.dimensionValues?.[0]?.value ?? '';
    if (!/^\d{8}$/.test(raw)) return [];
    const m = r.metricValues ?? [];
    return [
      {
        date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
        source: 'website' as const,
        visits: num(m[0]?.value) ?? 0,
        users: num(m[1]?.value) ?? 0,
        pageViews: num(m[2]?.value) ?? 0,
      },
    ];
  });
  const grouped = new Map<string, number>();
  let total = 0;
  for (const r of sources.rows ?? []) {
    const n = num(r.metricValues?.[0]?.value) ?? 0;
    const name = sourceName(r.dimensionValues?.[0]?.value ?? '');
    grouped.set(name, (grouped.get(name) ?? 0) + n);
    total += n;
  }
  return {
    snapshots: [],
    daily: rows,
    web: {
      topPages: (pages.rows ?? []).map((r) => ({
        page: (r.dimensionValues?.[0]?.value ?? '').slice(0, 80),
        visits: num(r.metricValues?.[0]?.value) ?? 0,
      })),
      sources: [...grouped.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([source, n]) => ({ source, share: total ? Math.round((n / total) * 100) : 0 })),
    },
  };
}

// ── Humanitix (API key) ─────────────────────────────────────────────────
const HUMANITIX = 'https://api.humanitix.com/v1';
const hx = (key: string) => ({ headers: { 'x-api-key': key } });

export interface HumanitixEvent {
  id: string;
  name: string;
  startDate?: string;
}

export async function humanitixEvents(apiKey: string): Promise<HumanitixEvent[]> {
  const out: HumanitixEvent[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await http<{ events?: Record<string, unknown>[] }>(
      `${HUMANITIX}/events?page=${page}`,
      hx(apiKey),
    );
    const list = r.events ?? [];
    for (const e of list) {
      const id = String(e._id ?? e.id ?? '');
      if (!id) continue;
      out.push({
        id,
        name: String(e.name ?? 'Event').slice(0, 200),
        ...(typeof e.startDate === 'string' ? { startDate: e.startDate } : {}),
      });
    }
    if (list.length < 100) break;
  }
  return out;
}

/** Tickets are the attendees; cancelled ones are not counted. */
export async function humanitixTicketsSold(apiKey: string, eventId: string): Promise<number> {
  let count = 0;
  for (let page = 1; page <= 20; page++) {
    const r = await http<{ tickets?: Record<string, unknown>[] }>(
      `${HUMANITIX}/events/${encodeURIComponent(eventId)}/tickets?page=${page}`,
      hx(apiKey),
    );
    const list = r.tickets ?? [];
    count += list.filter((t) => {
      const s = String(t.status ?? '').toLowerCase();
      return s !== 'cancelled' && s !== 'refunded' && t.cancelled !== true;
    }).length;
    if (list.length < 100) break;
  }
  return count;
}

// ── Google Calendar: gigs and events in a "Blueprint" calendar ─────────────
const GCAL = 'https://www.googleapis.com/calendar/v3';

export async function ensureCalendar(accessToken: string, calendarId?: string): Promise<string> {
  if (calendarId) {
    try {
      await http(`${GCAL}/calendars/${encodeURIComponent(calendarId)}`, bearer(accessToken));
      return calendarId;
    } catch (err) {
      if (!(err instanceof VendorError) || err.status !== 404) throw err;
    }
  }
  const c = await http(`${GCAL}/calendars`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ summary: 'Blueprint', timeZone: 'Australia/Melbourne' }),
  });
  return String(c.id);
}

export async function upsertCalendarEvent(
  accessToken: string,
  calendarId: string,
  kind: 'gig' | 'event',
  id: string,
  item: Parameters<typeof calendarEventBody>[0],
) {
  const eventId = calendarEventId(kind, id);
  const base = `${GCAL}/calendars/${encodeURIComponent(calendarId)}/events`;
  const body = JSON.stringify({ id: eventId, ...calendarEventBody(item) });
  const init = {
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body,
  };
  try {
    await http(`${base}/${eventId}`, { ...init, method: 'PUT' });
  } catch (err) {
    if (!(err instanceof VendorError) || err.status !== 404) throw err;
    await http(base, { ...init, method: 'POST' });
  }
}
