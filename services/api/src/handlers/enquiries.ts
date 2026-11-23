import { createHash } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { authorize, type Principal } from '@bmg/authz';
import { isE2eEmail } from '@bmg/config/e2e';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  ActionBody,
  activitySk,
  applyAction,
  countryName,
  counts,
  dedupeSk,
  DEDUPE_WINDOW_SECONDS,
  ENQUIRIES_PK,
  EnquiryBody,
  EnquiryPatch,
  enquirySk,
  firstName,
  isCountry,
  looksLikeABot,
  MAX_SENDS_PER_DAY,
  NoteBody,
  noteSk,
  RuleError,
  SENDS_PER_IP_PER_HOUR,
  summaryOf,
  type ActivityItem,
  type Change,
  type EnquiryDetail,
  type EnquiryItem,
  type EnquiryPrivate,
  type NoteItem,
} from '../enquiries/model.ts';
import { open, seal } from '../enquiries/seal.ts';
import { namesFor } from '../files/people.ts';
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
  publish,
} from '../lib.ts';
import { artistPk, newId, PROFILE_SK } from '../workspace/model.ts';

/**
 * Consultation requests (rev 21), on their own API (the enquiries stack):
 *
 *   POST   /public/enquiries            the public form (no sign-in; WAF CAPTCHA in front)
 *   GET    /enquiries                   every request (?summary=1: counts only)
 *   GET    /enquiries/{id}              one request, its notes and what happened
 *   PATCH  /enquiries/{id}              Edit details (contact details only)
 *   DELETE /enquiries/{id}              admins, with a fresh sign-in
 *   POST   /enquiries/{id}/actions      pick up, hand back, take over, convert, close, reopen
 *   POST   /enquiries/{id}/notes        a note for the team
 *
 * Only the Blueprint team can use the /enquiries routes. Personal details are
 * sealed (../enquiries/seal.ts) and never logged.
 */

const sqs = new SQSClient({});
const table = () => env('MAIN_TABLE');

// ── Public form ─────────────────────────────────────────────────────────────
/** CloudFront passes the viewer's address on; only a hash of it is kept (with a TTL). */
function clientIp(e: APIGatewayProxyEvent): string {
  const h = Object.fromEntries(
    Object.entries(e.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return (
    h['cloudfront-viewer-address']?.replace(/:\d+$/, '') ??
    h['x-forwarded-for']?.split(',')[0]?.trim() ??
    e.requestContext.identity?.sourceIp ??
    'unknown'
  );
}

async function underLimit(ip: string): Promise<boolean> {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = createHash('sha256').update(`enquiry:${ip}:${hour}`).digest('hex');
  const res = await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: 'RATE#enquiry', SK: key },
      UpdateExpression: 'ADD n :one SET #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': (hour + 2) * 3600 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(res.Attributes?.n ?? 0) <= SENDS_PER_IP_PER_HOUR;
}

/** A one-way, environment-scoped hash of the address, kept for a day to spot repeat sends. */
const emailHash = (email: string) =>
  createHash('sha256')
    .update(`bmg-enquiry:${env('BMG_ENV')}:${email.trim().toLowerCase()}`)
    .digest('hex');

const activityItem = (
  enquiryId: string,
  at: string,
  a: Omit<ActivityItem, 'actId' | 'enquiryId' | 'at'>,
  ttl?: number,
) => {
  const actId = newId(Date.parse(at));
  return {
    PK: ENQUIRIES_PK,
    SK: activitySk(enquiryId, actId),
    type: 'enquiryActivity',
    actId,
    enquiryId,
    at,
    ...a,
    ...(ttl ? { ttl } : {}),
  };
};

/** "Thanks, we've got your request": no copy of what they wrote. */
async function acknowledge(to: string, name: string) {
  if (!process.env.MAIL_QUEUE_URL || isE2eEmail(to)) return;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: env('MAIL_QUEUE_URL'),
      MessageBody: JSON.stringify({ to, enquiryAck: { firstName: firstName(name) } }),
    }),
  );
}

