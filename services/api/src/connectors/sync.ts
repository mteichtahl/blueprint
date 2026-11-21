import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SessionRole } from '@bmg/crypto';
import { EVENTS_PK, eventSk, gigSk, type Gig } from '../events/model.ts';
import { artistPk } from '../workspace/model.ts';
import { db, env } from '../lib.ts';
import { connectorFor, isoDay, type Snapshot } from './catalog.ts';
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
  humanitixEvents,
  humanitixTicketsSold,
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

    if (def.id === 'humanitix') {
      written = await syncHumanitix(account, tokens.apiKey!, today);
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

/** Linked BMG events get their ticket count; artists get a count per linked gig and a total. */
async function syncHumanitix(account: string, apiKey: string, today: string): Promise<number> {
  if (!isOrg(account)) {
    // Rev 18: the artist's own Humanitix events, kept so My stats can offer to link them.
    const syncedAt = await saveHumanitixEvents(account, await humanitixEvents(apiKey));
    // Each linked gig gets its own count (upcoming, or up to a month ago); the
    // snapshot totals the upcoming ones, for the chart.
    const from = daysAgo(today, HUMANITIX_AFTER_DAYS);
    let sold = 0;
    for (const g of await allGigs(account)) {
      const id = gigHumanitixId(g);
      if (!id || g.date < from || g.status === 'cancelled') continue;
      // Rev 19: linked to Blueprint's Humanitix account, so Blueprint's sync counts it.
      if (g.humanitixAccount === 'bmg') continue;
      const n = await humanitixTicketsSold(apiKey, id);
      if (g.date >= today) sold += n;
      await db
        .send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: artistPk(account), SK: gigSk(g.gigId) },
            UpdateExpression: 'SET humanitix = :h',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':h': { ticketsSold: n, syncedAt } },
          }),
        )
        .catch((err: unknown) => {
          // The gig was deleted meanwhile: nothing to update.
          if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        });
    }
    await writeSnapshots(account, [{ date: today, source: 'humanitix', ticketsSold: sold }]);
    return 1;
  }
  // Rev 19: Blueprint's own event list, for the gig form's picker and its checks.
  await saveHumanitixEvents('bmg', await humanitixEvents(apiKey));
  await syncBmgLinkedGigs(apiKey, today);
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
    if (!e.humanitixEventId || String(e.date) < today) continue;
    const sold = await humanitixTicketsSold(apiKey, String(e.humanitixEventId));
    total += sold;
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: EVENTS_PK, SK: eventSk(String(e.eventId)) },
        UpdateExpression: 'SET ticketsSold = :n, ticketsSyncedAt = :at',
        ExpressionAttributeValues: { ':n': sold, ':at': new Date().toISOString() },
      }),
    );
  }
  await writeSnapshots('bmg', [{ date: today, source: 'humanitix', ticketsSold: total }]);
  return 1;
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
 */
async function syncBmgLinkedGigs(apiKey: string, today: string) {
  const gigs = await db.send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk AND GSI3SK >= :d',
      ExpressionAttributeValues: { ':pk': 'GIGS', ':d': daysAgo(today, HUMANITIX_AFTER_DAYS) },
      Limit: 300,
    }),
  );
  const syncedAt = new Date().toISOString();
  for (const g of (gigs.Items ?? []) as Gig[]) {
    if (g.humanitixAccount !== 'bmg' || !g.humanitixEventId || g.status === 'cancelled') continue;
    const n = await humanitixTicketsSold(apiKey, g.humanitixEventId);
    await db
      .send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: artistPk(g.artistId), SK: gigSk(g.gigId) },
          UpdateExpression: 'SET humanitix = :h',
          ConditionExpression: 'attribute_exists(PK) AND humanitixAccount = :bmg',
          ExpressionAttributeValues: { ':h': { ticketsSold: n, syncedAt }, ':bmg': 'bmg' },
        }),
      )
      .catch((err: unknown) => {
        // Deleted or relinked meanwhile: nothing to update.
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      });
  }
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
