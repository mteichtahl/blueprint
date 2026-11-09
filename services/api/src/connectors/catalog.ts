import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Connectors (Phase 4): the outside services Blueprint and its artists link to
 * the app. Vendor facts come from the O1 vendor check (9 Nov 2026).
 */

/** OAuth apps BMG registers once; credentials live in Secrets Manager. */
export const PROVIDERS = ['google', 'meta', 'mailchimp', 'tiktok', 'linkedin'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type Owner = 'bmg' | 'artist';
export type AuthKind = 'oauth' | 'apiKey' | 'manual';

/** Where a connector's numbers land in the daily snapshots. */
export const SOURCES = [
  'website',
  'instagram',
  'facebook',
  'tiktok',
  'linkedin',
  'youtube',
  'mailchimp',
  'spotify',
  'humanitix',
] as const;
export type Source = (typeof SOURCES)[number];

/** Sources whose `followers` add up to an account's combined followers. */
export const FOLLOWER_SOURCES: readonly Source[] = [
  'instagram',
  'facebook',
  'tiktok',
  'linkedin',
  'youtube',
];

export const SOURCE_LABEL: Record<Source, string> = {
  website: 'Website',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  mailchimp: 'Mailchimp',
  spotify: 'Spotify',
  humanitix: 'Humanitix',
};

export interface ConnectorDef {
  id: string;
  label: string;
  /** What it brings in, as shown on the card. */
  blurb: string;
  owners: readonly Owner[];
  auth: AuthKind;
  provider?: Provider;
  /** OAuth scopes per owner. */
  scopes?: readonly string[];
  /** Snapshot sources it fills. */
  sources: readonly Source[];
}

const GOOGLE = (s: string) => `https://www.googleapis.com/auth/${s}`;

export const CONNECTORS = {
  website: {
    id: 'website',
    label: 'Squarespace',
    blurb: 'Website visits, visitors and top pages (through Google Analytics)',
    owners: ['bmg'],
    auth: 'oauth',
    provider: 'google',
    scopes: [GOOGLE('analytics.readonly')],
    sources: ['website'],
  },
  humanitix: {
    id: 'humanitix',
    label: 'Humanitix',
    blurb: 'Event and workshop tickets and sales',
    owners: ['bmg', 'artist'],
    auth: 'apiKey',
    sources: ['humanitix'],
  },
  mailchimp: {
    id: 'mailchimp',
    label: 'Mailchimp',
    blurb: 'Newsletter list and subscribers',
    owners: ['bmg'],
    auth: 'oauth',
    provider: 'mailchimp',
    sources: ['mailchimp'],
  },
  google: {
    id: 'google',
    label: 'Google Workspace',
    blurb: 'Gigs and events in a Blueprint calendar',
    owners: ['bmg'],
    auth: 'oauth',
    provider: 'google',
    scopes: [GOOGLE('calendar.app.created')],
    sources: [],
  },
  meta: {
    id: 'meta',
    label: 'Meta Business Suite',
    blurb: 'Instagram and Facebook followers and reach, in one sign-in',
    owners: ['bmg', 'artist'],
    auth: 'oauth',
    provider: 'meta',
    scopes: [
      'pages_show_list',
      'pages_read_engagement',
      'read_insights',
      'instagram_basic',
      'instagram_manage_insights',
      'business_management',
    ],
    sources: ['instagram', 'facebook'],
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    blurb: 'Followers, likes and videos',
    owners: ['bmg', 'artist'],
    auth: 'oauth',
    provider: 'tiktok',
    scopes: ['user.info.basic', 'user.info.stats'],
    sources: ['tiktok'],
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    blurb: 'Company page followers',
    owners: ['bmg'],
    auth: 'oauth',
    provider: 'linkedin',
    scopes: ['rw_organization_admin'],
    sources: ['linkedin'],
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    blurb: 'Subscribers and views',
    owners: ['artist'],
    auth: 'oauth',
    provider: 'google',
    scopes: [GOOGLE('youtube.readonly')],
    sources: ['youtube'],
  },
  gcal: {
    id: 'gcal',
    label: 'Google Calendar',
    blurb: 'Your gigs in a Blueprint calendar',
    owners: ['artist'],
    auth: 'oauth',
    provider: 'google',
    scopes: [GOOGLE('calendar.app.created')],
    sources: [],
  },
  spotify: {
    id: 'spotify',
    label: 'Spotify for Artists',
    blurb: 'Monthly listeners and followers, entered from Spotify for Artists',
    owners: ['artist'],
    auth: 'manual',
    sources: ['spotify'],
  },
} as const satisfies Record<string, ConnectorDef>;

export type ConnectorId = keyof typeof CONNECTORS;
export const CONNECTOR_IDS = Object.keys(CONNECTORS) as ConnectorId[];

export function connectorFor(owner: Owner, id: string | undefined): ConnectorDef | undefined {
  if (!id || !Object.hasOwn(CONNECTORS, id)) return undefined;
  const def = (CONNECTORS as Record<string, ConnectorDef>)[id]!;
  return def.owners.includes(owner) ? def : undefined;
}

export const connectorsFor = (owner: Owner): ConnectorDef[] =>
  (Object.values(CONNECTORS) as ConnectorDef[]).filter((c) => c.owners.includes(owner));

// ── Storage keys ─────────────────────────────────────────────────────────
export const ORG_CONNECTORS_PK = 'ORG#connectors';
export const connSk = (id: string) => `CONN#${id}`;
/** Snapshots: one partition per account (`bmg` or an artist id), one item per day and source. */
export const statsPk = (account: string) => `STATS#${account}`;
export const statsSk = (date: string, source: Source) => `${date}#${source}`;
export const WEB_DETAIL_SK = 'WEB#latest';
export const oauthStatePk = (state: string) => `OAUTH#${state}`;
export const OAUTH_STATE_TTL_SECONDS = 600;

export type ConnStatus = 'connected' | 'needs-reauth' | 'error';

/** What the API returns about a connection (never tokens). */
export interface ConnectionView {
  connectorId: string;
  status: ConnStatus;
  account?: string;
  /** Instagram / Facebook accounts found through Meta. */
  accounts?: { source: Source; label: string }[];
  settings?: Record<string, string>;
  choices?: { id: string; label: string }[];
  connectedAt: string;
  lastSyncAt?: string;
  lastError?: string;
  expiresAt?: string;
}

// ── Request bodies ──────────────────────────────────────────────────────
export const ApiKeyBody = z.object({ apiKey: z.string().trim().min(10).max(500) }).strict();
export const CallbackBody = z
  .object({
    code: z.string().min(1).max(2000),
    state: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/, 'Bad state'),
  })
  .strict();
