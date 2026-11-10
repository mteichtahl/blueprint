import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { authorize, type Action, type Principal } from '@bmg/authz';
import { isArtistId } from '@bmg/crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  byTime,
  checkTimes,
  crewTag,
  dealNoteFor,
  DEFAULT_CHECKLIST,
  EVENT_PARTS,
  EventBody,
  EventCreate,
  EventPatch,
  eventPk,
  EVENTS_PK,
  eventSk,
  GigCreate,
  gigGsi3Sk,
  gigMatches,
  GigPatch,
  gigPatchAllowed,
  GIGS_GSI3PK,
  gigSk,
  PART_SCHEMAS,
  partSk,
  patchOf,
  summarise,
  type CrewPerson,
  type EventPart,
  type Gig,
  type GigFilter,
} from '../events/model.ts';
import { artistPk, newId } from '../workspace/model.ts';
import { allContacts, upsertPerson } from '../address-book/store.ts';
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
const events = new EventBridgeClient({});
const today = () => new Date().toISOString().slice(0, 10);
const ID = /^[a-z0-9]{10,40}$/;

const gigVisibility = (g: Pick<Gig, 'shared'>) => (g.shared ? 'normal' : 'private');

function ensureArtist(principal: Principal, action: Action, artistId: string, g?: Gig) {
  const d = authorize(principal, action, {
    kind: 'artist-data',
    artistId,
    visibility: g ? gigVisibility(g) : 'normal',
  });
  if (!d.allow) throw new HttpError(403, d.reason);
}

/** Domain events for notifications (design 7.3); ids and titles only. */
async function domainEvent(type: string, detail: Record<string, unknown>) {
  await events.send(
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

function ensureBmg(principal: Principal) {
  if (principal.role === 'artist') throw new HttpError(403, 'Events are run by Blueprint');
}

function param(event: APIGatewayProxyEvent, name: string, pattern = ID): string {
  const v = event.pathParameters?.[name] ?? '';
  if (!pattern.test(v)) throw new HttpError(404, 'Not found');
  return v;
}

const artistParam = (event: APIGatewayProxyEvent) => {
  const id = event.pathParameters?.artistId;
  if (!isArtistId(id)) throw new HttpError(404, 'No such artist');
  return id;
};

function filterParam(event: APIGatewayProxyEvent): GigFilter {
  const f = event.queryStringParameters?.filter ?? 'upcoming';
  if (f !== 'upcoming' && f !== 'past' && f !== 'help') throw new HttpError(400, 'Unknown filter');
  return f;
}

/** Drops storage keys (and who created it) before an item leaves the API. */
function strip(item: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...item };
  for (const k of ['PK', 'SK', 'GSI3PK', 'GSI3SK', 'type', 'createdBy']) delete rest[k];
  return rest;
}
/** Older gigs kept one `time`; it's the start time. */
function publicGig(g: Gig) {
  const { time, ...rest } = g;
  // Set duration was removed from gigs (rev 7); old values stay stored but hidden.
  delete rest.setLength;
  return strip({ ...rest, ...(rest.startTime || !time ? {} : { startTime: time }) });
}

async function loadGig(artistId: string, gigId: string): Promise<Gig> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: gigSk(gigId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such gig');
  return res.Item as Gig;
}

async function saveGig(g: Gig, condition?: 'new') {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: artistPk(g.artistId),
        SK: gigSk(g.gigId),
        type: 'gig',
        ...g,
        // Only shared gigs appear in Blueprint's cross-artist list.
        ...(g.shared ? { GSI3PK: GIGS_GSI3PK, GSI3SK: gigGsi3Sk(g) } : {}),
      },
      ...(condition === 'new' ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
    }),
  );
}

async function loadEvent(eventId: string) {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: EVENTS_PK, SK: eventSk(eventId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such event');
  return res.Item;
}

async function eventParts(eventId: string) {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': eventPk(eventId) },
      Limit: 1000,
    }),
  );
  const parts = Object.fromEntries(EVENT_PARTS.map((p) => [p, [] as Record<string, unknown>[]]));
  for (const item of res.Items ?? []) {
    const part = item.part as EventPart;
    if (parts[part]) {
      parts[part]!.push(strip(item));
    }
  }
  (parts.run as { time: string }[]).sort(byTime);
  return parts as Record<EventPart, Record<string, unknown>[]>;
}

/**
 * Crew and volunteers go into Contacts (rev 7): each person is found by email
 * or phone, or added, and tagged Crew or Volunteer. Returns the people with
 * their contact ids, and the role's filled count.
 */
async function linkCrew(
  event: APIGatewayProxyEvent,
  principal: Principal,
  people: CrewPerson[],
): Promise<CrewPerson[]> {
  const known = await allContacts();
  const out: CrewPerson[] = [];
  for (const p of people) {
    const { contact, created } = await upsertPerson(
      { name: p.name, email: p.email, phone: p.phone, tag: crewTag(p) },
      { sub: principal.sub, role: 'bmg' },
      known,
    );
    if (created) {
      await audit(event, 'contact.create', 'success', {
        contactId: contact.contactId,
        from: 'event-crew',
      });
    }
    out.push({ ...p, contactId: contact.contactId });
  }
  return out;
}