async function submit(event: APIGatewayProxyEvent) {
  const body = parseBody(event, EnquiryBody);
  const ok = json(200, { ok: true, firstName: firstName(body.name) });
  // Bots get the same answer, and nothing is kept.
  if (looksLikeABot(body)) {
    console.log(JSON.stringify({ level: 'info', event: 'enquiry.discarded' }));
    return ok;
  }
  if (!(await underLimit(clientIp(event))))
    throw new HttpError(429, 'Too many requests from here. Try again in an hour.');
  if (!isCountry(body.country)) throw new HttpError(400, 'Choose your country.');

  const now = new Date();
  const at = now.toISOString();
  const nowS = Math.floor(now.getTime() / 1000);
  const email = body.email.toLowerCase();
  const details: EnquiryPrivate = {
    name: body.name,
    email,
    ...(body.phone ? { phone: body.phone } : {}),
    aboutMe: body.aboutMe,
    howCanWeHelp: body.howCanWeHelp,
  };

  // The same address again within a day: added to their first request.
  const dedupeKey = { PK: ENQUIRIES_PK, SK: dedupeSk(emailHash(email)) };
  const seen = (await db.send(new GetCommand({ TableName: table(), Key: dedupeKey }))).Item as
    { enquiryId: string; sends: number; ttl: number } | undefined;
  if (seen && seen.ttl > nowS) {
    if (seen.sends >= MAX_SENDS_PER_DAY) return ok;
    const enquiry = (
      await db.send(
        new GetCommand({
          TableName: table(),
          Key: { PK: ENQUIRIES_PK, SK: enquirySk(seen.enquiryId) },
        }),
      )
    ).Item as EnquiryItem | undefined;
    if (enquiry) {
      const noteId = newId(now.getTime());
      const text = [
        'They sent the form again.',
        `About them: ${body.aboutMe}`,
        `How Blueprint can help: ${body.howCanWeHelp}`,
        ...(body.phone ? [`Mobile: ${body.phone}`] : []),
      ].join('\n\n');
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            PK: ENQUIRIES_PK,
            SK: noteSk(enquiry.enquiryId, noteId),
            type: 'enquiryNote',
            noteId,
            enquiryId: enquiry.enquiryId,
            bySub: 'public',
            at,
            sealed: await seal(enquiry.enquiryId, `note:${noteId}`, text),
            ...(enquiry.ttl ? { ttl: enquiry.ttl } : {}),
          },
        }),
      );
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: activityItem(enquiry.enquiryId, at, { kind: 'sentAgain' }, enquiry.ttl),
        }),
      );
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: ENQUIRIES_PK, SK: enquirySk(enquiry.enquiryId) },
          UpdateExpression:
            'SET resends = if_not_exists(resends, :zero) + :one, updatedAt = :at, version = version + :one',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':at': at },
        }),
      );
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: dedupeKey,
          UpdateExpression: 'SET sends = sends + :one',
          ExpressionAttributeValues: { ':one': 1 },
        }),
      );
      console.log(JSON.stringify({ level: 'info', event: 'enquiry.sentAgain' }));
      return ok;
    }
  }

  const enquiryId = newId(now.getTime());
  const item: EnquiryItem & { PK: string; SK: string; type: string } = {
    PK: ENQUIRIES_PK,
    SK: enquirySk(enquiryId),
    type: 'enquiry',
    enquiryId,
    status: 'open',
    country: body.country,
    receivedAt: at,
    updatedAt: at,
    version: 1,
    sealed: await seal(enquiryId, 'details', details),
  };
  await db.send(new PutCommand({ TableName: table(), Item: item }));
  await db.send(
    new PutCommand({ TableName: table(), Item: activityItem(enquiryId, at, { kind: 'received' }) }),
  );
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: { ...dedupeKey, enquiryId, sends: 1, ttl: nowS + DEDUPE_WINDOW_SECONDS },
    }),
  );
  // Names, never the answers: the notifier words "New consultation request from …".
  await publish('enquiry.received', {
    enquiryId,
    name: body.name,
    countryName: countryName(body.country),
    ...(isE2eEmail(email) ? { test: true } : {}),
  });
  await acknowledge(email, body.name);
  console.log(JSON.stringify({ level: 'info', event: 'enquiry.received', country: body.country }));
  return ok;
}

// ── The Blueprint team ──────────────────────────────────────────────────────
const isBmg = (p: Principal) => p.role === 'bmg-admin' || p.role === 'bmg-staff';

