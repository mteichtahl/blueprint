import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Meetings through the API against an in-memory table and bucket: starting
 * one needs consent, only Blueprint (and only assigned staff) can open them,
 * the recording is filed in Meetings › year › month as BMG only, and content
 * edits refuse a stale version.
 */

const items = new Map<string, Record<string, unknown>>();
/** Event types put on the bus (to check nothing asks for a transcript). */
const sent: string[] = [];
const objects = new Map<string, string>();
const key = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;

vi.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: async (_: unknown, p: { Key: string }) => ({
    url: 'https://quarantine.example',
    fields: { key: p.Key },
  }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => 'https://signed' }));
vi.mock('../src/files/people.ts', () => ({
  namesFor: async () => new Map(),
  people: async () => [],
}));

vi.mock('@aws-sdk/client-s3', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-s3')>();
  class S3Client {
    async send(cmd: {
      constructor: { name: string };
      input: { Bucket: string; Key: string; Body?: unknown };
    }) {
      const k = `${cmd.input.Bucket}/${cmd.input.Key}`;
      switch (cmd.constructor.name) {
        case 'PutObjectCommand':
          objects.set(k, String(cmd.input.Body));
          return {};
        case 'GetObjectCommand': {
          const body = objects.get(k);
          if (body === undefined) throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
          return { Body: { transformToString: async () => body } };
        }
        case 'DeleteObjectCommand':
          objects.delete(k);
          return {};
      }
      return {};
    }
  }
  return { ...real, S3Client };
});