export const SettingsBody = z
  .object({
    ga4PropertyId: z
      .string()
      .regex(/^\d{4,20}$/, 'A GA4 property id is digits only')
      .optional(),
    listId: z
      .string()
      .regex(/^[A-Za-z0-9]{4,40}$/)
      .optional(),
    pageId: z
      .string()
      .regex(/^\d{4,30}$/)
      .optional(),
    organizationId: z
      .string()
      .regex(/^\d{2,20}$/)
      .optional(),
  })
  .strict();
export type Settings = z.infer<typeof SettingsBody>;

const Count = z.number().int().min(0).max(1_000_000_000);
export const ManualStatsBody = z
  .object({
    source: z.enum(['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'spotify']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-09'),
    followers: Count.optional(),
    listeners: Count.optional(),
    streams: Count.optional(),
  })
  .strict()
  .refine((b) => (b.followers ?? b.listeners ?? b.streams) !== undefined, {
    message: 'Enter at least one number',
  });
export const LinkEventBody = z
  .object({ humanitixEventId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/) })
  .strict();

export const RANGES = [30, 60, 90] as const;
export function rangeParam(v: string | undefined): (typeof RANGES)[number] {
  const n = Number(v ?? 30);
  return (RANGES as readonly number[]).includes(n) ? (n as 30 | 60 | 90) : 30;
}

// ── OAuth helpers ─────────────────────────────────────────────────────────
export const META_GRAPH = 'https://graph.facebook.com/v26.0';
/** LinkedIn needs a YYYYMM version header; each version lasts about a year. */
export const LINKEDIN_VERSION = '202610';

export const newState = () => randomBytes(32).toString('base64url');
export const newVerifier = () => randomBytes(48).toString('base64url');
export const challengeOf = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

/** The vendor's sign-in page for a connector. Pure, so it is tested. */
export function authorizeUrl(
  def: ConnectorDef,
  opts: { clientId: string; redirectUri: string; state: string; verifier?: string },
): string {
  const scope = (def.scopes ?? []).join(def.provider === 'meta' ? ',' : ' ');
  const q = (base: string, params: Record<string, string>) =>
    `${base}?${new URLSearchParams(params).toString()}`;
  switch (def.provider) {
    case 'google':
      return q('https://accounts.google.com/o/oauth2/v2/auth', {
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope,
        state: opts.state,
        access_type: 'offline',
        // Always ask, so Google returns a refresh token on every connect.
        prompt: 'consent',
        include_granted_scopes: 'false',
        ...(opts.verifier
          ? { code_challenge: challengeOf(opts.verifier), code_challenge_method: 'S256' }
          : {}),
      });
    case 'meta':
      return q('https://www.facebook.com/v26.0/dialog/oauth', {
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope,
        state: opts.state,
      });
    case 'mailchimp':
      return q('https://login.mailchimp.com/oauth2/authorize', {
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        state: opts.state,
      });
    case 'tiktok':
      return q('https://www.tiktok.com/v2/auth/authorize/', {
        client_key: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope,
        state: opts.state,
      });
    case 'linkedin':
      return q('https://www.linkedin.com/oauth/v2/authorization', {
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: 'code',
        scope,
        state: opts.state,
      });
    default:
      throw new Error(`${def.id} does not sign in with OAuth`);
  }
}

/** Google event ids allow only 0-9 and a-v; hex fits and is stable per gig or event. */
export const calendarEventId = (kind: 'gig' | 'event', id: string) =>
  `bmg${kind === 'gig' ? '0' : '1'}${Buffer.from(id, 'utf8').toString('hex')}`;

