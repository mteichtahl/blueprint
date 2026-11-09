import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SessionRole } from '@bmg/crypto';
import { EVENTS_PK, eventSk, type Gig } from '../events/model.ts';
import { artistPk } from '../workspace/model.ts';
import { db, env } from '../lib.ts';
import { connectorFor, isoDay, type Snapshot } from './catalog.ts';
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
  humanitixTicketsSold,
  pullStats,
  refreshTokens,
  upsertCalendarEvent,
  VendorError,
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

/** Linked BMG events get their ticket count; artists get a running total. */
async function syncHumanitix(account: string, apiKey: string, today: string): Promise<number> {
  if (!isOrg(account)) {
    // Artists: tickets across their upcoming gigs that carry a Humanitix id.
    const gigs = await upcomingGigs(account, today);
    let sold = 0;
    for (const g of gigs) {
      const id = humanitixIdOf(g.ticketUrl);
      if (id) sold += await humanitixTicketsSold(apiKey, id);
    }
    await writeSnapshots(account, [{ date: today, source: 'humanitix', ticketsSold: sold }]);
    return 1;
  }
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