async function getEnquiry(id: string): Promise<EnquiryItem> {
  if (!/^[a-z0-9]{12,40}$/.test(id)) throw new HttpError(404, 'No such request');
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: ENQUIRIES_PK, SK: enquirySk(id) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such request');
  return res.Item as EnquiryItem;
}

/** Every item under the enquiries partition with this SK prefix. */
async function queryAll<T>(prefix: string, filterType?: string): Promise<T[]> {
  const out: T[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ...(filterType
          ? {
              FilterExpression: '#type = :type',
              ExpressionAttributeNames: { '#type': 'type' },
            }
          : {}),
        ExpressionAttributeValues: {
          ':pk': ENQUIRIES_PK,
          ':p': prefix,
          ...(filterType ? { ':type': filterType } : {}),
        },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    out.push(...((res.Items ?? []) as T[]));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** At most `n` at a time, so a long list doesn't flood KMS. */
async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const j = i++;
        out[j] = await f(xs[j]!);
      }
    }),
  );
  return out;
}

async function names(subs: (string | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(subs.filter((s): s is string => !!s && s !== 'public'))];
  const people = await namesFor(wanted);
  return new Map([...people].map(([sub, p]) => [sub, p.displayName]));
}

async function list(principal: Principal, summaryOnly: boolean) {
  const items = await queryAll<EnquiryItem>('ENQ#', 'enquiry');
  if (summaryOnly) return json(200, counts(items, principal.sub, new Date()));
  const who = await names(items.map((e) => e.ownerSub));
  const enquiries = await mapLimit(items, 10, async (e) => {
    const p = await open<EnquiryPrivate>(e.enquiryId, 'details', e.sealed);
    return summaryOf(e, p, e.ownerSub ? who.get(e.ownerSub) : undefined);
  });
  enquiries.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return json(200, { enquiries });
}

async function detail(id: string): Promise<EnquiryDetail> {
  const e = await getEnquiry(id);
  const children = await queryAll<Record<string, unknown>>(`${enquirySk(id)}#`);
  const noteItems = children.filter((c) => c.type === 'enquiryNote') as unknown as NoteItem[];
  const acts = children.filter((c) => c.type === 'enquiryActivity') as unknown as ActivityItem[];
  const who = await names([
    e.ownerSub,
    ...noteItems.map((n) => n.bySub),
    ...acts.flatMap((a) => [a.bySub, a.fromSub]),
  ]);
  const p = await open<EnquiryPrivate>(id, 'details', e.sealed);
  const notes = await mapLimit(noteItems, 10, async (n) => ({
    noteId: n.noteId,
    bySub: n.bySub,
    byName: n.bySub === 'public' ? p.name : (who.get(n.bySub) ?? 'A former team member'),
    at: n.at,
    text: await open<string>(id, `note:${n.noteId}`, n.sealed),
  }));
  notes.sort((a, b) => b.at.localeCompare(a.at));
  const activity = acts
    .map((a) => ({
      actId: a.actId,
      enquiryId: a.enquiryId,
      kind: a.kind,
      at: a.at,
      ...(a.bySub ? { bySub: a.bySub, byName: who.get(a.bySub) ?? 'A former team member' } : {}),
      ...(a.fromSub ? { fromSub: a.fromSub, fromName: who.get(a.fromSub) ?? 'someone' } : {}),
      ...(a.artistId ? { artistId: a.artistId } : {}),
      ...(a.reason ? { reason: a.reason } : {}),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  return {
    ...summaryOf(e, p, e.ownerSub ? who.get(e.ownerSub) : undefined),
    ...(p.phone ? { phone: p.phone } : {}),
    aboutMe: p.aboutMe,
    howCanWeHelp: p.howCanWeHelp,
    ...(e.pickedUpAt ? { pickedUpAt: e.pickedUpAt } : {}),
    ...(e.convertedAt ? { convertedAt: e.convertedAt } : {}),
    ...(e.closedAt ? { closedAt: e.closedAt } : {}),
    notes,
    activity,
  };
}

/** Writes a change, only if nobody else changed the request since it was read. */
async function commit(e: EnquiryItem, change: Change, at: string): Promise<void> {
  const attr: Record<string, string> = { '#s': 'status', '#v': 'version', '#u': 'updatedAt' };
  const values: Record<string, unknown> = {
    ':v': e.version,
    ':s': e.status,
    ':one': 1,
    ':at': at,
  };
  const sets = ['#v = #v + :one', '#u = :at'];
  Object.entries(change.set).forEach(([k, v], i) => {
    attr[`#f${i}`] = k;
    values[`:f${i}`] = v;
    sets.push(`#f${i} = :f${i}`);
  });
  const removes = change.remove
    .filter((k) => !(k in change.set))
    .map((k, i) => {
      attr[`#r${i}`] = k;
      return `#r${i}`;
    });
  try {
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: ENQUIRIES_PK, SK: enquirySk(e.enquiryId) },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: '#v = :v AND #s = :s',
        ExpressionAttributeNames: attr,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException')
      throw new HttpError(409, 'stale');
    throw err;
  }
}

/** Notes and activity are deleted with the request: they carry the same TTL. */
async function retime(id: string, ttl: number | undefined) {
  const children = await queryAll<{ PK: string; SK: string }>(`${enquirySk(id)}#`);
  await mapLimit(children, 5, (c) =>
    db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: c.PK, SK: c.SK },
        UpdateExpression: ttl ? 'SET #ttl = :ttl' : 'REMOVE #ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ...(ttl ? { ExpressionAttributeValues: { ':ttl': ttl } } : {}),
      }),
    ),
  );
}

