import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { authorize, type Principal } from '@bmg/authz';
import { EVENTS_PK, eventSk, gigSk, type Gig } from '../events/model.ts';
import { db, env, HttpError } from '../lib.ts';
import { artistPk } from '../workspace/model.ts';
import {
  analyticsView,
  limitedView,
  type AnalyticsView,
  type HxStats,
} from './humanitix-analytics.ts';
import { loadConnection, open } from './store.ts';
import {
  applyToEvent,
  applyToGig,
  gigHumanitixId,
  humanitixEventsPk,
  hxStatsSk,
  syncEventStats,
} from './sync.ts';
import { VendorError } from './vendors.ts';

/**
 * Rev 20: who can open a linked gig's or event's ticket analytics, and from
 * which Humanitix account they come. Pure, so the rules are unit-tested.
 *
 * - The artist: their own gig (from their account, or Blueprint's if Blueprint linked it).
 * - Blueprint: shared gigs only. When the gig is linked to the artist's own
 *   account and the artist turned "Share ticket analytics with Blueprint" off,
 *   Blueprint gets counts and takings only.
 * - Blueprint events: Blueprint only.
 */
export type AnalyticsTarget =
  | { kind: 'gig'; account: string; hxId: string; limited: boolean; gig: Gig }
  | { kind: 'event'; account: 'bmg'; hxId: string; eventId: string };

const isBmg = (p: Pick<Principal, 'role'>) => p.role === 'bmg-admin' || p.role === 'bmg-staff';

export function gigAnalyticsAccess(
  principal: Principal,
  gig: Gig | undefined,
): { ok: true; target: AnalyticsTarget } | { ok: false; status: number; message: string } {
  if (!gig) return { ok: false, status: 404, message: 'No such gig' };
  const d = authorize(principal, 'read', {
    kind: 'artist-data',
    artistId: gig.artistId,
    visibility: gig.shared ? 'normal' : 'private',
  });
  if (!d.allow) return { ok: false, status: 404, message: 'No such gig' };
  const hxId = gigHumanitixId(gig);
  if (!hxId) return { ok: false, status: 404, message: 'This gig is not linked to Humanitix' };
  const account = gig.humanitixAccount === 'bmg' ? 'bmg' : gig.artistId;
  const limited = isBmg(principal) && account !== 'bmg' && gig.shareTicketAnalytics === false;
  return { ok: true, target: { kind: 'gig', account, hxId, limited, gig } };
}

const table = () => env('MAIN_TABLE');

async function loadTarget(principal: Principal, q: Record<string, string | undefined>) {
  if (q.eventId !== undefined) {
    if (!isBmg(principal)) throw new HttpError(403, 'Blueprint only');
    if (!/^[a-z0-9]{10,40}$/.test(q.eventId)) throw new HttpError(404, 'No such event');
    const got = await db.send(
      new GetCommand({ TableName: table(), Key: { PK: EVENTS_PK, SK: eventSk(q.eventId) } }),
    );
    const hxId = got.Item?.humanitixEventId;
    if (!got.Item) throw new HttpError(404, 'No such event');
    if (!hxId) throw new HttpError(404, 'This event is not linked to Humanitix');
    return { kind: 'event', account: 'bmg', hxId: String(hxId), eventId: q.eventId } as const;
  }
  const { artistId, gigId } = q;
  if (
    !artistId ||
    !gigId ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(artistId) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(gigId)
  )
    throw new HttpError(404, 'No such gig');
  const got = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: gigSk(gigId) } }),
  );
  const access = gigAnalyticsAccess(principal, got.Item as Gig | undefined);
  if (!access.ok) throw new HttpError(access.status, access.message);
  return access.target;
}

async function statsFor(account: string) {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':pk': humanitixEventsPk(account), ':s': 'HXSTATS#' },
      Limit: 200,
    }),
  );
  return (res.Items ?? []) as HxStats[];
}

export interface AnalyticsResponse {
  connected: boolean;
  /** Linked, but the first sync hasn't brought the figures in yet. */
  pending?: boolean;
  analytics?: AnalyticsView;
  /** Sync now is offered: the viewer's own account, not a limited view. */
  canSync?: boolean;
  /** The artist can switch Blueprint's view of this gig's analytics. */
  canShare?: boolean;
  shared?: boolean;
  lastError?: string | null;
}

/** GET /connectors/humanitix/events?analytics=1&(artistId&gigId | eventId) */
export async function readAnalytics(
  principal: Principal,
  q: Record<string, string | undefined>,
): Promise<AnalyticsResponse> {
  const target = await loadTarget(principal, q);
  const [connection, all] = await Promise.all([
    loadConnection(target.account, 'humanitix'),
    statsFor(target.account),
  ]);
  const stats = all.find((s) => s.eventId === target.hxId);
  const share =
    target.kind === 'gig' && principal.role === 'artist' && target.account !== 'bmg'
      ? { canShare: true, shared: target.gig.shareTicketAnalytics !== false }
      : {};
  const limited = target.kind === 'gig' && target.limited;
  Object.assign(share, { canSync: !limited && !(target.account === 'bmg' && !isBmg(principal)) });
  if (!stats)
    return {
      connected: !!connection,
      pending: true,
      lastError: connection?.lastError ?? null,
      ...share,
    };
  const v = analyticsView(stats, all, new Date());
  return {
    connected: !!connection,
    analytics: target.kind === 'gig' && target.limited ? limitedView(v) : v,
    lastError: connection?.lastError ?? null,
    ...share,
  };
}

/** Sync now from the analytics page: this one event, at most once a minute. */
export async function syncAnalytics(
  principal: Principal,
  q: Record<string, string | undefined>,
): Promise<AnalyticsResponse> {
  const target = await loadTarget(principal, q);
  if (target.kind === 'gig' && target.limited)
    throw new HttpError(403, 'Only the artist can sync this');
  // Blueprint's Humanitix key is Blueprint's: its hourly sync covers the artist.
  if (target.account === 'bmg' && !isBmg(principal))
    throw new HttpError(403, "This gig uses Blueprint's Humanitix account, which syncs every hour");
  const connection = await loadConnection(target.account, 'humanitix');
  if (!connection) throw new HttpError(404, 'Humanitix is not connected');
  const got = await db.send(
    new GetCommand({
      TableName: table(),
      Key: { PK: humanitixEventsPk(target.account), SK: hxStatsSk(target.hxId) },
      ProjectionExpression: 'syncedAt',
    }),
  );
  const last = got.Item?.syncedAt ? new Date(String(got.Item.syncedAt)).getTime() : 0;
  if (Date.now() - last >= 60_000) {
    const key = await open(target.account, 'humanitix', connection.sealed, principal.role);
    try {
      const r = await syncEventStats(target.account, key.apiKey!, target.hxId);
      if (target.kind === 'gig') await applyToGig(target.gig, r, target.account === 'bmg');
      else await applyToEvent(target.eventId, r);
    } catch (err) {
      if (err instanceof VendorError)
        throw new HttpError(
          502,
          err.status === 429
            ? 'Humanitix is busy. Try again in a minute'
            : 'Humanitix could not be reached. Try again shortly',
        );
      throw err;
    }
  }
  return readAnalytics(principal, q);
}
