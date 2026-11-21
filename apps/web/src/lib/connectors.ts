import { api } from './api.ts';
import type { AppConfig } from './config.ts';

export type ConnStatus = 'connected' | 'needs-reauth' | 'error';
export type CellState = 'on' | 'off' | 'needs-reauth' | 'error';

export interface Connection {
  connectorId: string;
  status: ConnStatus;
  account?: string;
  accounts?: { source: string; label: string }[];
  settings?: Record<string, string>;
  choices?: { id: string; label: string }[];
  connectedAt: string;
  lastSyncAt?: string;
  lastError?: string;
  expiresAt?: string;
}

export interface ConnectorCard {
  id: string;
  label: string;
  blurb: string;
  auth: 'oauth' | 'apiKey' | 'manual';
  /** False until an admin has registered the vendor app (Connectors → Connector apps). */
  available: boolean;
  connection?: Connection;
  manualLatest?: { listeners: number };
}

export interface ArtistRow {
  artistId: string;
  displayName: string;
  cells: Record<
    'instagram' | 'facebook' | 'tiktok' | 'spotify' | 'gcal' | 'youtube' | 'humanitix',
    CellState
  >;
}

export interface AccountInsight {
  account: string;
  name: string;
  total: number;
  delta: number;
  series: number[];
  split: { source: string; followers: number }[];
  spotifyListeners?: number;
}

/** Rev 18: an artist's Humanitix tickets, in My stats (see services/api connectors/humanitix.ts). */
export interface HumanitixGigLink {
  gigId: string;
  title: string;
  date: string;
  venue: string | null;
  humanitixEventId: string;
  eventName: string | null;
  ticketsSold: number | null;
  syncedAt: string | null;
}
export interface HumanitixEventRow {
  id: string;
  name: string;
  startDate: string | null;
  gigId: string | null;
  gigTitle: string | null;
  suggestedGigId: string | null;
}
export interface HumanitixStats {
  connected: boolean;
  status: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  ticketsSold: number;
  series: number[];
  gigs: HumanitixGigLink[];
  /** Only for the artist themselves. */
  events?: HumanitixEventRow[];
  linkable?: { gigId: string; title: string; date: string }[];
}

/** "2026-12-05" on Melbourne's calendar, for a Humanitix start time. */
export function melbourneDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });
}

/** "19:30" on Melbourne's clock, for a Humanitix start or end time. */
export function melbourneTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-GB', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Rev 19: one of an account's Humanitix events, for the gig form's picker. */
export interface HumanitixEvent {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  url?: string;
}

export interface PickerRow extends HumanitixEvent {
  day: string | null;
  sameDay: boolean;
  /** The other gig this event is linked to, which makes it unpickable here. */
  linkedTo: string | null;
}

/**
 * Rev 19: the picker's order. Events on the gig's date first (Same day),
 * then upcoming soonest first; past events (newest first) are kept apart.
 * The search matches the name or venue.
 */
export function pickerRows(
  events: readonly HumanitixEvent[],
  opts: {
    gigId?: string;
    gigDate?: string;
    today: string;
    q?: string;
    /** Other gigs and their Humanitix event, to show "Linked to <gig>". */
    gigs: readonly { gigId: string; title: string; status?: string; humanitixEventId?: string }[];
  },
): { upcoming: PickerRow[]; past: PickerRow[] } {
  const q = (opts.q ?? '').trim().toLowerCase();
  const linked = new Map<string, string>();
  for (const g of opts.gigs)
    if (g.humanitixEventId && g.gigId !== opts.gigId && g.status !== 'cancelled')
      linked.set(g.humanitixEventId, g.title);
  const rows = events
    .filter((e) => !q || `${e.name} ${e.venue ?? ''}`.toLowerCase().includes(q))
    .map((e) => {
      const day = melbourneDay(e.startDate ?? null);
      return {
        ...e,
        day,
        sameDay: !!opts.gigDate && day === opts.gigDate,
        linkedTo: linked.get(e.id) ?? null,
      };
    });
  const upcoming = rows
    .filter((r) => r.sameDay || !r.day || r.day >= opts.today)
    .sort(
      (a, b) =>
        Number(b.sameDay) - Number(a.sameDay) ||
        (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999'),
    );
  const past = rows
    .filter((r) => !upcoming.includes(r))
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
  return { upcoming, past };
}

export interface InsightsData {
  range: 30 | 60 | 90;
  website: {
    visits: number;
    users: number;
    pageViews: number;
    deltaPct?: number;
    daily: { date: string; visits: number }[];
    topPages?: { page: string; visits: number }[];
    sources?: { source: string; share: number }[];
    at?: string;
  };
  subscribers: number | null;
  accounts: AccountInsight[];
  combined: number;
  sources: string[];
}

export const SOURCE_LABEL: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  spotify: 'Spotify',
  website: 'Squarespace',
  humanitix: 'Humanitix',
  mailchimp: 'Mailchimp',
  google: 'Google Workspace',
  meta: 'Meta Business Suite',
  gcal: 'Google Calendar',
};

/** A relative "synced 12 min ago". */
export function ago(iso: string | undefined): string {
  if (!iso) return 'not synced yet';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'synced just now';
  if (mins < 60) return `synced ${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `synced ${h} h ago`;
  return `synced ${Math.round(h / 24)} d ago`;
}

// ── Returning from a vendor's sign-in page ────────────────────────────────
const PENDING = 'bmg.connectorCallback';
export const CALLBACK_PATH = '/connectors/callback';

/** Called before the app loads: keeps the code and state, then cleans the address bar. */
export function captureCallback(): void {
  if (window.location.pathname !== CALLBACK_PATH) return;
  const q = new URLSearchParams(window.location.search);
  const pending = q.get('code')
    ? { code: q.get('code')!, state: q.get('state') ?? '' }
    : { error: q.get('error_description') ?? q.get('error') ?? 'The sign-in was cancelled' };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  window.history.replaceState({}, '', '/');
}

export const hasPendingCallback = () => sessionStorage.getItem(PENDING) !== null;

/** Finishes a connect started on this device. Returns a message for the page. */
export async function finishPendingCallback(
  cfg: AppConfig,
  token: string,
): Promise<{ ok: boolean; message: string } | null> {
  const raw = sessionStorage.getItem(PENDING);
  if (!raw) return null;
  sessionStorage.removeItem(PENDING);
  const p = JSON.parse(raw) as { code?: string; state?: string; error?: string };
  if (!p.code) return { ok: false, message: p.error ?? 'The sign-in was cancelled' };
  try {
    const r = await api<{ connectorId: string; connection: Connection }>(
      cfg,
      token,
      'POST',
      '/connectors/callback',
      { code: p.code, state: p.state },
    );
    const name = SOURCE_LABEL[r.connectorId] ?? r.connectorId;
    return r.connection.status === 'connected'
      ? { ok: true, message: `${name} is connected.` }
      : {
          ok: false,
          message: `${name} is connected, but the first sync failed: ${r.connection.lastError ?? 'try Sync now'}.`,
        };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** A vendor OAuth app behind one or more connectors (admins only). */
export interface ConnectorApp {
  provider: 'google' | 'meta' | 'mailchimp' | 'tiktok' | 'linkedin';
  name: string;
  where: string;
  steps: string[];
  idLabel: string;
  secretLabel: string;
  usedBy: string[];
  configured: boolean;
  /** The last few characters of the registered id, never the secret. */
  clientIdHint: string | null;
  updatedAt: string | null;
  redirectUri: string;
  /** Every address the vendor app must allow: admin host (Blueprint) and artist host. */
  redirectUris?: string[];
}
