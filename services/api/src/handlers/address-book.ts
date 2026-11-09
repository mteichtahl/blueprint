import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { authorize, type Action, type Principal } from '@bmg/authz';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  applyContactPatch,
  byName,
  cleanTags,
  ContactBody,
  contactFor,
  contactMatches,
  ContactPatch,
  CONTACT_TAGS,
  CONTACTS_PK,
  contactSk,
  findDuplicate,
  fullName,
  applyVenuePatch,
  findDuplicateVenue,
  VenueBody,
  venueFor,
  venueMatches,
  VenuePatch,
  VENUES_PK,
  venueSk,
  venuesUsing,
  type Contact,
  type ContactPatchInput,
  type Venue,
  type VenueFilter,
  type VenuePatchInput,
} from '../address-book/model.ts';
import { newId } from '../workspace/model.ts';
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
const ID = /^[a-z0-9]{10,40}$/;
const isBmg = (p: Principal) => p.role === 'bmg-admin' || p.role === 'bmg-staff';

/**
 * `GET /contacts/abc123` → `{ route: 'GET /contacts/:id', id: 'abc123' }`.
 * Contacts (and venues) sit under proxy resources to keep the API stack small.
 */
export function routeOf(method: string, path: string): { route: string; id: string } {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  const shape = parts.map((p, i) => (i === 1 ? ':id' : p));
  return { route: `${method} /${shape.join('/')}`, id: parts[1] ?? '' };
}

function ensure(principal: Principal, action: Action, createdBySub?: string) {
  const d = authorize(principal, action, {
    kind: 'address-book',
    ...(createdBySub !== undefined ? { createdBySub } : {}),
  });
  if (!d.allow) throw new HttpError(403, d.reason);
}

function idParam(id: string): string {
  if (!ID.test(id)) throw new HttpError(404, 'Not found');
  return id;
}

async function allContacts(): Promise<Contact[]> {
  const items: Contact[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
        ExpressionAttributeValues: { ':pk': CONTACTS_PK, ':c': 'CONTACT#' },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    items.push(...((res.Items ?? []) as Contact[]));
    start = res.LastEvaluatedKey;
  } while (start && items.length < 5000);
  return items;
}

async function allVenues(): Promise<Venue[]> {
  const items: Venue[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :v)',
        ExpressionAttributeValues: { ':pk': VENUES_PK, ':v': 'VENUE#' },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    items.push(...((res.Items ?? []) as Venue[]));
    start = res.LastEvaluatedKey;
  } while (start && items.length < 5000);
  return items;
}

async function loadVenue(id: string): Promise<Venue> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: VENUES_PK, SK: venueSk(id) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such venue');
  return res.Item as Venue;
}

async function saveVenue(v: Venue, condition?: 'new' | 'exists') {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: { PK: VENUES_PK, SK: venueSk(v.venueId), type: 'venue', ...v },
      ...(condition === 'new' ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
      ...(condition === 'exists' ? { ConditionExpression: 'attribute_exists(PK)' } : {}),
    }),
  );
}

/** The manager and booker must be real, current contacts. */
async function checkContacts(ids: (string | null | undefined)[]): Promise<Map<string, Contact>> {
  const contacts = new Map((await allContacts()).map((c) => [c.contactId, c]));
  for (const id of ids) {
    if (id && (!contacts.has(id) || contacts.get(id)!.archived))
      throw new HttpError(400, 'Pick the manager and booker from contacts');
  }
  return contacts;
}

function venueFilter(event: APIGatewayProxyEvent): VenueFilter {
  const qs = event.queryStringParameters ?? {};
  const num = (v: string | undefined) => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Capacity must be a number');
    return n;
  };
  const min = num(qs.minCapacity);
  const max = num(qs.maxCapacity);
  return {
    q: qs.q ?? '',
    ...(min !== undefined ? { minCapacity: min } : {}),
    ...(max !== undefined ? { maxCapacity: max } : {}),
    ...(qs.backline === 'yes'
      ? { backline: true }
      : qs.backline === 'no'
        ? { backline: false }
        : {}),
  };
}

