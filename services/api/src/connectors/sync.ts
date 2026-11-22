import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SessionRole } from '@bmg/crypto';
import { EVENTS_PK, eventSk, gigSk, humanitixMoney, type Gig } from '../events/model.ts';
import { artistPk } from '../workspace/model.ts';
import { db, env } from '../lib.ts';
import { connectorFor, isoDay, type Snapshot } from './catalog.ts';
import { summarise, type HxStats } from './humanitix-analytics.ts';
import { HUMANITIX_EVENTS_SK } from './humanitix-link.ts';
import {
  clientCreds,
  isOrg,
  open,
  saveConnection,
  seal,
  withStatus,
  writeSnapshots,
  writeWebDetail,
  type ConnectionItem,
} from './store.ts';
import {
  ensureCalendar,
  humanitixEventData,
  humanitixEvents,
  humanitixTicketsSold,
  HUMANITIX_SCOPE_MESSAGE,
  pullStats,
  refreshTokens,
  upsertCalendarEvent,
  VendorError,
  type HumanitixEvent,
  type Tokens,
} from './vendors.ts';

const bus = new EventBridgeClient({});
const table = () => env('MAIN_TABLE');

async function domainEvent(type: string, detail: Record<string, unknown>) {
  await bus.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: env('EVENT_BUS'),
          Source: 'bmg.workspace',
          DetailType: type,
          Detail: JSON.stringify({ id: randomUUID(), at: new Date().toISOString(), ...detail }),
        },
      ],
    }),
  );
}

export interface SyncResult {
  connection: ConnectionItem;
  snapshots: number;
}

/**
 * Refreshes tokens if needed, pulls today's numbers into snapshots and runs
 * the connector's side jobs (Humanitix tickets, calendar). Never throws for a
 * vendor problem: it records it on the connection instead.
 */
export async function syncConnection(c: ConnectionItem, role: SessionRole): Promise<SyncResult> {
  const account = c.account_;
  const def = connectorFor(isOrg(account) ? 'bmg' : 'artist', c.connectorId);
  const now = new Date();
  const today = isoDay(now);
  if (!def || def.auth === 'manual') return { connection: c, snapshots: 0 };
  let tokens: Tokens;
  let next = c;
  let written = 0;
  try {
    tokens = await open(account, c.connectorId, c.sealed, role);
    const creds = def.provider ? await clientCreds(def.provider) : undefined;
    const fresh = await refreshTokens(def, creds, tokens);
    tokens = fresh.tokens;
    if (fresh.changed) {
      next = { ...next, sealed: await seal(account, c.connectorId, tokens, role) };
    }

    let warning: string | undefined;
    if (def.id === 'humanitix') {
      const r = await syncHumanitix(account, tokens.apiKey!, today);
      written = r.written;
      warning = r.warning;
    } else if (def.id === 'google' || def.id === 'gcal') {
      const calendarId = await ensureCalendar(tokens.accessToken!, next.settings?.calendarId);
      if (calendarId !== next.settings?.calendarId) {
        next = { ...next, settings: { ...(next.settings ?? {}), calendarId } };
      }
      await syncCalendar(account, tokens.accessToken!, calendarId, today);
    } else {
      const pulled = await pullStats(def, tokens, next.settings ?? {}, today);
      const snaps: Snapshot[] = [
        ...pulled.snapshots.map((s) => ({ ...s, date: today })),
        ...(pulled.daily ?? []),
      ];
      if (snaps.length) await writeSnapshots(isOrg(account) ? 'bmg' : account, snaps);
      if (pulled.web) await writeWebDetail(pulled.web, now.toISOString());
      written = snaps.length;
      if (def.id === 'meta') {
        next = {
          ...next,
          accounts: pulled.snapshots.map((s) => ({
            source: s.source,
            label: s.source === 'instagram' ? 'Instagram' : 'Facebook',
          })),
        };
      }
    }
    next = withStatus(next, 'connected', {
      lastSyncAt: now.toISOString(),
      ...(tokens.expiresAt && def.id === 'linkedin'
        ? { expiresAt: new Date(tokens.expiresAt).toISOString() }
        : {}),
    });
    // Rev 20: synced, but something needs the person's attention (a key scope).
    if (warning) next = { ...next, lastError: warning };
    delete next.reauthNotifiedAt;
  } catch (err) {
    const reauth = err instanceof VendorError && err.reauth;
    next = withStatus(next, reauth ? 'needs-reauth' : 'error', {
      lastError: reauth
        ? 'Sign in again to keep this connected'
        : err instanceof VendorError
          ? err.message
          : 'Sync failed',
    });
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'connector.syncFailed',
        connector: c.connectorId,
        account: isOrg(account) ? 'bmg' : 'artist',
        status: err instanceof VendorError ? err.status : undefined,
      }),
    );
    if (reauth && !c.reauthNotifiedAt) {
      next = { ...next, reauthNotifiedAt: now.toISOString() };
      await domainEvent('connector.needsReauth', {
        connectorId: c.connectorId,
        label: def.label,
        ...(isOrg(account) ? {} : { artistId: account }),
      });
    }
  }
  await saveConnection(next);
  return { connection: next, snapshots: written };
}

