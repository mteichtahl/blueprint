import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { authorize, type Action, type Principal } from '@bmg/authz';
import { isArtistId } from '@bmg/crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  ApiKeyBody,
  authorizeUrl,
  CallbackBody,
  connectorFor,
  connectorsFor,
  daysBefore,
  followerSeries,
  isoDay,
  latestOf,
  LinkEventBody,
  ManualStatsBody,
  newState,
  newVerifier,
  OAUTH_STATE_TTL_SECONDS,
  rangeParam,
  SettingsBody,
  websiteWeek,
  type ConnectorDef,
  type Owner,
  type Snapshot,
} from '../connectors/catalog.ts';
import {
  clientCreds,
  deleteConnection,
  listConnections,
  loadConnection,
  mergeSettings,
  open,
  putState,
  readSnapshots,
  readWebDetail,
  redirectUri,
  saveConnection,
  seal,
  takeState,
  view,
  writeSnapshots,
  type Account,
  type ConnectionItem,
} from '../connectors/store.ts';
import { syncConnection } from '../connectors/sync.ts';
import { exchangeCode, humanitixEvents, VendorError } from '../connectors/vendors.ts';
import { EVENTS_PK, eventSk } from '../events/model.ts';
import { artistPk, PROFILE_SK, ROSTER_GSI1PK } from '../workspace/model.ts';
import {
  audit,
  authContext,
  db,
  env,
  handle,
  HttpError,
  json,
  parseBody,
  principalFor,
} from '../lib.ts';

const table = () => env('MAIN_TABLE');
const bus = new EventBridgeClient({});
const isBmg = (p: Principal) => p.role === 'bmg-admin' || p.role === 'bmg-staff';

function ensureArtist(principal: Principal, action: Action, artistId: string) {
  const d = authorize(principal, action, { kind: 'artist-data', artistId, visibility: 'normal' });
  if (!d.allow) throw new HttpError(403, d.reason);
}
function ensureOrgAdmin(principal: Principal) {
  const d = authorize(principal, 'admin', { kind: 'org-admin' });
  if (!d.allow) throw new HttpError(403, d.reason);
}
function ensureBmg(principal: Principal) {
  if (!isBmg(principal)) throw new HttpError(403, 'Blueprint only');
}
/** Only the artist can sign in to their own accounts. */
function ensureSelf(principal: Principal, artistId: string) {
  if (principal.role !== 'artist' || principal.artistId !== artistId) {
    throw new HttpError(403, 'Only the artist can connect their own accounts');
  }
}

const artistParam = (event: APIGatewayProxyEvent) => {
  const id = event.pathParameters?.artistId;
  if (!isArtistId(id)) throw new HttpError(404, 'No such artist');
  return id;
};
function defParam(event: APIGatewayProxyEvent, owner: Owner): ConnectorDef {
  const def = connectorFor(owner, event.pathParameters?.connectorId);
  if (!def) throw new HttpError(404, 'No such connector');
  return def;
}
async function existing(account: Account, def: ConnectorDef) {
  const c = await loadConnection(account, def.id);
  if (!c) throw new HttpError(404, `${def.label} is not connected`);
  return c;
}

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

/** Connector cards: every connector for this owner, with its connection if there is one. */
async function cards(account: Account, owner: Owner) {
  const conns = new Map((await listConnections(account)).map((c) => [c.connectorId, c]));
  const ready = new Map<string, boolean>();
  for (const def of connectorsFor(owner)) {
    if (def.provider && !ready.has(def.provider)) {
      ready.set(def.provider, !!(await clientCreds(def.provider)));
    }
  }
  const manual =
    owner === 'artist' ? await readSnapshots(account, daysBefore(isoDay(new Date()), 90)) : [];
  return connectorsFor(owner).map((def) => {
    const c = conns.get(def.id);
    const spotify = def.id === 'spotify' ? latestOf(manual, 'spotify', 'listeners') : undefined;
    return {
      id: def.id,
      label: def.label,
      blurb: def.blurb,
      auth: def.auth,
      // OAuth connectors need BMG to have registered the app first.
      available: def.auth !== 'oauth' || ready.get(def.provider!) === true,
      ...(c ? { connection: view(c) } : {}),
      ...(spotify !== undefined ? { manualLatest: { listeners: spotify } } : {}),
    };
  });
}

async function roster(principal: Principal) {
  if (principal.role === 'bmg-admin') {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': ROSTER_GSI1PK },
        Limit: 100,
      }),
    );
    return res.Items ?? [];
  }
  const ids = (principal.assignedArtistIds ?? []).slice(0, 100);
  if (!ids.length) return [];
  const res = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [table()]: { Keys: ids.map((id) => ({ PK: artistPk(id), SK: PROFILE_SK })) },
      },
    }),
  );
  return res.Responses?.[table()] ?? [];
}

