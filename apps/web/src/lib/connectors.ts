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
  /** False until BMG has registered the vendor app (`blueprint connectors setup`). */
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
