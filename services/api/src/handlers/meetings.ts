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
import { aiStates } from '../ai/prompts.ts';
import {
  aiOffArtists,
  applyContentPatch,
  artistsInvolved,
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
  ActionsPatch,
  decideActions,
  DoActionBody,
  doAction,
  type ApiCall,
} from '../meetings/do-actions.ts';
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

/**
 * Who has AI off in each meeting, read from the consent ledger now (one
 * batch for a whole list), so opting in or out shows on the next load.
 */
async function aiOffIn(ms: Pick<Meeting, 'artistId' | 'attendees'>[]) {
  const involved = [...new Set(ms.flatMap(artistsInvolved))];
  const states = involved.length ? await aiStates(involved) : {};
  return (m: Pick<Meeting, 'artistId' | 'attendees'>) => aiOffArtists(m, states);
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
  const shown = ((res.Items ?? []) as Meeting[])
    .filter((m) => (artistId ? m.artistId === artistId : true))
    .filter((m) => meetingAllowed(principal, spaceOf(m), 'read').allow);
  const aiOff = await aiOffIn(shown);
  return shown.map((m) => publicMeeting(m, principal, aiOff(m)));
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
 *   POST   /meetings/{space}/{id}/actions/{actionId}/do   Do it: add the to-do or gig
 *   PATCH  /meetings/{space}/{id}/actions   Ignore actions, or bring them back
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
    const aiOff = await aiOffIn([m]);
    return json(200, { meeting: publicMeeting(m, principal, aiOff(m)), content });
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
    // The screens grey the button out, but an old tab or a hand-made request
    // is refused here too (spec 8). The worker checks again before any job.
    if ((await aiOffIn([m]))(m).length) {
      await audit(event, 'meeting.transcribe-requested', 'denied', {
        ...ids(m),
        reason: 'ai_opt_out',
      });
      throw new HttpError(403, 'AI assistance is off for this artist');
    }
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
  const doIt = /^actions\/(a\d{1,3})\/do$/.exec(action);
  if (doIt && method === 'POST') {
    const m = await open(principal, space, meetingId, true);
    const result = await doAction(
      m,
      principal,
      doIt[1]!,
      parseBody(event, DoActionBody),
      asThePerson(event),
      new Date().toISOString().slice(0, 10),
    );
    await audit(event, 'meeting.action-done', result.ok ? 'success' : 'failed', {
      ...ids(m),
      actionId: result.action.id,
      kind: result.action.kind,
      ...(result.action.resultId ? { resultId: result.action.resultId } : {}),
    });
    const aiOff = await aiOffIn([result.meeting]);
    return json(result.ok ? 200 : 422, {
      action: result.action,
      meeting: publicMeeting(result.meeting, principal, aiOff(result.meeting)),
      ...(result.error ? { detail: result.error } : {}),
    });
  }
  if (action === 'actions' && method === 'PATCH') {
    const m = await open(principal, space, meetingId, true);
    const body = parseBody(event, ActionsPatch);
    const saved = await decideActions(m, principal, body);
    await audit(event, 'meeting.actions-decided', 'success', {
      ...ids(m),
      ignored: body.updates.filter((u) => u.status === 'ignored').length,
      restored: body.updates.filter((u) => u.status === 'waiting').length,
    });
    const aiOff = await aiOffIn([saved.meeting]);
    return json(200, {
      meeting: publicMeeting(saved.meeting, principal, aiOff(saved.meeting)),
      content: saved.content,
    });
  }
  throw new HttpError(404, 'Not found');
});

/**
 * The to-dos made by this meeting's actions (Do it), set to match its
 * sharing through the normal to-dos API. One that's gone or can't be changed
 * is skipped: the meeting's sharing still changes.
 */
async function todosFollow(
  m: Meeting,
  principal: Principal,
  shared: boolean,
  call: ApiCall,
): Promise<string[]> {
  if (!m.artistId) return [];
  const content = await readContent(m, staffRole(principal));
  const todoIds = (content.actions?.items ?? [])
    .filter((a) => a.kind === 'todo' && a.status === 'done' && a.resultId)
    .map((a) => a.resultId!);
  const moved: string[] = [];
  for (const todoId of todoIds) {
    const res = await call({
      method: 'PATCH',
      path: `/artists/${m.artistId}/todos/${encodeURIComponent(todoId)}`,
      body: { bmgOnly: !shared },
    }).catch(() => ({ ok: false, out: {} }));
    if (res.ok) moved.push(todoId);
  }
  return moved;
}

/**
 * Calls the app's own API with the caller's token, like the assistant's "Do
 * it" (ai-actions), so an action is authorised exactly as if done by hand.
 */
function asThePerson(event: APIGatewayProxyEvent): ApiCall {
  const auth = event.headers?.Authorization ?? event.headers?.authorization ?? '';
  const base = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  return async (step) => {
    const res = await fetch(`${base}${step.path}`, {
      method: step.method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(step.body),
      signal: AbortSignal.timeout(8000),
    });
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, out };
  };
}

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
  const aiOff = await aiOffIn([m]);
  return json(201, { meeting: publicMeeting(m, principal, aiOff(m)) });
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
    // To-dos its actions made follow the meeting: shown with it, hidden again without it.
    const moved = await todosFollow(m, principal, body.shared, asThePerson(event));
    if (moved.length) {
      await audit(event, body.shared ? 'meeting.todos-shown' : 'meeting.todos-hidden', 'success', {
        ...ids(m),
        count: moved.length,
      });
    }
    // The files follow, and the knowledge base hears about each one (file.share / file.unshare).
    for (const fileId of await shareFiles({ ...m, shared: body.shared }, body.shared)) {
      await audit(event, body.shared ? 'file.share' : 'file.unshare', 'success', {
        artistId: m.artistId!,
        fileId,
      });
    }
  }
  const next = { ...m, ...set, contentVersion };
  const aiOff = await aiOffIn([next]);
  return json(200, { meeting: publicMeeting(next, principal, aiOff(next)) });
}