/** The status cells in "Artists' own connectors" (Instagram and Facebook come from Meta). */
function artistCells(conns: ConnectionItem[], snaps: Snapshot[]) {
  const by = new Map(conns.map((c) => [c.connectorId, c]));
  const meta = by.get('meta');
  const has = (src: string) => meta?.accounts?.some((a) => a.source === src) ?? false;
  const state = (c: ConnectionItem | undefined, ok = true) =>
    !c
      ? 'off'
      : c.status === 'connected' && ok
        ? 'on'
        : c.status === 'connected'
          ? 'off'
          : c.status;
  return {
    instagram: state(meta, has('instagram')),
    facebook: state(meta, has('facebook')),
    tiktok: state(by.get('tiktok')),
    // Spotify is entered by hand: "on" once there's a number from the last 45 days.
    spotify: snaps.some((s) => s.source === 'spotify') ? 'on' : 'off',
    gcal: state(by.get('gcal')),
    youtube: state(by.get('youtube')),
    humanitix: state(by.get('humanitix')),
  };
}

const startOAuth = async (account: Account, def: ConnectorDef, sub: string) => {
  const creds = await clientCreds(def.provider!);
  if (!creds) {
    throw new HttpError(
      409,
      `${def.label} isn't set up yet: run \`blueprint connectors setup ${def.provider}\``,
    );
  }
  const state = newState();
  const verifier = def.provider === 'google' ? newVerifier() : undefined;
  await putState(
    state,
    { account, connectorId: def.id, sub, ...(verifier ? { verifier } : {}) },
    OAUTH_STATE_TTL_SECONDS,
  );
  return authorizeUrl(def, {
    clientId: creds.clientId,
    redirectUri: await redirectUri(),
    state,
    ...(verifier ? { verifier } : {}),
  });
};

async function connectApiKey(
  event: APIGatewayProxyEvent,
  principal: Principal,
  account: Account,
  def: ConnectorDef,
) {
  const { apiKey } = parseBody(event, ApiKeyBody);
  let count: number;
  try {
    count = (await humanitixEvents(apiKey)).length;
  } catch (err) {
    if (err instanceof VendorError && err.reauth)
      throw new HttpError(400, 'Humanitix did not accept that key');
    throw new HttpError(502, 'Humanitix could not be reached. Try again shortly');
  }
  const now = new Date().toISOString();
  const item: ConnectionItem = {
    account_: account,
    connectorId: def.id,
    status: 'connected',
    account: `${count} event${count === 1 ? '' : 's'} visible`,
    connectedAt: now,
    connectedBy: principal.sub,
    sealed: await seal(account, def.id, { apiKey }, principal.role),
  };
  await saveConnection(item);
  await audit(event, 'connector.connected', 'success', {
    connector: def.id,
    scope: account === 'bmg' ? 'bmg' : 'artist',
  });
  const synced = await syncConnection(item, principal.role);
  return json(200, view(synced.connection));
}

async function connect(
  event: APIGatewayProxyEvent,
  principal: Principal,
  account: Account,
  def: ConnectorDef,
) {
  if (def.auth === 'manual') throw new HttpError(400, `${def.label} numbers are entered by hand`);
  if (def.auth === 'apiKey') return connectApiKey(event, principal, account, def);
  return json(200, { url: await startOAuth(account, def, principal.sub) });
}

async function patchSettings(event: APIGatewayProxyEvent, account: Account, def: ConnectorDef) {
  const c = await existing(account, def);
  const body = parseBody(event, SettingsBody);
  // A choice must be one the vendor offered at sign-in.
  for (const v of [body.ga4PropertyId, body.listId, body.pageId, body.organizationId]) {
    if (v && !(c.choices ?? []).some((ch) => ch.id === v)) {
      throw new HttpError(400, 'Pick one of the accounts offered');
    }
  }
  let next = mergeSettings(c, body);
  if (body.pageId || body.ga4PropertyId) {
    const label = c.choices?.find((ch) => ch.id === (body.pageId ?? body.ga4PropertyId))?.label;
    if (label) next = { ...next, account: label.split(' · ')[0] };
  }
  await saveConnection(next);
  return next;
}

async function disconnect(event: APIGatewayProxyEvent, account: Account, def: ConnectorDef) {
  await deleteConnection(account, def.id);
  await audit(event, 'connector.disconnected', 'success', {
    connector: def.id,
    scope: account === 'bmg' ? 'bmg' : 'artist',
  });
  // History stays: snapshots are not deleted.
  return json(200, { ok: true });
}