export function calendarEventBody(item: {
  title: string;
  date: string;
  time?: string;
  venue?: string;
  notes?: string;
}) {
  const tz = 'Australia/Melbourne';
  const base = {
    summary: item.title,
    ...(item.venue ? { location: item.venue } : {}),
    ...(item.notes ? { description: item.notes.slice(0, 2000) } : {}),
  };
  if (item.time) {
    const [h, m] = item.time.split(':').map(Number) as [number, number];
    const endH = Math.min(h + 2, 23);
    const end = `${String(endH).padStart(2, '0')}:${String(endH === 23 ? 59 : m).padStart(2, '0')}`;
    return {
      ...base,
      start: { dateTime: `${item.date}T${item.time}:00`, timeZone: tz },
      end: { dateTime: `${item.date}T${end}:00`, timeZone: tz },
    };
  }
  const next = new Date(`${item.date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { ...base, start: { date: item.date }, end: { date: next.toISOString().slice(0, 10) } };
}

/** Friendlier names for GA4 session sources. */
export function sourceName(raw: string): string {
  const s = raw.toLowerCase();
  if (s === '(direct)') return 'Direct';
  if (s.includes('instagram')) return 'Instagram';
  if (s.includes('tiktok')) return 'TikTok';
  if (s.includes('facebook') || s === 'm.facebook.com' || s === 'l.facebook.com') return 'Facebook';
  if (s.includes('google')) return 'Google';
  if (s.includes('linkedin')) return 'LinkedIn';
  if (s.includes('mailchimp') || s.includes('newsletter')) return 'Newsletter';
  if (s.includes('humanitix')) return 'Humanitix';
  return 'Other';
}

// ── Insights (pure aggregation over snapshots) ─────────────────────────────
export interface Snapshot {
  date: string;
  source: Source;
  followers?: number;
  listeners?: number;
  streams?: number;
  visits?: number;
  users?: number;
  pageViews?: number;
  subscribers?: number;
  ticketsSold?: number;
  manual?: boolean;
}

export function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}
export function daysBefore(today: string, n: number) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return isoDay(d);
}

/** Latest value of a field per source, carried forward across days with no snapshot. */
export function followerSeries(snaps: Snapshot[], today: string, days: number) {
  const bySource = new Map<Source, Snapshot[]>();
  for (const s of snaps) {
    if (!FOLLOWER_SOURCES.includes(s.source) || s.followers === undefined) continue;
    const list = bySource.get(s.source) ?? [];
    list.push(s);
    bySource.set(s.source, list);
  }
  for (const list of bySource.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  const series: { date: string; followers: number }[] = [];
  const latest = new Map<Source, number>();
  const idx = new Map<Source, number>();
  // Seed with anything before the window, so the line starts at the right level.
  const start = daysBefore(today, days - 1);
  for (const [src, list] of bySource) {
    let i = 0;
    while (i < list.length && list[i]!.date < start) {
      latest.set(src, list[i]!.followers!);
      i++;
    }
    idx.set(src, i);
  }
  for (let k = days - 1; k >= 0; k--) {
    const day = daysBefore(today, k);
    for (const [src, list] of bySource) {
      let i = idx.get(src)!;
      while (i < list.length && list[i]!.date <= day) {
        latest.set(src, list[i]!.followers!);
        i++;
      }
      idx.set(src, i);
    }
    let total = 0;
    for (const v of latest.values()) total += v;
    series.push({ date: day, followers: total });
  }
  const split = [...latest.entries()]
    .map(([source, followers]) => ({ source, followers }))
    .sort((a, b) => b.followers - a.followers);
  return { series, split };
}

/** Latest value of one field for one source, or undefined. */
export function latestOf(snaps: Snapshot[], source: Source, field: keyof Snapshot) {
  let best: Snapshot | undefined;
  for (const s of snaps) {
    if (s.source !== source || s[field] === undefined) continue;
    if (!best || s.date > best.date) best = s;
  }
  return best ? (best[field] as number) : undefined;
}

/** Website totals for the last 7 days and the 7 before, from daily GA4 snapshots. */
export function websiteWeek(snaps: Snapshot[], today: string) {
  const web = snaps.filter((s) => s.source === 'website');
  const daily: { date: string; visits: number }[] = [];
  let visits = 0;
  let users = 0;
  let pageViews = 0;
  let prior = 0;
  for (let k = 6; k >= 0; k--) {
    const day = daysBefore(today, k);
    const s = web.find((w) => w.date === day);
    daily.push({ date: day, visits: s?.visits ?? 0 });
    visits += s?.visits ?? 0;
    users += s?.users ?? 0;
    pageViews += s?.pageViews ?? 0;
  }
  for (let k = 13; k >= 7; k--) {
    prior += web.find((w) => w.date === daysBefore(today, k))?.visits ?? 0;
  }
  const deltaPct = prior > 0 ? Math.round(((visits - prior) / prior) * 100) : undefined;
  return { visits, users, pageViews, daily, ...(deltaPct === undefined ? {} : { deltaPct }) };
}