vi.mock('@bmg/crypto', async (orig) => {
  const real = await orig<typeof import('@bmg/crypto')>();
  class DataAccessSessions {
    async credentials() {
      return { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c' };
    }
  }
  return { ...real, DataAccessSessions };
});

vi.mock('@aws-sdk/client-eventbridge', async (orig) => {
  const real = await orig<typeof import('@aws-sdk/client-eventbridge')>();
  class EventBridgeClient {
    async send(cmd: { input: { Entries?: { DetailType?: string }[] } }) {
      for (const e of cmd.input.Entries ?? []) sent.push(e.DetailType ?? '');
      return {};
    }
  }
  return { ...real, EventBridgeClient };
});

vi.mock('../src/lib.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib.ts')>();
  const cond = () => Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
  const db = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const i = cmd.input as {
        Key: { PK: string; SK: string };
        Item: Record<string, unknown> & { PK: string; SK: string };
        IndexName?: string;
        UpdateExpression?: string;
        ConditionExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
      };
      switch (cmd.constructor.name) {
        case 'GetCommand': {
          const it = items.get(key(i.Key));
          return { Item: it ? structuredClone(it) : undefined };
        }
        case 'PutCommand':
          if (i.ConditionExpression?.includes('attribute_not_exists') && items.has(key(i.Item)))
            throw cond();
          items.set(key(i.Item), structuredClone(i.Item));
          return {};
        case 'DeleteCommand':
          items.delete(key(i.Key));
          return {};
        case 'BatchGetCommand': {
          const req = (
            cmd.input as { RequestItems: Record<string, { Keys: { PK: string; SK: string }[] }> }
          ).RequestItems;
          const [table, { Keys }] = Object.entries(req)[0]!;
          return {
            Responses: { [table]: Keys.map((k) => items.get(key(k))).filter(Boolean) },
          };
        }
        case 'TransactWriteCommand': {
          const tx = (
            cmd.input as {
              TransactItems: {
                Put: {
                  Item: Record<string, unknown> & { PK: string; SK: string };
                  ConditionExpression?: string;
                  ExpressionAttributeValues?: Record<string, unknown>;
                };
              }[];
            }
          ).TransactItems;
          for (const { Put } of tx) {
            const cur = items.get(key(Put.Item));
            if (Put.ConditionExpression === 'attribute_not_exists(PK)' && cur) throw cond();
            if (
              Put.ConditionExpression === 'version = :v' &&
              cur?.version !== Put.ExpressionAttributeValues?.[':v']
            )
              throw Object.assign(new Error('tx'), {
                name: 'TransactionCanceledException',
                CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
              });
          }
          for (const { Put } of tx) items.set(key(Put.Item), structuredClone(Put.Item));
          return {};
        }
        case 'UpdateCommand': {
          const it = items.get(key(i.Key));
          const names = i.ExpressionAttributeNames ?? {};
          const vals = i.ExpressionAttributeValues ?? {};
          if (!it) {
            if (i.ConditionExpression?.includes('attribute_exists(PK)')) throw cond();
            // Counters and the like.
            return { Attributes: {} };
          }
          // One AI job at a time (requestAi's condition).
          if (i.ConditionExpression?.includes('aiJob.#st <> :working')) {
            const job = it.aiJob as { status: string; requestedAt: string } | undefined;
            if (job && job.status === 'working' && job.requestedAt >= String(vals[':stale']))
              throw cond();
          }
          // `#eN = :eN` conditions (updateMeeting's expect).
          for (const m of (i.ConditionExpression ?? '').matchAll(/(#e\d+) = (:e\d+)/g)) {
            if (it[names[m[1]!]!] !== vals[m[2]!]) throw cond();
          }
          const [setPart, removePart] = (i.UpdateExpression ?? '').split(' REMOVE ');
          for (const m of (setPart ?? '').matchAll(/(#?\w+) = (:\w+)/g)) {
            const field = m[1]!.startsWith('#') ? names[m[1]!]! : m[1]!;
            it[field] = vals[m[2]!];
          }
          for (const r of (removePart ?? '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)) {
            delete it[names[r] ?? r];
          }
          items.set(key(i.Key), it);
          return { Attributes: {} };
        }
        case 'QueryCommand': {
          if (i.IndexName === 'GSI3') {
            const pk = i.ExpressionAttributeValues[':pk'];
            return {
              Items: [...items.values()]
                .filter((x) => x.GSI3PK === pk)
                .sort((a, b) => String(b.GSI3SK).localeCompare(String(a.GSI3SK))),
            };
          }
          const pk = i.ExpressionAttributeValues[':pk'] as string;
          const prefix = (i.ExpressionAttributeValues[':f'] ??
            i.ExpressionAttributeValues[':p']) as string;
          return {
            Items: [...items.values()].filter(
              (x) => x.PK === pk && String(x.SK).startsWith(prefix ?? ''),
            ),
          };
        }
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    },
  };
  return {
    ...real,
    db,
    env: (n: string) => (n === 'AWS_REGION' ? 'ap-southeast-2' : n.toLowerCase()),
    audit: async () => {},
    principalFor: async (ctx: { sub: string; role: string; artistId?: string }) => ({
      ...ctx,
      ...(ctx.role === 'bmg-staff'
        ? { assignedArtistIds: ctx.sub === staff.sub ? [ARTIST] : [] }
        : {}),
      mfaSatisfied: true,
      secondsSinceAuth: 10,
    }),
  };
});

const meetings = (await import('../src/handlers/meetings.ts')).handler;
const files = (await import('../src/handlers/files.ts')).handler;

const ARTIST = 'art_aaaaaaaaaaaa';
const staff = { sub: '33333333-3333-3333-3333-333333333333', role: 'bmg-staff' };
const otherStaff = { sub: '44444444-4444-4444-4444-444444444444', role: 'bmg-staff' };
const admin = { sub: '55555555-5555-5555-5555-555555555555', role: 'bmg-admin' };
const artist = { sub: '11111111-1111-1111-1111-111111111111', role: 'artist', artistId: ARTIST };

function req(
  who: Record<string, string>,
  method: string,
  proxy: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  return meetings({
    httpMethod: method,
    resource: '/meetings/{proxy+}',
    pathParameters: { proxy },
    queryStringParameters: query ?? null,
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { authorizer: { ...who, sessionId: 's' } },
  } as unknown as APIGatewayProxyEvent);
}

const parse = (r: { statusCode: number; body: string }) =>
  ({ status: r.statusCode, ...JSON.parse(r.body) }) as Record<string, unknown> & {
    status: number;
  };

async function start(who = staff, body: Record<string, unknown> = {}) {
  return parse(
    await req(who, 'POST', 'items', {
      title: 'Meeting with Chloe Poli',
      artistId: ARTIST,
      consent: true,
      startedAt: '2026-11-11T03:00:00.000Z',
      attendees: [{ kind: 'staff', id: staff.sub, name: 'Kyra' }],
      ...body,
    }),
  );
}

beforeEach(() => {
  items.clear();
  objects.clear();
  sent.length = 0;
});

describe('starting and opening meetings', () => {
  it('needs everyone’s agreement', async () => {
    const r = parse(
      await req(staff, 'POST', 'items', { title: 'Catch-up', artistId: ARTIST, consent: false }),
    );
    expect(r.status).toBe(400);
    expect(items.size).toBe(0);
  });

  it('is for the Blueprint team only', async () => {
    expect(parse(await req(artist, 'GET', 'items')).status).toBe(403);
    expect((await start(artist as typeof staff)).status).toBe(403);
  });

  it('lets assigned staff start and open an artist meeting, but nobody unassigned', async () => {
    const made = await start();
    expect(made.status).toBe(201);
    const m = made.meeting as { meetingId: string; status: string; consent: { wording: string } };
    expect(m.status).toBe('recording');
    expect(m.consent.wording).toMatch(/agreed/);

    const mine = parse(await req(staff, 'GET', 'items'));
    expect((mine.meetings as unknown[]).length).toBe(1);
    expect(parse(await req(otherStaff, 'GET', 'items')).meetings).toEqual([]);
    expect(parse(await req(otherStaff, 'GET', `${ARTIST}/${m.meetingId}`)).status).toBe(404);
    expect(parse(await req(admin, 'GET', `${ARTIST}/${m.meetingId}`)).status).toBe(200);
    // Unassigned staff can't start one about the artist either.
    expect((await start(otherStaff)).status).toBe(403);
  });

  it('keeps Blueprint-only meetings for the whole team', async () => {
    const made = await start(otherStaff, { artistId: undefined });
    expect(made.status).toBe(201);
    const id = (made.meeting as { meetingId: string }).meetingId;
    expect(parse(await req(staff, 'GET', `library/${id}`)).status).toBe(200);
    // …and they can't be shared with an artist.
    expect(parse(await req(staff, 'PATCH', `library/${id}`, { shared: true })).status).toBe(400);
  });
});

describe('notes, markers and speaker names', () => {
  it('saves content as versions and refuses a stale one', async () => {
    const id = ((await start()).meeting as { meetingId: string }).meetingId;
    const first = parse(
      await req(staff, 'PATCH', `${ARTIST}/${id}`, {
        notes: 'Push the EP to January',
        markers: [{ at: 61, note: 'budget agreed' }],
        contentVersion: 0,
      }),
    );
    expect((first.meeting as { contentVersion: number }).contentVersion).toBe(1);
    // Stored under the artist's prefix in artist-data, never in the table.
    const stored = [...objects.keys()];
    expect(stored).toEqual([`artist_bucket/artists/${ARTIST}/meetings/${id}/content-1.json`]);
    expect(JSON.stringify([...items.values()])).not.toContain('Push the EP');

    const stale = parse(
      await req(staff, 'PATCH', `${ARTIST}/${id}`, { notes: 'Something else', contentVersion: 0 }),
    );
    expect(stale.status).toBe(409);

    const read = parse(await req(staff, 'GET', `${ARTIST}/${id}`));
    expect((read.content as { notes: string }).notes).toBe('Push the EP to January');
  });

  it('only lets whoever recorded it, or an admin, delete it', async () => {
    items.set(`STAFF#x|ASSIGNMENTS`, { PK: 'STAFF#x', SK: 'ASSIGNMENTS' });
    const id = ((await start()).meeting as { meetingId: string }).meetingId;
    const otherAssigned = { ...staff, sub: '66666666-6666-6666-6666-666666666666' };
    // Not assigned, so it doesn't exist for them.
    expect(parse(await req(otherAssigned, 'DELETE', `${ARTIST}/${id}`)).status).toBe(404);
    expect(parse(await req(admin, 'DELETE', `${ARTIST}/${id}`)).status).toBe(200);
    expect([...items.keys()].some((k) => k.includes('MEETING#'))).toBe(false);
  });
});

describe('the recording', () => {
  function upload(
    who: Record<string, string>,
    meetingId: string,
    contentType = 'audio/webm;codecs=opus',
  ) {
    return files({
      httpMethod: 'POST',
      resource: '/artists/{artistId}/files',
      pathParameters: { artistId: ARTIST },
      queryStringParameters: null,
      body: JSON.stringify({
        meetingId,
        name: 'recording.webm',
        size: 1234,
        contentType,
        durationSec: 62.4,
      }),
      requestContext: { authorizer: { ...who, sessionId: 's' } },
    } as unknown as APIGatewayProxyEvent);
  }

  it('is filed in Meetings › year › month as Blueprint only, named after the meeting', async () => {
    const id = ((await start()).meeting as { meetingId: string }).meetingId;
    const r = parse(await upload(staff, id));
    expect(r.status).toBe(201);
    expect(r.folder).toBe('Meetings › 2026 › 11');
    const rec = [...items.values()].find((x) => String(x.SK).startsWith('FILE#'))!;
    expect(rec.name).toBe('2026-11-11_Meeting with Chloe Poli_audio.webm');
    expect(rec.visibility).toBe('bmg-only');
    expect(rec.contentType).toBe('audio/webm');
    expect(rec.meetingId).toBe(id);
    const folders = [...items.values()].filter((x) => x.type === 'folder').map((f) => f.name);
    expect(folders.sort()).toEqual(['11', '2026', 'Meetings']);
    const m = items.get(`ARTIST#${ARTIST}|MEETING#${id}`)!;
    expect(m.status).toBe('uploading');
    expect(m.audioFileId).toBe(rec.fileId);
    expect(m.durationSec).toBe(62);
    // One recording per meeting.
    expect(parse(await upload(staff, id)).status).toBe(409);
  });

  it('refuses artists, other files and unassigned staff', async () => {
    const id = ((await start()).meeting as { meetingId: string }).meetingId;
    expect(parse(await upload(artist, id)).status).toBe(404);
    expect(parse(await upload(otherStaff, id)).status).toBe(403);
    expect(parse(await upload(staff, id, 'application/pdf')).status).toBe(400);
  });
});

describe('summaries and plan suggestions', () => {
  const PLAN = {
    outcome: 'Release a debut album.',
    measures: [{ id: 'M1', label: '1,000 listeners' }],
    phases: [
      {
        id: 'p1',
        name: 'Album release',
        goal: '',
        start: '2026-11-01',
        end: '2026-12-12',
        milestones: [{ id: 'm1', title: 'Master the EP', done: false, measures: [] }],
      },
    ],
  };

  async function readyMeeting(aiOn = true) {
    items.set(`ARTIST#${ARTIST}|AI`, { PK: `ARTIST#${ARTIST}`, SK: 'AI', aiOptIn: aiOn });
    items.set(`ARTIST#${ARTIST}|PLAN`, {
      PK: `ARTIST#${ARTIST}`,
      SK: 'PLAN',
      ...structuredClone(PLAN),
      version: 3,
      updatedAt: '2026-11-01T00:00:00Z',
    });
    const id = ((await start()).meeting as { meetingId: string }).meetingId;
    const k = `ARTIST#${ARTIST}|MEETING#${id}`;
    items.set(k, { ...items.get(k)!, status: 'ready', contentVersion: 1 });
    const suggestion = (n: number, change: Record<string, unknown>, where: string) => ({
      id: `c${n}`,
      change: { reason: 'Agreed', refs: [0], ...change },
      where,
      before: '',
      after: '',
      checkThis: false,
      status: 'waiting',
    });
    objects.set(
      `artist_bucket/artists/${ARTIST}/meetings/${id}/content-1.json`,
      JSON.stringify({
        notes: '',
        markers: [],
        speakers: {},
        segments: [{ id: 0, speaker: 'spk_0', start: 1, end: 2, text: 'Push the EP to January.' }],
        suggestions: {
          setId: 's1',
          createdAt: '2026-11-11T00:00:00Z',
          createdBy: staff.sub,
          basePlanVersion: 3,
          suggestions: [
            suggestion(
              1,
              { kind: 'stage.dates', phaseId: 'p1', end: '2027-01-30' },
              'Album release',
            ),
            suggestion(
              2,
              { kind: 'milestone.done', phaseId: 'p1', milestoneId: 'm1', done: true },
              'x',
            ),
          ],
        },
      }),
    );
    return id;
  }

  const plan = () => items.get(`ARTIST#${ARTIST}|PLAN`)!;
  const history = () =>
    [...items.values()].filter((x) => String(x.SK).startsWith('PLANLOG#')) as {
      kind: string;
      changes: string[];
    }[];

  it('won’t start AI work for an artist who turned AI off', async () => {
    const id = await readyMeeting(false);
    const r = parse(await req(staff, 'POST', `${ARTIST}/${id}/ai`, { task: 'quick' }));
    expect(r.status).toBe(409);
    expect(String(r.detail)).toMatch(/turned off AI/);
  });

  it('runs one AI job at a time and keeps the question off the event bus', async () => {
    const id = await readyMeeting();
    const r = parse(
      await req(staff, 'POST', `${ARTIST}/${id}/ai`, { task: 'ask', question: 'When is the EP?' }),
    );
    expect(r.status).toBe(202);
    const m = items.get(`ARTIST#${ARTIST}|MEETING#${id}`)!;
    expect((m.aiJob as { status: string }).status).toBe('working');
    expect(JSON.stringify(m)).not.toContain('When is the EP');
    expect(parse(await req(staff, 'POST', `${ARTIST}/${id}/ai`, { task: 'quick' })).status).toBe(
      409,
    );
  });

  it('updates the plan with the accepted changes, in one save with a history entry', async () => {
    const id = await readyMeeting();
    // Nothing accepted yet.
    expect(parse(await req(staff, 'POST', `${ARTIST}/${id}/plan-update`, {})).status).toBe(400);
    const reviewed = parse(
      await req(staff, 'PATCH', `${ARTIST}/${id}/suggestions`, {
        contentVersion: 1,
        updates: [
          { id: 'c2', status: 'accepted' },
          { id: 'c1', status: 'rejected' },
        ],
      }),
    );
    expect(reviewed.status).toBe(200);
    const done = parse(
      await req(staff, 'POST', `${ARTIST}/${id}/plan-update`, { notifyArtist: true }),
    );
    expect(done.status).toBe(200);
    expect(plan().version).toBe(4);
    const phases = plan().phases as typeof PLAN.phases;
    expect(phases[0]!.milestones[0]!.done).toBe(true);
    expect(phases[0]!.end).toBe('2026-12-12'); // rejected
    const entry = history().at(-1)!;
    expect(entry.kind).toBe('meeting');
    expect(entry.changes[0]).toBe('From the meeting “Meeting with Chloe Poli”');
    // It can't be applied twice, and the meeting can't be deleted while it can be undone.
    expect(parse(await req(staff, 'POST', `${ARTIST}/${id}/plan-update`, {})).status).toBe(409);
    expect(parse(await req(admin, 'DELETE', `${ARTIST}/${id}`)).status).toBe(409);
  });

  it('undoes the update while the plan is unchanged, and not after', async () => {
    const id = await readyMeeting();
    await req(staff, 'PATCH', `${ARTIST}/${id}/suggestions`, {
      contentVersion: 1,
      updates: [{ id: 'c2', status: 'accepted' }],
    });
    await req(staff, 'POST', `${ARTIST}/${id}/plan-update`, {});
    const undone = parse(await req(staff, 'POST', `${ARTIST}/${id}/plan-update/undo`, {}));
    expect(undone.status).toBe(200);
    expect(plan().version).toBe(5);
    expect((plan().phases as typeof PLAN.phases)[0]!.milestones[0]!.done).toBe(false);
    expect(history().at(-1)!.kind).toBe('undone');
    expect(parse(await req(staff, 'POST', `${ARTIST}/${id}/plan-update/undo`, {})).status).toBe(
      409,
    );
    // Deleting is allowed again.
    expect(parse(await req(admin, 'DELETE', `${ARTIST}/${id}`)).status).toBe(200);
  });

  it('won’t undo once someone has changed the plan since', async () => {
    const id = await readyMeeting();
    await req(staff, 'PATCH', `${ARTIST}/${id}/suggestions`, {
      contentVersion: 1,
      updates: [{ id: 'c2', status: 'accepted' }],
    });
    await req(staff, 'POST', `${ARTIST}/${id}/plan-update`, {});
    items.set(`ARTIST#${ARTIST}|PLAN`, { ...plan(), version: (plan().version as number) + 1 });
    const r = parse(await req(staff, 'POST', `${ARTIST}/${id}/plan-update/undo`, {}));
    expect(r.status).toBe(409);
    expect(String(r.detail)).toMatch(/changed since/);
  });

  it('sends changes that no longer fit back for another look, and saves nothing', async () => {
    const id = await readyMeeting();
    await req(staff, 'PATCH', `${ARTIST}/${id}/suggestions`, {
      contentVersion: 1,
      updates: [{ id: 'c2', status: 'accepted' }],
    });
    // The milestone was removed in the plan editor meanwhile.
    const p = plan();
    (p.phases as typeof PLAN.phases)[0]!.milestones = [];
    items.set(`ARTIST#${ARTIST}|PLAN`, p);
    const r = parse(await req(staff, 'POST', `${ARTIST}/${id}/plan-update`, {}));
    expect(r.status).toBe(409);
    expect(plan().version).toBe(3);
    const read = parse(await req(staff, 'GET', `${ARTIST}/${id}`));
    const c2 = (
      read.content as {
        suggestions: { suggestions: { id: string; status: string; stale?: boolean }[] };
      }
    ).suggestions.suggestions.find((s) => s.id === 'c2')!;
    expect(c2).toMatchObject({ status: 'waiting', stale: true });
  });

  it('lets staff edit a suggestion, checked against the real plan', async () => {
    const id = await readyMeeting();
    const ok = parse(
      await req(staff, 'PATCH', `${ARTIST}/${id}/suggestions`, {
        contentVersion: 1,
        updates: [{ id: 'c1', change: { end: '2027-01-15', kind: 'stage.remove' } }],
      }),
    );
    expect(ok.status).toBe(200);
    const c1 = (
      ok.suggestions as {
        suggestions: {
          id: string;
          status: string;
          edited?: boolean;
          after: string;
          change: { kind: string };
        }[];
      }
    ).suggestions[0]!;
    // The kind can't be changed by an edit.
    expect(c1).toMatchObject({
      status: 'accepted',
      edited: true,
      after: '1 Nov 2026 – 15 Jan 2027',
    });
    expect(c1.change.kind).toBe('stage.dates');
    const noop = parse(
      await req(staff, 'PATCH', `${ARTIST}/${id}/suggestions`, {
        contentVersion: 2,
        updates: [{ id: 'c1', change: { end: '2026-12-12' } }],
      }),
    );
    expect(noop.status).toBe(400);
  });
});

describe('a meeting that can’t be transcribed (AI off)', () => {
  const setAi = (on: boolean) =>
    items.set(`ARTIST#${ARTIST}|AI`, { PK: `ARTIST#${ARTIST}`, SK: 'AI', aiOptIn: on });
  const noAi = async () => {
    setAi(false);
    const id = ((await start()).meeting as { meetingId: string }).meetingId;
    const k = `ARTIST#${ARTIST}|MEETING#${id}`;
    items.set(k, {
      ...items.get(k)!,
      status: 'no-ai',
      audioFileId: 'fil_audio',
      contentVersion: 0,
    });
    return id;
  };
  const open = async (id: string) =>
    parse(await req(staff, 'GET', `${ARTIST}/${id}`)).meeting as Record<string, unknown>;

  it('says so on the meeting and in the list', async () => {
    const id = await noAi();
    expect(await open(id)).toMatchObject({
      canTranscribe: false,
      transcribeBlockedReason: 'ai_opt_out',
      aiOffArtistIds: [ARTIST],
    });
    const list = parse(await req(staff, 'GET', 'items')).meetings as Record<string, unknown>[];
    expect(list.find((m) => m.meetingId === id)).toMatchObject({ canTranscribe: false });
  });

  it('refuses Transcribe with 403 and asks for no transcript', async () => {
    const id = await noAi();
    const r = parse(await req(staff, 'POST', `${ARTIST}/${id}/transcribe`));
    expect(r.status).toBe(403);
    expect(String(r.detail)).toMatch(/AI assistance is off/);
    expect(sent).not.toContain('meeting.transcribe');
    expect(items.get(`ARTIST#${ARTIST}|MEETING#${id}`)!.status).toBe('no-ai');
  });

  it('counts an artist attendee who turned AI off, not just the linked artist', async () => {
    setAi(false);
    const r = await start(staff, {
      artistId: undefined,
      attendees: [{ kind: 'artist', id: ARTIST, name: 'Chloe Poli' }],
    });
    expect(r.meeting).toMatchObject({ canTranscribe: false, aiOffArtistIds: [ARTIST] });
  });

  it('opens up again as soon as the artist opts in', async () => {
    const id = await noAi();
    setAi(true);
    expect(await open(id)).toMatchObject({ canTranscribe: true, transcribeBlockedReason: null });
    const r = await req(staff, 'POST', `${ARTIST}/${id}/transcribe`);
    expect(r.statusCode).toBe(202);
    expect(sent).toContain('meeting.transcribe');
  });
});
