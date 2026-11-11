import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Principal } from '@bmg/authz';
import type { APIGatewayProxyEvent } from 'aws-lambda';
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
import { newId } from '../workspace/model.ts';
import {
  applyContentPatch,
  canDeleteMeeting,
  CONSENT_WORDING,
  isBlueprint,
  meetingAllowed,
  MeetingCreate,
  MEETING_ID_PATTERN,
  MeetingPatch,
  MEETINGS_GSI3PK,
  parseSpaceParam,
  publicMeeting,
  spaceOf,
  touchesContent,
  type Meeting,
  type MeetingSpace,
} from '../meetings/model.ts';
import {
  createMeeting,
  deleteContent,
  loadMeeting,
  readContent,
  shareFiles,
  updateMeeting,
  writeContent,
} from '../meetings/store.ts';
import { refreshNote } from '../meetings/note.ts';
import {
  AiRequest,
  deleteBlocked,
  PlanUpdateBody,
  requestAi,
  reviewSuggestions,
  SuggestionsPatch,
  undoPlanUpdate,
  updatePlan,
} from '../meetings/actions.ts';

const events = new EventBridgeClient({});
const table = () => env('MAIN_TABLE');

type StaffRole = 'bmg-admin' | 'bmg-staff';
const staffRole = (p: Principal) => p.role as StaffRole;

/** Asks the worker to (re)try transcription. */
async function requestTranscription(m: Pick<Meeting, 'meetingId' | 'artistId'>) {
  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: env('EVENT_BUS'),
          Source: 'bmg.meetings',
          DetailType: 'meeting.transcribe',
          Detail: JSON.stringify({
            id: randomUUID(),
            meetingId: m.meetingId,
            ...(m.artistId ? { artistId: m.artistId } : {}),
          }),
        },
      ],
    }),
  );
}

function ensure(d: { allow: boolean; reason: string }) {
  if (!d.allow) throw new HttpError(403, d.reason);
}

/** The meeting at `/meetings/{space}/{meetingId}`, if this person can open it. */
async function open(principal: Principal, space: MeetingSpace, meetingId: string, write = false) {
  if (!MEETING_ID_PATTERN.test(meetingId)) throw new HttpError(404, 'No such meeting');
  const d = meetingAllowed(principal, space, write ? 'write' : 'read');
  // Someone who can't open it is told it doesn't exist.
  if (!d.allow) throw new HttpError(404, 'No such meeting');
  return loadMeeting(space, meetingId);
}

async function list(principal: Principal, artistId?: string) {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk',
      ExpressionAttributeValues: { ':pk': MEETINGS_GSI3PK },
      ScanIndexForward: false,
      Limit: 300,
    }),
  );
  return ((res.Items ?? []) as Meeting[])
    .filter((m) => (artistId ? m.artistId === artistId : true))
    .filter((m) => meetingAllowed(principal, spaceOf(m), 'read').allow)
    .map((m) => publicMeeting(m, principal));
}

/**
 * Meeting notes (rev 11), Blueprint only. One proxy route,
 * `/meetings/{proxy+}`, to keep the API stack under its resource guardrail:
 *
 *   GET    /meetings/items[?artistId=]     the meetings this person can open
 *   POST   /meetings/items                 start one (consent required)
 *   GET    /meetings/{space}/{id}          the meeting and what was said
 *   PATCH  /meetings/{space}/{id}          title, sharing, notes, markers, speakers, fixes
 *   DELETE /meetings/{space}/{id}          (whoever recorded it, or an admin)
 *   POST   /meetings/{space}/{id}/transcribe   try transcription again
 *   POST   /meetings/{space}/{id}/note     file the latest note in the Library
 *   POST   /meetings/{space}/{id}/ai       summary (quick, full), ask, or plan suggestions
 *   PATCH  /meetings/{space}/{id}/suggestions   accept, reject or edit suggestions
 *   POST   /meetings/{space}/{id}/plan-update   update the plan with the accepted changes
 *   POST   /meetings/{space}/{id}/plan-update/undo   undo it (7 days, plan unchanged since)
 *
 * `{space}` is `library` (Blueprint only) or the artist's id. The audio goes
 * up through the files API (`POST …/files` with `meetingId`), so it is
 * scanned, encrypted and filed like any upload.
 */
