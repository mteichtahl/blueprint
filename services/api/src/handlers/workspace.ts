import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { authorize, type Action, type Principal, type Visibility } from '@bmg/authz';
import { isArtistId } from '@bmg/crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  alignmentGaps,
  artistPk,
  matchesFilter,
  newId,
  PHASE_LIBRARY,
  PLAN_SK,
  PlanBody,
  PROFILE_SK,
  ROSTER_GSI1PK,
  templatePlan,
  TODO_FILTERS,
  TodoCreate,
  todoGsi2Sk,
  TodoPatch,
  todoSk,
  TODOS_GSI2PK,
  type Plan,
  type Todo,
  type TodoFilter,
} from '../workspace/model.ts';
import { authContext, db, env, handle, HttpError, json, parseBody, principalFor } from '../lib.ts';

const table = () => env('MAIN_TABLE');
const today = () => new Date().toISOString().slice(0, 10);

/** Refuses unless authz allows `action` on this artist's data at `visibility`. */
function ensure(
  principal: Principal,
  action: Action,
  artistId: string,
  visibility: Visibility = 'normal',
) {
  const d = authorize(principal, action, { kind: 'artist-data', artistId, visibility });
  if (!d.allow) throw new HttpError(403, d.reason);
}

function artistIdParam(event: APIGatewayProxyEvent): string {
  const id = event.pathParameters?.artistId;
  if (!isArtistId(id)) throw new HttpError(404, 'No such artist');
  return id;
}

function filterParam(event: APIGatewayProxyEvent): TodoFilter | undefined {
  const f = event.queryStringParameters?.filter;
  if (!f) return undefined;
  if (!(TODO_FILTERS as readonly string[]).includes(f)) throw new HttpError(400, 'Unknown filter');
  return f as TodoFilter;
}

async function roster(principal: Principal) {
  if (principal.role === 'artist') {
    const res = await db.send(
      new GetCommand({
        TableName: table(),
        Key: { PK: artistPk(principal.artistId!), SK: PROFILE_SK },
      }),
    );
    return res.Item ? [res.Item] : [];
  }
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
  if (ids.length === 0) return [];
  const res = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [table()]: { Keys: ids.map((id) => ({ PK: artistPk(id), SK: PROFILE_SK })) },
      },
    }),
  );
  return res.Responses?.[table()] ?? [];
}

const publicProfile = (p: Record<string, unknown>) => ({
  artistId: p.artistId,
  displayName: p.displayName,
  status: p.status,
  createdAt: p.createdAt,
});

const publicTodo = (t: Todo) => ({
  todoId: t.todoId,
  artistId: t.artistId,
  title: t.title,
  notes: t.notes ?? null,
  due: t.due ?? null,
  phaseId: t.phaseId ?? null,
  submissionId: t.submissionId ?? null,
  done: t.done,
  source: t.source,
  bmgOnly: t.visibility === 'bmg-only',
  createdAt: t.createdAt,
});

/**
 * Artists, plans and to-dos. Every route checks the shared authz rules
 * against the stored item; artistId comes from the path and is checked
 * against the caller's token or assignments, never trusted on its own.
 */