function duplicateVenue(existing: Venue, principal: Principal, contacts: Map<string, Contact>) {
  return json(409, {
    title: 'Already in venues',
    detail: `${existing.name} is already in venues.`,
    existing: venueFor(existing, isBmg(principal), existing.createdBy === principal.sub, contacts),
  });
}

async function loadContact(id: string): Promise<Contact> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: CONTACTS_PK, SK: contactSk(id) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such contact');
  return res.Item as Contact;
}

async function saveContact(c: Contact, condition?: 'new' | 'exists') {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: { PK: CONTACTS_PK, SK: contactSk(c.contactId), type: 'contact', ...c },
      ...(condition === 'new' ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
      ...(condition === 'exists' ? { ConditionExpression: 'attribute_exists(PK)' } : {}),
    }),
  );
}

/** A 409 that hands back the existing person, so the caller can pick them instead. */
function duplicate(existing: Contact, principal: Principal) {
  return json(409, {
    title: 'Already in contacts',
    detail: `${fullName(existing)} is already in contacts with that email or phone.`,
    existing: contactFor(existing, isBmg(principal), existing.createdBy === principal.sub),
  });
}

/** Contacts and venues: the shared address book (rev 7). */
export const handler = handle(async (event: APIGatewayProxyEvent) => {
  const principal = await principalFor(authContext(event));
  const { route, id } = routeOf(event.httpMethod, event.path ?? '');
  const bmg = isBmg(principal);
  const now = new Date().toISOString();

  switch (route) {
    case 'GET /contacts': {
      ensure(principal, 'read');
      const q = event.queryStringParameters?.q ?? '';
      const tag = event.queryStringParameters?.tag || undefined;
      const withArchived = bmg && event.queryStringParameters?.archived === 'true';
      const contacts = (await allContacts())
        .filter((c) => withArchived || !c.archived)
        .filter((c) => contactMatches(c, q, tag))
        .sort(byName)
        .map((c) => contactFor(c, bmg, c.createdBy === principal.sub));
      return json(200, { contacts, tags: CONTACT_TAGS });
    }

    case 'POST /contacts': {
      ensure(principal, 'write');
      const body = parseBody(event, ContactBody);
      const existing = findDuplicate(await allContacts(), body);
      if (existing) return duplicate(existing, principal);
      const contact: Contact = {
        ...body,
        tags: cleanTags(body.tags),
        bmgNotes: bmg ? body.bmgNotes : '',
        contactId: newId(),
        createdBy: principal.sub,
        createdByRole: bmg ? 'bmg' : 'artist',
        createdAt: now,
      };
      await saveContact(contact, 'new');
      await audit(event, 'contact.create', 'success', { contactId: contact.contactId });
      return json(201, contactFor(contact, bmg, true));
    }

    case 'GET /contacts/:id': {
      ensure(principal, 'read');
      const c = await loadContact(idParam(id));
      if (c.archived && !bmg) throw new HttpError(404, 'No such contact');
      return json(200, contactFor(c, bmg, c.createdBy === principal.sub));
    }

    case 'PATCH /contacts/:id': {
      const existing = await loadContact(idParam(id));
      ensure(principal, 'write', existing.createdBy);
      const patch = parseBody(event, ContactPatch) as ContactPatchInput;
      if (patch.archived !== undefined && !bmg)
        throw new HttpError(403, 'Only Blueprint archives contacts');
      const next = applyContactPatch(existing, patch, bmg);
      if (patch.email !== undefined || patch.phone !== undefined) {
        const dup = findDuplicate(await allContacts(), next, existing.contactId);
        if (dup) return duplicate(dup, principal);
      }
      const saved: Contact = { ...next, updatedAt: now, updatedBy: principal.sub };
      await saveContact(saved, 'exists');
      await audit(event, 'contact.update', 'success', {
        contactId: saved.contactId,
        fields: Object.keys(patch).join(','),
      });
      return json(200, contactFor(saved, bmg, saved.createdBy === principal.sub));
    }

    case 'DELETE /contacts/:id': {
      if (!bmg) throw new HttpError(403, 'Only Blueprint removes contacts');
      const existing = await loadContact(idParam(id));
      const inUse = venuesUsing(await allVenues(), existing.contactId);
      if (inUse.length)
        throw new HttpError(
          409,
          `${fullName(existing)} is the manager or booker for ${inUse.map((v) => v.name).join(', ')}. Archive them instead, or change the venue first.`,
        );
      await db.send(
        new DeleteCommand({
          TableName: table(),
          Key: { PK: CONTACTS_PK, SK: contactSk(existing.contactId) },
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      await audit(event, 'contact.delete', 'success', { contactId: existing.contactId });
      return json(200, { deleted: existing.contactId });
    }

    // ── Venues ──
    case 'GET /venues': {
      ensure(principal, 'read');
      const f = venueFilter(event);
      const withArchived = bmg && event.queryStringParameters?.archived === 'true';
      const [venues, contacts] = await Promise.all([allVenues(), allContacts()]);
      const byId = new Map(contacts.map((c) => [c.contactId, c]));
      return json(200, {
        venues: venues
          .filter((v) => withArchived || !v.archived)
          .filter((v) => venueMatches(v, f))
          .sort((a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }))
          .map((v) => venueFor(v, bmg, v.createdBy === principal.sub, byId)),
      });
    }

    case 'POST /venues': {
      ensure(principal, 'write');
      const body = parseBody(event, VenueBody);
      const contacts = await checkContacts([body.managerContactId, body.bookerContactId]);
      const existing = findDuplicateVenue(await allVenues(), body);
      if (existing) return duplicateVenue(existing, principal, contacts);
      const venue: Venue = {
        ...body,
        bmgNotes: bmg ? body.bmgNotes : '',
        venueId: newId(),
        createdBy: principal.sub,
        createdByRole: bmg ? 'bmg' : 'artist',
        createdAt: now,
      };
      await saveVenue(venue, 'new');
      await audit(event, 'venue.create', 'success', { venueId: venue.venueId });
      return json(201, venueFor(venue, bmg, true, contacts));
    }

    case 'GET /venues/:id': {
      ensure(principal, 'read');
      const v = await loadVenue(idParam(id));
      if (v.archived && !bmg) throw new HttpError(404, 'No such venue');
      const contacts = new Map((await allContacts()).map((c) => [c.contactId, c]));
      return json(200, venueFor(v, bmg, v.createdBy === principal.sub, contacts));
    }

    case 'PATCH /venues/:id': {
      const existing = await loadVenue(idParam(id));
      ensure(principal, 'write', existing.createdBy);
      const patch = parseBody(event, VenuePatch) as VenuePatchInput;
      if (patch.archived !== undefined && !bmg)
        throw new HttpError(403, 'Only Blueprint archives venues');
      const next = applyVenuePatch(existing, patch, bmg);
      const contacts = await checkContacts([
        patch.managerContactId !== undefined ? next.managerContactId : null,
        patch.bookerContactId !== undefined ? next.bookerContactId : null,
      ]);
      if (patch.name !== undefined || patch.suburb !== undefined) {
        const dup = findDuplicateVenue(await allVenues(), next, existing.venueId);
        if (dup) return duplicateVenue(dup, principal, contacts);
      }
      const saved: Venue = { ...next, updatedAt: now, updatedBy: principal.sub };
      await saveVenue(saved, 'exists');
      await audit(event, 'venue.update', 'success', {
        venueId: saved.venueId,
        fields: Object.keys(patch).join(','),
      });
      return json(200, venueFor(saved, bmg, saved.createdBy === principal.sub, contacts));
    }

    case 'DELETE /venues/:id': {
      if (!bmg) throw new HttpError(403, 'Only Blueprint removes venues');
      const existing = await loadVenue(idParam(id));
      await db.send(
        new DeleteCommand({
          TableName: table(),
          Key: { PK: VENUES_PK, SK: venueSk(existing.venueId) },
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      await audit(event, 'venue.delete', 'success', { venueId: existing.venueId });
      return json(200, { deleted: existing.venueId });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