async function act(event: APIGatewayProxyEvent, principal: Principal, id: string) {
  const action = parseBody(event, ActionBody);
  const actor = { sub: principal.sub, admin: principal.role === 'bmg-admin' };
  if (action.kind === 'convert') {
    const artist = await db.send(
      new GetCommand({
        TableName: table(),
        Key: { PK: artistPk(action.artistId), SK: PROFILE_SK },
      }),
    );
    if (!artist.Item) throw new HttpError(400, 'That artist isn’t in the app.');
  }
  // Two tries: a request changed by someone else a moment ago is read again,
  // so the answer says what happened ("Sam picked this up a moment ago").
  for (let attempt = 0; ; attempt++) {
    const e = await getEnquiry(id);
    const now = new Date();
    const at = now.toISOString();
    const ownerName = e.ownerSub
      ? ((await names([e.ownerSub])).get(e.ownerSub) ?? 'Someone')
      : undefined;
    let change: Change;
    try {
      change = applyAction(e, action, actor, now, ownerName);
    } catch (err) {
      if (err instanceof RuleError) {
        await audit(event, `enquiry.${action.kind}`, 'denied', { enquiryId: id });
        throw new HttpError(err.status, err.message);
      }
      throw err;
    }
    try {
      await commit(e, change, at);
    } catch (err) {
      if (err instanceof HttpError && err.message === 'stale' && attempt === 0) continue;
      if (err instanceof HttpError && err.message === 'stale')
        throw new HttpError(409, 'This request changed a moment ago. Have another look.');
      throw err;
    }
    const ttl =
      'ttl' in change.set ? change.set.ttl : change.remove.includes('ttl') ? undefined : e.ttl;
    await db.send(
      new PutCommand({ TableName: table(), Item: activityItem(id, at, change.activity, ttl) }),
    );
    if (ttl !== e.ttl) await retime(id, ttl);
    await audit(event, `enquiry.${action.kind}`, 'success', {
      enquiryId: id,
      ...(action.kind === 'convert' ? { artistId: action.artistId } : {}),
      ...(action.kind === 'close' ? { reason: action.reason } : {}),
    });

    const p = await open<EnquiryPrivate>(id, 'details', e.sealed);
    const byName = (await names([principal.sub])).get(principal.sub) ?? 'Someone at Blueprint';
    const test = isE2eEmail(p.email) ? { test: true } : {};
    if (action.kind === 'pick-up' || action.kind === 'reopen') {
      await publish('enquiry.pickedUp', {
        enquiryId: id,
        bySub: principal.sub,
        byName,
        name: p.name,
        ...test,
      });
    }
    if (action.kind === 'take-over' && e.ownerSub) {
      await publish('enquiry.takenOver', {
        enquiryId: id,
        fromSub: e.ownerSub,
        bySub: principal.sub,
        byName,
        name: p.name,
        ...test,
      });
    }
    return json(200, await detail(id));
  }
}