async function manualStats(event: APIGatewayProxyEvent, account: Account) {
  const body = parseBody(event, ManualStatsBody);
  if (body.date > isoDay(new Date())) throw new HttpError(400, 'That date is in the future');
  const { source, date, ...nums } = body;
  await writeSnapshots(account, [{ date, source, ...nums, manual: true }]);
  return json(201, { ok: true });
}

/** One account's followers over the range, its split by platform and Spotify. */
function accountInsight(snaps: Snapshot[], today: string, range: number) {
  const { series, split } = followerSeries(snaps, today, range);
  const first = series[0]?.followers ?? 0;
  const total = series.at(-1)?.followers ?? 0;
  const listeners = latestOf(snaps, 'spotify', 'listeners');
  return {
    total,
    delta: total - first,
    series: series.map((s) => s.followers),
    split,
    ...(listeners !== undefined ? { spotifyListeners: listeners } : {}),
  };
}

export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const route = `${event.httpMethod} ${event.resource}`;

  switch (route) {
    // ── Blueprint's own connectors ──
    case 'GET /connectors': {
      ensureBmg(principal);
      const artists = await roster(principal);
      const since = daysBefore(isoDay(new Date()), 45);
      const rows = await Promise.all(
        artists.map(async (a) => {
          const id = String(a.artistId);
          const [conns, snaps] = await Promise.all([listConnections(id), readSnapshots(id, since)]);
          return {
            artistId: id,
            displayName: String(a.displayName ?? ''),
            cells: artistCells(conns, snaps),
          };
        }),
      );
      return json(200, { connectors: await cards('bmg', 'bmg'), artists: rows });
    }

    case 'POST /connectors/{connectorId}/connect':
      ensureOrgAdmin(principal);
      return connect(event, principal, 'bmg', defParam(event, 'bmg'));

    case 'PATCH /connectors/{connectorId}': {
      ensureOrgAdmin(principal);
      const def = defParam(event, 'bmg');
      const next = await patchSettings(event, 'bmg', def);
      return json(200, view((await syncConnection(next, principal.role)).connection));
    }

    case 'DELETE /connectors/{connectorId}':
      ensureOrgAdmin(principal);
      return disconnect(event, 'bmg', defParam(event, 'bmg'));

    case 'POST /connectors/{connectorId}/sync': {
      ensureBmg(principal);
      const def = defParam(event, 'bmg');
      const c = await existing('bmg', def);
      return json(200, view((await syncConnection(c, principal.role)).connection));
    }

    case 'GET /connectors/humanitix/events': {
      ensureBmg(principal);
      const c = await loadConnection('bmg', 'humanitix');
      if (!c) return json(200, { events: [] });
      const t = await open('bmg', 'humanitix', c.sealed, principal.role);
      try {
        return json(200, { events: await humanitixEvents(t.apiKey!) });
      } catch {
        throw new HttpError(502, 'Humanitix could not be reached. Try again shortly');
      }
    }

    case 'PUT /events/{eventId}/humanitix': {
      ensureBmg(principal);
      const eventId = event.pathParameters?.eventId ?? '';
      if (!/^[a-z0-9]{10,40}$/.test(eventId)) throw new HttpError(404, 'Not found');
      const { humanitixEventId } = parseBody(event, LinkEventBody);
      const got = await db.send(
        new GetCommand({ TableName: table(), Key: { PK: EVENTS_PK, SK: eventSk(eventId) } }),
      );
      if (!got.Item) throw new HttpError(404, 'No such event');
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: EVENTS_PK, SK: eventSk(eventId) },
          UpdateExpression: 'SET humanitixEventId = :h, updatedAt = :at',
          ExpressionAttributeValues: { ':h': humanitixEventId, ':at': new Date().toISOString() },
        }),
      );
      const c = await loadConnection('bmg', 'humanitix');
      if (c) await syncConnection(c, principal.role);
      return json(200, { ok: true });
    }

    case 'POST /connectors/callback': {
      const body = parseBody(event, CallbackBody);
      const s = await takeState(body.state);
      // The state must be fresh and started by this same person.
      if (!s || s.sub !== principal.sub)
        throw new HttpError(400, 'This sign-in link has expired. Start again');
      const owner: Owner = s.account === 'bmg' ? 'bmg' : 'artist';
      if (owner === 'bmg') ensureOrgAdmin(principal);
      else ensureSelf(principal, s.account);
      const def = connectorFor(owner, s.connectorId);
      if (!def?.provider) throw new HttpError(400, 'Unknown connector');
      const creds = await clientCreds(def.provider);
      if (!creds) throw new HttpError(409, `${def.label} isn't set up yet`);
      let got;
      try {
        got = await exchangeCode(def, creds, body.code, await redirectUri(), s.verifier);
      } catch (err) {
        await audit(event, 'connector.connected', 'failed', { connector: def.id });
        throw new HttpError(
          502,
          err instanceof VendorError && err.status === 400 && err.message.startsWith('No ')
            ? err.message
            : `${def.label} did not finish the sign-in. Try again`,
        );
      }
      const now = new Date().toISOString();
      const item: ConnectionItem = {
        account_: s.account,
        connectorId: def.id,
        status: 'connected',
        ...(got.account ? { account: got.account } : {}),
        ...(got.settings ? { settings: got.settings as Record<string, string> } : {}),
        ...(got.choices?.length ? { choices: got.choices } : {}),
        connectedAt: now,
        connectedBy: principal.sub,
        sealed: await seal(s.account, def.id, got.tokens, principal.role),
      };
      await saveConnection(item);
      await audit(event, 'connector.connected', 'success', { connector: def.id, scope: owner });
      const synced = await syncConnection(item, principal.role);
      return json(200, { owner, connectorId: def.id, connection: view(synced.connection) });
    }

    case 'POST /artists/{artistId}/connectors/remind': {
      ensureBmg(principal);
      const artistId = artistParam(event);
      ensureArtist(principal, 'read', artistId);
      await domainEvent('connector.reminder', { artistId });
      return json(202, { ok: true });
    }

    // ── An artist's own connectors ──
    case 'GET /artists/{artistId}/connectors': {
      const artistId = artistParam(event);
      ensureArtist(principal, 'read', artistId);
      return json(200, { connectors: await cards(artistId, 'artist') });
    }

    case 'POST /artists/{artistId}/connectors/{connectorId}/connect': {
      const artistId = artistParam(event);
      ensureSelf(principal, artistId);
      return connect(event, principal, artistId, defParam(event, 'artist'));
    }

    case 'PATCH /artists/{artistId}/connectors/{connectorId}': {
      const artistId = artistParam(event);
      ensureSelf(principal, artistId);
      const next = await patchSettings(event, artistId, defParam(event, 'artist'));
      return json(200, view((await syncConnection(next, principal.role)).connection));
    }

    case 'DELETE /artists/{artistId}/connectors/{connectorId}': {
      const artistId = artistParam(event);
      // The artist, or an admin (for example after they leave).
      if (!(principal.role === 'artist' && principal.artistId === artistId))
        ensureOrgAdmin(principal);
      return disconnect(event, artistId, defParam(event, 'artist'));
    }

    case 'POST /artists/{artistId}/connectors/{connectorId}/sync': {
      const artistId = artistParam(event);
      ensureArtist(principal, 'write', artistId);
      const c = await existing(artistId, defParam(event, 'artist'));
      return json(200, view((await syncConnection(c, principal.role)).connection));
    }

    // ── Stats: hand-entered numbers and the charts ──
    case 'POST /artists/{artistId}/stats': {
      const artistId = artistParam(event);
      ensureArtist(principal, 'write', artistId);
      return manualStats(event, artistId);
    }

    case 'POST /stats': {
      ensureBmg(principal);
      return manualStats(event, 'bmg');
    }

    case 'GET /artists/{artistId}/stats': {
      const artistId = artistParam(event);
      ensureArtist(principal, 'read', artistId);
      const range = rangeParam(event.queryStringParameters?.range);
      const today = isoDay(new Date());
      const snaps = await readSnapshots(artistId, daysBefore(today, range + 60));
      return json(200, { range, ...accountInsight(snaps, today, range) });
    }

    case 'GET /insights': {
      ensureBmg(principal);
      const range = rangeParam(event.queryStringParameters?.range);
      const today = isoDay(new Date());
      const from = daysBefore(today, Math.max(range, 14) + 60);
      const [bmgSnaps, web, artists, conns] = await Promise.all([
        readSnapshots('bmg', from),
        readWebDetail(),
        roster(principal),
        listConnections('bmg'),
      ]);
      const accounts = [
        { account: 'bmg', name: 'Blueprint', ...accountInsight(bmgSnaps, today, range) },
        ...(await Promise.all(
          artists.map(async (a) => ({
            account: String(a.artistId),
            name: String(a.displayName ?? ''),
            ...accountInsight(await readSnapshots(String(a.artistId), from), today, range),
          })),
        )),
      ];
      return json(200, {
        range,
        website: {
          ...websiteWeek(bmgSnaps, today),
          ...(web ? { topPages: web.topPages, sources: web.sources, at: web.at } : {}),
        },
        subscribers: latestOf(bmgSnaps, 'mailchimp', 'subscribers') ?? null,
        accounts,
        combined: accounts.reduce((n, a) => n + a.total, 0),
        sources: conns.filter((c) => c.status === 'connected').map((c) => c.connectorId),
      });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