export const handler = handle(async (event: APIGatewayProxyEvent) => {
  const principal = await principalFor(authContext(event));
  if (!isBlueprint(principal)) throw new HttpError(403, 'Meetings are for the Blueprint team');
  const parts = (event.pathParameters?.proxy ?? '').split('/').filter(Boolean);
  const method = event.httpMethod;

  if (parts.length === 1 && parts[0] === 'items') {
    if (method === 'GET') {
      const artistId = event.queryStringParameters?.artistId;
      return json(200, { meetings: await list(principal, artistId) });
    }
    if (method === 'POST') return create(event, principal);
    throw new HttpError(404, 'Not found');
  }

  const space = parseSpaceParam(parts[0]);
  const meetingId = parts[1] ?? '';
  if (!space || !meetingId) throw new HttpError(404, 'Not found');
  const action = parts.slice(2).join('/');

  if (action === '' && method === 'GET') {
    const m = await open(principal, space, meetingId);
    const content = await readContent(m, staffRole(principal));
    return json(200, { meeting: publicMeeting(m, principal), content });
  }
  if (action === '' && method === 'PATCH') return patch(event, principal, space, meetingId);
  if (action === '' && method === 'DELETE') {
    const m = await open(principal, space, meetingId, true);
    if (!canDeleteMeeting(principal, m)) {
      throw new HttpError(403, 'Only whoever recorded the meeting, or an admin, can delete it');
    }
    const blocked = deleteBlocked(m);
    if (blocked) throw new HttpError(409, blocked);
    await deleteContent(m, staffRole(principal));
    await db.send(
      new DeleteCommand({
        TableName: table(),
        Key: {
          PK: m.artistId ? `ARTIST#${m.artistId}` : 'ORG#meetings',
          SK: `MEETING#${m.meetingId}`,
        },
      }),
    );
    await audit(event, 'meeting.delete', 'success', ids(m));
    return json(200, { deleted: true });
  }
  if (action === 'transcribe' && method === 'POST') {
    const m = await open(principal, space, meetingId, true);
    if (!m.audioFileId) throw new HttpError(409, 'There’s no recording to transcribe yet');
    if (!['failed', 'off', 'no-ai'].includes(m.status)) {
      throw new HttpError(409, 'This meeting is already transcribed or on its way');
    }
    await updateMeeting(m, { status: 'uploading' }, { remove: ['statusReason'] });
    await requestTranscription(m);
    await audit(event, 'meeting.transcribe-requested', 'success', ids(m));
    return json(202, { status: 'uploading' });
  }
  if (action === 'note' && method === 'POST') {
    const m = await open(principal, space, meetingId, true);
    if (m.status !== 'ready') throw new HttpError(409, 'The transcript isn’t ready yet');
    const fileId = await refreshNote(m, staffRole(principal));
    await audit(event, 'meeting.note', 'success', { ...ids(m), fileId });
    return json(202, { noteFileId: fileId });
  }
  if (action === 'ai' && method === 'POST') {
    const m = await open(principal, space, meetingId, true);
    const job = await requestAi(m, principal, parseBody(event, AiRequest));
    await audit(event, 'meeting.ai-requested', 'success', { ...ids(m), task: job.task });
    return json(202, { aiJob: { task: job.task, status: job.status, error: null } });
  }
  if (action === 'suggestions' && method === 'PATCH') {
    const m = await open(principal, space, meetingId, true);
    return json(200, await reviewSuggestions(m, principal, parseBody(event, SuggestionsPatch)));
  }
  if (action === 'plan-update' && method === 'POST') {
    const m = await open(principal, space, meetingId, true);
    const result = await updatePlan(m, principal, parseBody(event, PlanUpdateBody));
    await audit(event, 'meeting.plan-update', 'success', {
      ...ids(m),
      planVersion: result.planVersion,
    });
    return json(200, result);
  }
  if (action === 'plan-update/undo' && method === 'POST') {
    const m = await open(principal, space, meetingId, true);
    const result = await undoPlanUpdate(m, principal);
    await audit(event, 'meeting.plan-update-undone', 'success', {
      ...ids(m),
      planVersion: result.planVersion,
    });
    return json(200, result);
  }
  throw new HttpError(404, 'Not found');
});