/** Where each account's Humanitix event list is kept (rev 18 artists, rev 19 Blueprint). */
export { HUMANITIX_EVENTS_SK };
/** Linked gigs keep syncing for a month after the night, so late sales and refunds land. */
export const HUMANITIX_AFTER_DAYS = 30;

/** The Humanitix event a gig is linked to: picked in the app, or read from its ticket link. */
export const gigHumanitixId = (g: Pick<Gig, 'humanitixEventId' | 'ticketUrl'>) =>
  g.humanitixEventId ?? humanitixIdOf(g.ticketUrl);

/** Rev 20: where an event's ticket analytics are kept, in the account's partition. */
export const hxStatsSk = (eventId: string) => `HXSTATS#${eventId}`;

/** One event's count and, where the key allows, its analytics. */
interface EventSync {
  sold: number;
  stats: HxStats | null;
  warning?: string;
}

/**
 * Rev 20: pulls one event's orders and tickets and keeps its analytics (figures
 * only). A key without Orders access still gets the plain ticket count.
 */
export async function syncEventStats(
  account: string,
  apiKey: string,
  eventId: string,
): Promise<EventSync> {
  let data: Awaited<ReturnType<typeof humanitixEventData>>;
  try {
    data = await humanitixEventData(apiKey, eventId);
  } catch (err) {
    if (!(err instanceof VendorError) || err.status !== 424) throw err;
    return {
      sold: await humanitixTicketsSold(apiKey, eventId),
      stats: null,
      warning: HUMANITIX_SCOPE_MESSAGE,
    };
  }
  const stats = summarise({ account, eventId, ...data, now: new Date() });
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: { PK: humanitixEventsPk(account), SK: hxStatsSk(eventId), ...stats },
    }),
  );
  return { sold: stats.sold, stats };
}

/** The gig's count, net and gross, and its money when that follows Humanitix. */
export async function applyToGig(g: Gig, r: EventSync, onlyIfBmg = false) {
  const syncedAt = new Date().toISOString();
  const humanitix: NonNullable<Gig['humanitix']> = {
    ticketsSold: r.sold,
    syncedAt,
    ...(r.stats ? { netCents: r.stats.money.netCents, grossCents: r.stats.money.grossCents } : {}),
  };
  const money = humanitixMoney(g.money, humanitix);
  await db
    .send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: artistPk(g.artistId), SK: gigSk(g.gigId) },
        UpdateExpression: money ? 'SET humanitix = :h, money = :m' : 'SET humanitix = :h',
        ConditionExpression: onlyIfBmg
          ? 'attribute_exists(PK) AND humanitixAccount = :bmg'
          : 'attribute_exists(PK)',
        ExpressionAttributeValues: {
          ':h': humanitix,
          ...(money ? { ':m': money } : {}),
          ...(onlyIfBmg ? { ':bmg': 'bmg' } : {}),
        },
      }),
    )
    .catch((err: unknown) => {
      // Deleted or relinked meanwhile: nothing to update.
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    });
}