export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const route = `${event.httpMethod} ${event.resource}`;

  switch (route) {
    case 'GET /artists': {
      const items = await roster(principal);
      return json(200, { artists: items.map(publicProfile) });
    }

    case 'GET /artists/{artistId}': {
      const artistId = artistIdParam(event);
      ensure(principal, 'read', artistId);
      const res = await db.send(
        new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: PROFILE_SK } }),
      );
      if (!res.Item) throw new HttpError(404, 'No such artist');
      return json(200, publicProfile(res.Item));
    }

    case 'GET /artists/{artistId}/plan': {
      const artistId = artistIdParam(event);
      ensure(principal, 'read', artistId);
      const res = await db.send(
        new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: PLAN_SK } }),
      );
      const plan = (res.Item as Plan | undefined) ?? templatePlan();
      return json(200, {
        plan: {
          outcome: plan.outcome,
          measures: plan.measures,
          phases: plan.phases,
          version: plan.version,
          updatedAt: plan.updatedAt,
        },
        gaps: alignmentGaps(plan),
        phaseLibrary: PHASE_LIBRARY,
        exists: !!res.Item,
      });
    }

    case 'PUT /artists/{artistId}/plan': {
      const artistId = artistIdParam(event);
      ensure(principal, 'write', artistId);
      // Plans are run by BMG; artists see them and tick off their to-dos.
      if (principal.role === 'artist') throw new HttpError(403, 'Plans are edited by Blueprint');
      const body = parseBody(event, PlanBody);
      const next = { ...body, version: body.version + 1, updatedAt: new Date().toISOString() };
      try {
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: {
              PK: artistPk(artistId),
              SK: PLAN_SK,
              type: 'plan',
              artistId,
              ...next,
              updatedBy: principal.sub,
            },
            ConditionExpression: body.version === 0 ? 'attribute_not_exists(PK)' : 'version = :v',
            ...(body.version === 0 ? {} : { ExpressionAttributeValues: { ':v': body.version } }),
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') {
          throw new HttpError(409, 'Someone else changed this plan. Reload and try again.');
        }
        throw err;
      }
      return json(200, { version: next.version, gaps: alignmentGaps(next) });
    }

    case 'GET /artists/{artistId}/todos': {
      const artistId = artistIdParam(event);
      ensure(principal, 'read', artistId);
      const filter = filterParam(event);
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :todo)',
          ExpressionAttributeValues: { ':pk': artistPk(artistId), ':todo': 'TODO#' },
          ScanIndexForward: false,
          Limit: 200,
        }),
      );
      const now = today();
      const todos = ((res.Items ?? []) as Todo[])
        .filter(
          (t) =>
            authorize(principal, 'read', {
              kind: 'artist-data',
              artistId,
              visibility: t.visibility,
            }).allow,
        )
        .filter((t) => matchesFilter(t, filter, now))
        .map(publicTodo);
      return json(200, { todos });
    }

    case 'POST /artists/{artistId}/todos': {
      const artistId = artistIdParam(event);
      ensure(principal, 'write', artistId);
      const body = parseBody(event, TodoCreate);
      if (body.bmgOnly && principal.role === 'artist')
        throw new HttpError(403, 'Only Blueprint can add BMG-only to-dos');
      const todoId = newId();
      const todo: Todo = {
        todoId,
        artistId,
        title: body.title,
        ...(body.notes ? { notes: body.notes } : {}),
        ...(body.due ? { due: body.due } : {}),
        ...(body.phaseId ? { phaseId: body.phaseId } : {}),
        done: false,
        source: principal.role === 'artist' ? 'artist' : 'bmg',
        visibility: body.bmgOnly ? 'bmg-only' : 'normal',
        createdBy: principal.sub,
        createdAt: new Date().toISOString(),
      };
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            PK: artistPk(artistId),
            SK: todoSk(todoId),
            type: 'todo',
            ...todo,
            GSI2PK: TODOS_GSI2PK,
            GSI2SK: todoGsi2Sk(todo.due, artistId, todoId),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return json(201, publicTodo(todo));
    }

    case 'PATCH /artists/{artistId}/todos/{todoId}': {
      const artistId = artistIdParam(event);
      const todoId = event.pathParameters?.todoId ?? '';
      if (!/^[a-z0-9]{10,40}$/.test(todoId)) throw new HttpError(404, 'No such to-do');
      const key = { PK: artistPk(artistId), SK: todoSk(todoId) };
      const existing = (await db.send(new GetCommand({ TableName: table(), Key: key }))).Item as
        Todo | undefined;
      if (!existing) throw new HttpError(404, 'No such to-do');
      ensure(principal, 'write', artistId, existing.visibility);
      const patch = parseBody(event, TodoPatch);
      // Artists can tick off any of their to-dos but only edit the ones they wrote.
      const editsContent =
        patch.title !== undefined || patch.notes !== undefined || patch.due !== undefined;
      if (principal.role === 'artist' && editsContent && existing.source !== 'artist') {
        throw new HttpError(
          403,
          'Only your own to-dos can be edited; you can still mark this one done',
        );
      }
      const updated: Todo = {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.done !== undefined ? { done: patch.done } : {}),
      };
      if (patch.due === null) delete updated.due;
      else if (patch.due !== undefined) updated.due = patch.due;
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: key,
          UpdateExpression:
            'SET title = :title, notes = :notes, done = :done, #due = :due, GSI2SK = :gsi2, updatedAt = :at, updatedBy = :by',
          ExpressionAttributeNames: { '#due': 'due' },
          ExpressionAttributeValues: {
            ':title': updated.title,
            ':notes': updated.notes ?? null,
            ':done': updated.done,
            ':due': updated.due ?? null,
            ':gsi2': todoGsi2Sk(updated.due, artistId, todoId),
            ':at': new Date().toISOString(),
            ':by': principal.sub,
          },
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      return json(200, publicTodo(updated));
    }

    case 'GET /todos': {
      // "All artist to-dos" (screens doc): BMG only; staff see their assigned artists.
      if (principal.role === 'artist') throw new HttpError(403, 'Use your own to-do list');
      const filter = filterParam(event);
      const only = event.queryStringParameters?.artistId;
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': TODOS_GSI2PK },
          Limit: 500,
        }),
      );
      const now = today();
      const todos = ((res.Items ?? []) as Todo[])
        .filter((t) => !only || t.artistId === only)
        .filter(
          (t) =>
            authorize(principal, 'read', {
              kind: 'artist-data',
              artistId: t.artistId,
              visibility: t.visibility,
            }).allow,
        )
        .filter((t) => matchesFilter(t, filter, now))
        .map(publicTodo);
      return json(200, { todos });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