const ids = (m: Pick<Meeting, 'meetingId' | 'artistId'>) => ({
  meetingId: m.meetingId,
  ...(m.artistId ? { artistId: m.artistId } : { library: true }),
});

async function create(event: APIGatewayProxyEvent, principal: Principal) {
  const body = parseBody(event, MeetingCreate);
  const space: MeetingSpace = body.artistId
    ? { kind: 'artist', artistId: body.artistId }
    : { kind: 'library' };
  ensure(meetingAllowed(principal, space, 'write'));
  const now = new Date().toISOString();
  const m: Meeting = {
    meetingId: newId(),
    ...(body.artistId ? { artistId: body.artistId } : {}),
    title: body.title,
    source: body.source,
    createdBy: principal.sub,
    createdByRole: staffRole(principal),
    createdAt: now,
    startedAt: body.startedAt ?? now,
    attendees: body.attendees,
    consent: { bySub: principal.sub, at: now, wording: CONSENT_WORDING[body.source] },
    shared: body.shared,
    status: 'recording',
    contentVersion: 0,
    updatedAt: now,
  };
  await createMeeting(m);
  await audit(event, 'meeting.create', 'success', { ...ids(m), consent: true });
  return json(201, { meeting: publicMeeting(m, principal) });
}

async function patch(
  event: APIGatewayProxyEvent,
  principal: Principal,
  space: MeetingSpace,
  meetingId: string,
) {
  const body = parseBody(event, MeetingPatch);
  const m = await open(principal, space, meetingId, true);
  if (body.shared !== undefined && body.shared && !m.artistId) {
    throw new HttpError(400, 'Only a meeting about an artist can be shared with them');
  }
  const set: Partial<Meeting> = {};
  if (body.title !== undefined) set.title = body.title;
  if (body.attendees !== undefined) set.attendees = body.attendees;
  if (body.shared !== undefined) set.shared = body.shared;
  if (body.durationSec !== undefined) set.durationSec = Math.round(body.durationSec);

  let contentVersion = m.contentVersion;
  if (touchesContent(body)) {
    if (body.contentVersion !== undefined && body.contentVersion !== m.contentVersion) {
      throw new HttpError(409, 'Someone else changed this meeting. Reload and try again.');
    }
    const content = applyContentPatch(await readContent(m, staffRole(principal)), body);
    contentVersion = await writeContent(m, content, staffRole(principal), set);
  } else if (Object.keys(set).length) {
    await updateMeeting(m, set);
  }
  if (body.shared !== undefined && body.shared !== m.shared) {
    await audit(event, body.shared ? 'meeting.share' : 'meeting.unshare', 'success', ids(m));
    // The files follow, and the knowledge base hears about each one (file.share / file.unshare).
    for (const fileId of await shareFiles({ ...m, shared: body.shared }, body.shared)) {
      await audit(event, body.shared ? 'file.share' : 'file.unshare', 'success', {
        artistId: m.artistId!,
        fileId,
      });
    }
  }
  const next = { ...m, ...set, contentVersion };
  return json(200, { meeting: publicMeeting(next, principal) });
}