/** A Blueprint event's count, synced time and net takings. */
export async function applyToEvent(eventId: string, r: EventSync) {
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: EVENTS_PK, SK: eventSk(eventId) },
      UpdateExpression: r.stats
        ? 'SET ticketsSold = :n, ticketsSyncedAt = :at, humanitixNetCents = :net'
        : 'SET ticketsSold = :n, ticketsSyncedAt = :at',
      ExpressionAttributeValues: {
        ':n': r.sold,
        ':at': new Date().toISOString(),
        ...(r.stats ? { ':net': r.stats.money.netCents } : {}),
      },
    }),
  );
}

/**
 * Rev 20: analytics for events no longer linked are deleted, so nothing is
 * kept about an event the account has let go of.
 */
async function pruneStats(account: string, keep: ReadonlySet<string>) {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':pk': humanitixEventsPk(account), ':s': 'HXSTATS#' },
      ProjectionExpression: 'PK, SK',
    }),
  );
  for (const it of res.Items ?? []) {
    if (keep.has(String(it.SK).slice('HXSTATS#'.length))) continue;
    await db.send(new DeleteCommand({ TableName: table(), Key: { PK: it.PK, SK: it.SK } }));
  }
}

/** Rev 20: on disconnecting Humanitix, the account's analytics go too. */
export const clearHumanitixStats = (account: string) => pruneStats(account, new Set());

/** Linked BMG events get their ticket count; artists get a count per linked gig and a total. */
async function syncHumanitix(
  account: string,
  apiKey: string,
  today: string,
): Promise<{ written: number; warning?: string }> {
  let warning: string | undefined;
  const keep = new Set<string>();
  if (!isOrg(account)) {
    // Rev 18: the artist's own Humanitix events, kept so My stats can offer to link them.
    await saveHumanitixEvents(account, await humanitixEvents(apiKey));
    // Each linked gig gets its own count (upcoming, or up to a month ago); the
    // snapshot totals the upcoming ones, for the chart.
    const from = daysAgo(today, HUMANITIX_AFTER_DAYS);
    let sold = 0;
    for (const g of await allGigs(account)) {
      const id = gigHumanitixId(g);
      // Rev 19: linked to Blueprint's Humanitix account, so Blueprint's sync counts it.
      if (!id || g.status === 'cancelled' || g.humanitixAccount === 'bmg') continue;
      // Older gigs stop syncing but keep their analytics.
      keep.add(id);
      if (g.date < from) continue;
      const r = await syncEventStats(account, apiKey, id);
      warning ??= r.warning;
      if (g.date >= today) sold += r.sold;
      await applyToGig(g, r);
    }
    await writeSnapshots(account, [{ date: today, source: 'humanitix', ticketsSold: sold }]);
    await pruneStats(account, keep);
    return { written: 1, ...(warning ? { warning } : {}) };
  }
  // Rev 19: Blueprint's own event list, for the gig form's picker and its checks.
  await saveHumanitixEvents('bmg', await humanitixEvents(apiKey));
  warning = await syncBmgLinkedGigs(apiKey, today, keep);
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :e)',
      ExpressionAttributeValues: { ':pk': EVENTS_PK, ':e': 'EVENT#' },
      Limit: 200,
    }),
  );
  let total = 0;
  for (const e of res.Items ?? []) {
    if (!e.humanitixEventId) continue;
    const hxId = String(e.humanitixEventId);
    keep.add(hxId);
    // Past events keep their last figures (a month after, for late refunds).
    if (String(e.date) < daysAgo(today, HUMANITIX_AFTER_DAYS)) continue;
    const r = await syncEventStats('bmg', apiKey, hxId);
    warning ??= r.warning;
    if (String(e.date) >= today) total += r.sold;
    await applyToEvent(String(e.eventId), r);
  }
  await writeSnapshots('bmg', [{ date: today, source: 'humanitix', ticketsSold: total }]);
  await pruneStats('bmg', keep);
  return { written: 1, ...(warning ? { warning } : {}) };
}