function partParam(event: APIGatewayProxyEvent): EventPart {
  const p = event.pathParameters?.part as EventPart;
  if (!EVENT_PARTS.includes(p)) throw new HttpError(404, 'Not found');
  return p;
}

/** Artist gigs (with help requests) and BMG's events. */
export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const route = `${event.httpMethod} ${event.resource}`;
  const now = new Date().toISOString();

  switch (route) {
    // ── Gigs ──
    case 'GET /artists/{artistId}/gigs': {
      const artistId = artistParam(event);
      ensureArtist(principal, 'read', artistId);
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :g)',
          ExpressionAttributeValues: { ':pk': artistPk(artistId), ':g': 'GIG#' },
          Limit: 300,
        }),
      );
      const gigs = ((res.Items ?? []) as Gig[])
        .filter(
          (g) =>
            authorize(principal, 'read', {
              kind: 'artist-data',
              artistId,
              visibility: gigVisibility(g),
            }).allow,
        )
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(publicGig);
      return json(200, { gigs });
    }

    case 'POST /artists/{artistId}/gigs': {
      const artistId = artistParam(event);
      ensureArtist(principal, 'write', artistId);
      const body = parseBody(event, GigCreate);
      const timeError = checkTimes(body.startTime, body.endTime);
      if (timeError) throw new HttpError(400, timeError);
      const isArtist = principal.role === 'artist';
      const gig: Gig = {
        gigId: newId(),
        artistId,
        title: body.title,
        date: body.date,
        ...(body.startTime ? { startTime: body.startTime } : {}),
        ...(body.endTime ? { endTime: body.endTime } : {}),
        ...(body.venue ? { venue: body.venue } : {}),
        ...(body.venue && body.venueId ? { venueId: body.venueId } : {}),
        ...(body.notes ? { notes: body.notes } : {}),
        status: body.status,
        deal: body.deal,
        ...(dealNoteFor(body.deal, body.dealNote)
          ? { dealNote: dealNoteFor(body.deal, body.dealNote)! }
          : {}),
        ...(body.ticketUrl ? { ticketUrl: body.ticketUrl } : {}),
        checklist: DEFAULT_CHECKLIST.map((title, i) => ({ id: `c${i + 1}`, title, done: false })),
        plannedBy: isArtist ? 'artist' : 'bmg',
        // Gigs Blueprint adds are always shared.
        shared: isArtist ? body.shared : true,
        createdBy: principal.sub,
        createdAt: now,
      };
      await saveGig(gig, 'new');
      return json(201, publicGig(gig));
    }

    case 'PATCH /artists/{artistId}/gigs/{gigId}': {
      const artistId = artistParam(event);
      const gig = await loadGig(artistId, param(event, 'gigId'));
      ensureArtist(principal, 'write', artistId, gig);
      const patch = parseBody(event, GigPatch);
      const refused = gigPatchAllowed(principal.role, gig, patch);
      if (refused) throw new HttpError(403, refused);
      const { askHelp, helpDone, startTime, endTime, venueId, ...fields } = patch;
      const next: Gig = { ...gig, ...fields, updatedAt: now };
      if (venueId === null || (fields.venue !== undefined && !fields.venue)) delete next.venueId;
      else if (venueId !== undefined) next.venueId = venueId;
      // Move an older single `time` across as the start time.
      if (next.time && !next.startTime) next.startTime = next.time;
      delete next.time;
      if (startTime === null) delete next.startTime;
      else if (startTime !== undefined) next.startTime = startTime;
      if (endTime === null) delete next.endTime;
      else if (endTime !== undefined) next.endTime = endTime;
      const timeError = checkTimes(next.startTime, next.endTime);
      if (timeError) throw new HttpError(400, timeError);
      const note = dealNoteFor(next.deal, next.dealNote);
      if (note) next.dealNote = note;
      else delete next.dealNote;
      if (askHelp) next.help = { ...askHelp, askedAt: now, status: 'open' };
      if (helpDone && next.help) next.help = { ...next.help, status: 'done', doneAt: now };
      if (askHelp) next.shared = true; // asking for help shares the gig
      await saveGig(next);
      if (askHelp) {
        const profile = await db.send(
          new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: 'PROFILE' } }),
        );
        await domainEvent('gig.helpRequested', {
          artistId,
          gigId: gig.gigId,
          title: gig.title,
          topics: askHelp.topics,
          artistName: profile.Item?.displayName,
        });
      }
      return json(200, publicGig(next));
    }

    case 'GET /gigs': {
      ensureBmg(principal);
      const filter = filterParam(event);
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          IndexName: 'GSI3',
          KeyConditionExpression: 'GSI3PK = :pk',
          ExpressionAttributeValues: { ':pk': GIGS_GSI3PK },
          Limit: 500,
        }),
      );
      const gigs = ((res.Items ?? []) as Gig[])
        .filter(
          (g) =>
            authorize(principal, 'read', {
              kind: 'artist-data',
              artistId: g.artistId,
              visibility: gigVisibility(g),
            }).allow,
        )
        .filter((g) => gigMatches(g, filter, today()))
        .map(publicGig);
      return json(200, { gigs });
    }

    // ── Events (BMG only) ──
    case 'GET /events': {
      ensureBmg(principal);
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :e)',
          ExpressionAttributeValues: { ':pk': EVENTS_PK, ':e': 'EVENT#' },
          Limit: 200,
        }),
      );
      const events = (res.Items ?? [])
        .map(strip)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return json(200, { events });
    }

    case 'POST /events': {
      ensureBmg(principal);
      const body = parseBody(event, EventCreate);
      const eventId = newId();
      const item = { eventId, ...body, createdBy: principal.sub, createdAt: now };
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: { PK: EVENTS_PK, SK: eventSk(eventId), type: 'event', ...item },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return json(201, item);
    }

    case 'GET /events/{eventId}': {
      ensureBmg(principal);
      const eventId = param(event, 'eventId');
      const e = strip(await loadEvent(eventId));
      const parts = await eventParts(eventId);
      return json(200, {
        event: e,
        ...parts,
        summary: summarise(EventBody.parse(e), parts as never),
      });
    }

    case 'PATCH /events/{eventId}': {
      ensureBmg(principal);
      const eventId = param(event, 'eventId');
      const current = await loadEvent(eventId);
      const patch = parseBody(event, EventPatch);
      const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const next: Record<string, unknown> = {
        ...current,
        ...given,
        updatedAt: now,
        updatedBy: principal.sub,
      };
      // Older events can be saved without times, but once either is set both are needed.
      if ('startTime' in given || 'endTime' in given) {
        if (!next.startTime || !next.endTime)
          throw new HttpError(400, 'Events need a start and an end time');
        const timeError = checkTimes(String(next.startTime), String(next.endTime));
        if (timeError) throw new HttpError(400, timeError);
      }
      await db.send(new PutCommand({ TableName: table(), Item: next }));
      return json(200, { ok: true });
    }

    case 'POST /events/{eventId}/{part}': {
      ensureBmg(principal);
      const eventId = param(event, 'eventId');
      await loadEvent(eventId);
      const part = partParam(event);
      const body: Record<string, unknown> = parseBody(event, PART_SCHEMAS[part]);
      if (part === 'crew' && Array.isArray(body.people)) {
        body.people = await linkCrew(event, principal, body.people as CrewPerson[]);
        body.filled = (body.people as CrewPerson[]).length;
      }
      const itemId = randomUUID().replace(/-/g, '').slice(0, 20);
      const item = { itemId, part, ...body, createdAt: now };
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: { PK: eventPk(eventId), SK: partSk(part, itemId), ...item },
        }),
      );
      return json(201, item);
    }

    case 'PATCH /events/{eventId}/{part}/{itemId}': {
      ensureBmg(principal);
      const eventId = param(event, 'eventId');
      const part = partParam(event);
      const itemId = param(event, 'itemId', /^[a-z0-9]{20}$/);
      const patch = parseBody(event, patchOf(PART_SCHEMAS[part])) as Record<string, unknown>;
      if (part === 'crew' && Array.isArray(patch.people)) {
        patch.people = await linkCrew(event, principal, patch.people as CrewPerson[]);
        patch.filled = (patch.people as CrewPerson[]).length;
      }
      const sets = Object.keys(patch).filter(
        (k) => (patch as Record<string, unknown>)[k] !== undefined,
      );
      try {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: eventPk(eventId), SK: partSk(part, itemId) },
            UpdateExpression: `SET ${sets.map((k, i) => `#k${i} = :v${i}`).join(', ')}, updatedAt = :at`,
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeNames: Object.fromEntries(sets.map((k, i) => [`#k${i}`, k])),
            ExpressionAttributeValues: {
              ...Object.fromEntries(
                sets.map((k, i) => [`:v${i}`, (patch as Record<string, unknown>)[k]]),
              ),
              ':at': now,
            },
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') {
          throw new HttpError(404, 'Not found');
        }
        throw err;
      }
      return json(200, { ok: true });
    }

    case 'DELETE /events/{eventId}/{part}/{itemId}': {
      ensureBmg(principal);
      const eventId = param(event, 'eventId');
      const part = partParam(event);
      const itemId = param(event, 'itemId', /^[a-z0-9]{20}$/);
      await db.send(
        new DeleteCommand({
          TableName: table(),
          Key: { PK: eventPk(eventId), SK: partSk(part, itemId) },
        }),
      );
      return json(200, { ok: true });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