async function addNote(event: APIGatewayProxyEvent, principal: Principal, id: string) {
  const { text } = parseBody(event, NoteBody);
  const e = await getEnquiry(id);
  const at = new Date().toISOString();
  const noteId = newId();
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: ENQUIRIES_PK,
        SK: noteSk(id, noteId),
        type: 'enquiryNote',
        noteId,
        enquiryId: id,
        bySub: principal.sub,
        at,
        sealed: await seal(id, `note:${noteId}`, text),
        ...(e.ttl ? { ttl: e.ttl } : {}),
      },
    }),
  );
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: { PK: ENQUIRIES_PK, SK: enquirySk(id) },
      UpdateExpression: 'SET updatedAt = :at',
      ExpressionAttributeValues: { ':at': at },
    }),
  );
  return json(201, await detail(id));
}

async function edit(event: APIGatewayProxyEvent, id: string) {
  const patch = parseBody(event, EnquiryPatch);
  if (patch.country && !isCountry(patch.country)) throw new HttpError(400, 'Choose a country.');
  const e = await getEnquiry(id);
  const p = await open<EnquiryPrivate>(id, 'details', e.sealed);
  const next: EnquiryPrivate = {
    ...p,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.email ? { email: patch.email.toLowerCase() } : {}),
  };
  if (patch.phone === null) delete next.phone;
  else if (patch.phone) next.phone = patch.phone;
  const at = new Date().toISOString();
  await commit(
    e,
    {
      set: {
        sealed: await seal(id, 'details', next),
        ...(patch.country ? { country: patch.country } : {}),
      },
      remove: [],
      activity: { kind: 'edited' },
    },
    at,
  ).catch((err: unknown) => {
    if (err instanceof HttpError && err.message === 'stale')
      throw new HttpError(409, 'This request changed a moment ago. Have another look.');
    throw err;
  });
  const principal = authContext(event);
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: activityItem(id, at, { kind: 'edited', bySub: principal.sub }, e.ttl),
    }),
  );
  await audit(event, 'enquiry.edited', 'success', { enquiryId: id });
  return json(200, await detail(id));
}

async function remove(event: APIGatewayProxyEvent, principal: Principal, id: string) {
  const decision = authorize(principal, 'admin', { kind: 'org-admin' });
  if (!decision.allow) {
    await audit(event, 'enquiry.deleted', 'denied', { enquiryId: id });
    throw new HttpError(403, decision.reason);
  }
  await getEnquiry(id);
  const children = await queryAll<{ PK: string; SK: string }>(`${enquirySk(id)}#`);
  await mapLimit(children, 5, (c) =>
    db.send(new DeleteCommand({ TableName: table(), Key: { PK: c.PK, SK: c.SK } })),
  );
  await db.send(
    new DeleteCommand({ TableName: table(), Key: { PK: ENQUIRIES_PK, SK: enquirySk(id) } }),
  );
  await audit(event, 'enquiry.deleted', 'success', { enquiryId: id });
  return json(200, { ok: true });
}

export const handler = handle(async (event: APIGatewayProxyEvent) => {
  const path = (event.path ?? '').replace(/\/+$/, '');
  const method = event.httpMethod;
  if (path === '/public/enquiries') {
    if (method !== 'POST') throw new HttpError(404, 'Not found');
    return submit(event);
  }

  const principal = await principalFor(authContext(event));
  if (!isBmg(principal)) {
    await audit(event, 'enquiry.read', 'denied', {});
    throw new HttpError(403, 'Consultation requests are for the Blueprint team.');
  }
  if (!principal.mfaSatisfied) throw new HttpError(403, 'two-step verification required');

  const m = /^\/enquiries(?:\/([a-z0-9]+))?(?:\/(actions|notes))?$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const [, id, sub] = m;
  if (!id) {
    if (method !== 'GET') throw new HttpError(404, 'Not found');
    return list(principal, event.queryStringParameters?.summary === '1');
  }
  if (sub === 'actions' && method === 'POST') return act(event, principal, id);
  if (sub === 'notes' && method === 'POST') return addNote(event, principal, id);
  if (sub) throw new HttpError(404, 'Not found');
  if (method === 'GET') return json(200, await detail(id));
  if (method === 'PATCH') return edit(event, id);
  if (method === 'DELETE') return remove(event, principal, id);
  throw new HttpError(404, 'Not found');
});