/** The partition an account's Humanitix event list lives in. */
export const humanitixEventsPk = (account: string) =>
  isOrg(account) ? EVENTS_PK : artistPk(account);

/** Keeps an account's Humanitix event list (artist: My stats and the picker; Blueprint: the picker). */
export async function saveHumanitixEvents(
  account: string,
  events: readonly HumanitixEvent[],
): Promise<string> {
  const syncedAt = new Date().toISOString();
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: humanitixEventsPk(account),
        SK: HUMANITIX_EVENTS_SK,
        type: 'humanitix-events',
        events: events.slice(0, 300),
        syncedAt,
      },
    }),
  );
  return syncedAt;
}

/**
 * Rev 19: gigs Blueprint linked to its own Humanitix events get their count
 * from Blueprint's key. Blueprint only links gigs it can see, which are shared,
 * so the shared-gigs index finds them (upcoming, or up to a month ago).
 * Rev 20: with their analytics, kept in Blueprint's partition.
 */
async function syncBmgLinkedGigs(apiKey: string, today: string, keep: Set<string>) {
  const gigs = await db.send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': 'GIGS' },
      Limit: 500,
    }),
  );
  let warning: string | undefined;
  const from = daysAgo(today, HUMANITIX_AFTER_DAYS);
  for (const g of (gigs.Items ?? []) as Gig[]) {
    if (g.humanitixAccount !== 'bmg' || !g.humanitixEventId || g.status === 'cancelled') continue;
    keep.add(g.humanitixEventId);
    if (g.date < from) continue;
    const r = await syncEventStats('bmg', apiKey, g.humanitixEventId);
    warning ??= r.warning;
    await applyToGig(g, r, true);
  }
  return warning;
}

/** A Humanitix event id from a ticket link, when the link is to Humanitix. */
export function humanitixIdOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!/(^|\.)humanitix\.com$/.test(u.hostname)) return undefined;
    return u.searchParams.get('eventId') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Only gigs that are actually happening go in calendars and ticket totals. */
const onCalendar = (g: Pick<Gig, 'status'>) => g.status === 'confirmed' || g.status === 'booked';

function daysAgo(today: string, n: number) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function allGigs(artistId: string): Promise<Gig[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :g)',
      ExpressionAttributeValues: { ':pk': artistPk(artistId), ':g': 'GIG#' },
      Limit: 300,
    }),
  );
  return (res.Items ?? []) as Gig[];
}

async function upcomingGigs(artistId: string, today: string): Promise<Gig[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :g)',
      ExpressionAttributeValues: { ':pk': artistPk(artistId), ':g': 'GIG#' },
      Limit: 300,
    }),
  );
  return ((res.Items ?? []) as Gig[]).filter((g) => g.date >= today && onCalendar(g));
}

/**
 * Blueprint's calendar gets every shared upcoming gig and its own events;
 * an artist's calendar gets their own upcoming gigs (their account, their data).
 */
async function syncCalendar(account: string, token: string, calendarId: string, today: string) {
  if (!isOrg(account)) {
    for (const g of (await upcomingGigs(account, today)).slice(0, 100)) {
      await upsertCalendarEvent(token, calendarId, 'gig', g.gigId, g);
    }
    return;
  }
  const gigs = await db.send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk AND GSI3SK >= :d',
      ExpressionAttributeValues: { ':pk': 'GIGS', ':d': today },
      Limit: 100,
    }),
  );
  for (const g of (gigs.Items ?? []) as Gig[]) {
    if (!onCalendar(g)) continue;
    await upsertCalendarEvent(token, calendarId, 'gig', g.gigId, g);
  }
  const events = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :e)',
      ExpressionAttributeValues: { ':pk': EVENTS_PK, ':e': 'EVENT#' },
      Limit: 100,
    }),
  );
  for (const e of events.Items ?? []) {
    if (String(e.date) < today) continue;
    await upsertCalendarEvent(token, calendarId, 'event', String(e.eventId), {
      title: String(e.name ?? 'Blueprint event'),
      date: String(e.date),
      ...(e.venue ? { venue: String(e.venue) } : {}),
    });
  }
}
