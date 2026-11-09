import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { authorize, type Action, type Principal, type Visibility } from '@bmg/authz';
import { isArtistId } from '@bmg/crypto';
import { BRAND_SK, BrandKitBody, EMPTY_KIT, referencedFiles } from '../brand/model.ts';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  alignmentGaps,
  ApplyStageBody,
  artistPk,
  changedFields,
  matchesFilter,
  newId,
  notifyOnEdit,
  PHASE_LIBRARY,
  phaseFromStage,
  PLAN_SK,
  PlanBody,
  PROFILE_SK,
  reminderAt,
  reminderScheduleName,
  ROSTER_GSI1PK,
  STAGE_ID_PATTERN,
  stageAppliesTo,
  StageBody,
  stageSk,
  STAGES_PK,
  templatePlan,
  TODO_FILTERS,
  TodoCreate,
  todoGsi2Sk,
  TodoPatch,
  todoSk,
  TODOS_GSI2PK,
  type Plan,
  type Stage,
  type Todo,
  type TodoFilter,
} from '../workspace/model.ts';
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
const today = () => new Date().toISOString().slice(0, 10);
const events = new EventBridgeClient({});
const scheduler = new SchedulerClient({});

/** Domain events for notifications (design 7.3); ids only, no content. */
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

/**
 * Keeps a to-do's reminder in step with it: one EventBridge Scheduler
 * one-off per to-do, which puts `todo.reminder` on the bus at the right time
 * (the notifier then re-checks the to-do, so a stale schedule sends nothing).
 */
async function syncReminder(todo: Todo) {
  const Name = reminderScheduleName(todo.artistId, todo.todoId);
  const GroupName = env('REMINDER_GROUP');
  if (!todo.remindAt || todo.done) {
    try {
      await scheduler.send(new DeleteScheduleCommand({ Name, GroupName }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
    return;
  }
  const input = {
    Name,
    GroupName,
    // Scheduler takes `at()` without a zone suffix; the zone is given separately.
    ScheduleExpression: `at(${todo.remindAt.slice(0, 19)})`,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' as const },
    ActionAfterCompletion: 'DELETE' as const,
    Target: {
      Arn: env('EVENT_BUS_ARN'),
      RoleArn: env('REMINDER_ROLE_ARN'),
      EventBridgeParameters: { DetailType: 'todo.reminder', Source: 'bmg.workspace' },
      Input: JSON.stringify({
        artistId: todo.artistId,
        todoId: todo.todoId,
        remindAt: todo.remindAt,
      }),
      RetryPolicy: { MaximumRetryAttempts: 10, MaximumEventAgeInSeconds: 3600 },
    },
  };
  try {
    await scheduler.send(new CreateScheduleCommand(input));
  } catch (err) {
    if (!(err instanceof ConflictException)) throw err;
    await scheduler.send(new UpdateScheduleCommand(input));
  }
}

/**
 * Schedules the reminder without letting a Scheduler problem undo the save.
 * The to-do is already stored when this runs, so a failure here used to turn
 * into a 500, and a retry made a duplicate to-do. Now the reminder is cleared,
 * the error is logged, and the caller tells the user to set it again.
 */
async function scheduleReminder(todo: Todo): Promise<Todo & { reminderFailed?: true }> {
  try {
    await syncReminder(todo);
    return todo;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.error(
      JSON.stringify({
        msg: 'todo reminder schedule failed',
        artistId: todo.artistId,
        todoId: todo.todoId,
        error: e.name,
        detail: e.message,
      }),
    );
    if (!todo.remindAt) return todo;
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: artistPk(todo.artistId), SK: todoSk(todo.todoId) },
        UpdateExpression: 'REMOVE remindAt',
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
    const rest: Todo = { ...todo };
    delete rest.remindAt;
    return { ...rest, reminderFailed: true };
  }
}

/**
 * Works out remindAt. When the user just set the timing (`strict`), a
 * reminder that would already have gone off is refused; otherwise (e.g.
 * re-opening an old to-do) a past reminder is simply not scheduled again.
 */
function withReminder(todo: Todo, strict: boolean): Todo {
  const at = reminderAt(todo);
  const next = { ...todo };
  delete next.remindAt;
  if (todo.reminder && !todo.due) throw new HttpError(400, 'Set a due date to add a reminder');
  if (!at || todo.done) return next;
  if (at.getTime() <= Date.now()) {
    if (strict) {
      throw new HttpError(400, 'That reminder time has already passed. Pick a shorter reminder.');
    }
    return next;
  }
  next.remindAt = at.toISOString();
  return next;
}

async function listStages(): Promise<Stage[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':pk': STAGES_PK, ':s': 'STAGE#' },
      Limit: 200,
    }),
  );
  return ((res.Items ?? []) as Stage[]).sort((a, b) => a.name.localeCompare(b.name));
}

const publicStage = (st: Stage) => ({
  stageId: st.stageId,
  name: st.name,
  goal: st.goal,
  milestones: st.milestones,
  appliesTo: st.appliesTo,
  artistIds: st.artistIds,
  createdAt: st.createdAt,
  updatedAt: st.updatedAt ?? null,
});

function stageIdParam(event: APIGatewayProxyEvent): string {
  const id = event.pathParameters?.stageId ?? '';
  if (!STAGE_ID_PATTERN.test(id)) throw new HttpError(404, 'No such stage');
  return id;
}

/** Custom stages are BMG's: artists can't read or change the library. */
function ensureBmg(principal: Principal) {
  const d = authorize(principal, 'write', { kind: 'org-shared', visibility: 'bmg-only' });
  if (!d.allow) throw new HttpError(403, 'Plan stages are managed by Blueprint');
}

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

const publicTodo = (t: Todo & { reminderFailed?: true }) => ({
  ...(t.reminderFailed
    ? { warning: "Saved, but the reminder couldn't be set. Open the to-do and set it again." }
    : {}),
  todoId: t.todoId,
  artistId: t.artistId,
  title: t.title,
  notes: t.notes ?? null,
  due: t.due ?? null,
  dueTime: t.dueTime ?? null,
  reminder: t.reminder ?? null,
  remindAt: t.remindAt ?? null,
  phaseId: t.phaseId ?? null,
  submissionId: t.submissionId ?? null,
  done: t.done,
  source: t.source,
  bmgOnly: t.visibility === 'bmg-only',
  createdAt: t.createdAt,
  updatedAt: t.updatedAt ?? null,
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

    // ── Brand kit (screens doc "Brand kit"): the artist and Blueprint both edit it ──
    case 'GET /artists/{artistId}/brand-kit': {
      const artistId = artistIdParam(event);
      ensure(principal, 'read', artistId);
      const res = await db.send(
        new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: BRAND_SK } }),
      );
      const kit = { ...((res.Item ?? EMPTY_KIT) as Record<string, unknown>) };
      for (const k of ['PK', 'SK', 'type']) delete kit[k];
      return json(200, kit);
    }

    case 'PUT /artists/{artistId}/brand-kit': {
      const artistId = artistIdParam(event);
      ensure(principal, 'write', artistId);
      const body = parseBody(event, BrandKitBody);
      // Logos and imagery must be this artist's own files.
      const ids = referencedFiles(body);
      if (ids.length) {
        const found = await db.send(
          new BatchGetCommand({
            RequestItems: {
              [table()]: {
                Keys: ids.map((id) => ({ PK: artistPk(artistId), SK: `FILE#${id}` })),
                ProjectionExpression: 'fileId',
              },
            },
          }),
        );
        const have = new Set((found.Responses?.[table()] ?? []).map((i) => String(i.fileId)));
        if (ids.some((id) => !have.has(id))) {
          throw new HttpError(400, "Logos and imagery must come from this artist's files");
        }
      }
      const { version, ...rest } = body;
      const now = new Date().toISOString();
      const profile =
        principal.role === 'artist'
          ? await db.send(
              new GetCommand({
                TableName: table(),
                Key: { PK: artistPk(artistId), SK: 'PROFILE' },
              }),
            )
          : undefined;
      const kit = {
        ...rest,
        version: version + 1,
        updatedAt: now,
        updatedBy: principal.sub,
        updatedByName:
          principal.role === 'artist'
            ? String(profile?.Item?.displayName ?? 'the artist')
            : 'Blueprint',
      };
      try {
        await db.send(
          new PutCommand({
            TableName: table(),
            Item: { PK: artistPk(artistId), SK: BRAND_SK, type: 'brandKit', ...kit },
            ConditionExpression:
              version === 0 ? 'attribute_not_exists(PK) OR version = :v' : 'version = :v',
            ExpressionAttributeValues: { ':v': version },
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') {
          throw new HttpError(
            409,
            'Someone else changed this brand kit. Reload to see their changes.',
          );
        }
        throw err;
      }
      return json(200, kit);
    }

    case 'GET /artists/{artistId}/plan': {
      const artistId = artistIdParam(event);
      ensure(principal, 'read', artistId);
      const res = await db.send(
        new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: PLAN_SK } }),
      );
      const plan = (res.Item as Plan | undefined) ?? templatePlan();
      // BMG edits plans, so only BMG gets the stages it can add to this one.
      const stages =
        principal.role === 'artist'
          ? []
          : (await listStages()).filter((st) => stageAppliesTo(st, artistId)).map(publicStage);
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
        stages,
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

    // ── Custom plan stages (BMG) ──
    case 'GET /plan-stages': {
      ensureBmg(principal);
      return json(200, {
        stages: (await listStages()).map(publicStage),
        phaseLibrary: PHASE_LIBRARY,
      });
    }

    case 'POST /plan-stages': {
      ensureBmg(principal);
      const body = parseBody(event, StageBody);
      const stage: Stage = {
        ...body,
        artistIds: body.appliesTo === 'selected' ? body.artistIds : [],
        stageId: newId(),
        createdBy: principal.sub,
        createdAt: new Date().toISOString(),
      };
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: { PK: STAGES_PK, SK: stageSk(stage.stageId), type: 'planStage', ...stage },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return json(201, publicStage(stage));
    }

    case 'PUT /plan-stages/{stageId}': {
      ensureBmg(principal);
      const stageId = stageIdParam(event);
      const body = parseBody(event, StageBody);
      const key = { PK: STAGES_PK, SK: stageSk(stageId) };
      const existing = (await db.send(new GetCommand({ TableName: table(), Key: key }))).Item as
        Stage | undefined;
      if (!existing) throw new HttpError(404, 'No such stage');
      const stage: Stage = {
        ...existing,
        ...body,
        artistIds: body.appliesTo === 'selected' ? body.artistIds : [],
        updatedAt: new Date().toISOString(),
      };
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: { ...key, type: 'planStage', ...stage, updatedBy: principal.sub },
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      return json(200, publicStage(stage));
    }

    case 'DELETE /plan-stages/{stageId}': {
      ensureBmg(principal);
      const stageId = stageIdParam(event);
      // Plans that already use the stage keep their copy of it.
      await db.send(
        new DeleteCommand({ TableName: table(), Key: { PK: STAGES_PK, SK: stageSk(stageId) } }),
      );
      return json(200, { deleted: stageId });
    }

    case 'POST /plan-stages/{stageId}/apply': {
      // Adds the stage to each chosen artist's plan (artists with no plan yet are skipped).
      ensureBmg(principal);
      const stageId = stageIdParam(event);
      const { artistIds } = parseBody(event, ApplyStageBody);
      const stage = (
        await db.send(
          new GetCommand({ TableName: table(), Key: { PK: STAGES_PK, SK: stageSk(stageId) } }),
        )
      ).Item as Stage | undefined;
      if (!stage) throw new HttpError(404, 'No such stage');
      const result: { added: string[]; alreadyThere: string[]; noPlan: string[] } = {
        added: [],
        alreadyThere: [],
        noPlan: [],
      };
      for (const artistId of [...new Set(artistIds)]) {
        ensure(principal, 'write', artistId);
        const key = { PK: artistPk(artistId), SK: PLAN_SK };
        const plan = (await db.send(new GetCommand({ TableName: table(), Key: key }))).Item as
          Plan | undefined;
        if (!plan) {
          result.noPlan.push(artistId);
          continue;
        }
        if (plan.phases.some((ph) => ph.stageId === stageId)) {
          result.alreadyThere.push(artistId);
          continue;
        }
        if (plan.phases.length >= 12) throw new HttpError(409, 'A plan can have up to 12 stages');
        const phase = phaseFromStage({ ...stage, stageId }, () => newId().slice(-12));
        try {
          await db.send(
            new UpdateCommand({
              TableName: table(),
              Key: key,
              UpdateExpression:
                'SET phases = list_append(phases, :p), version = :next, updatedAt = :at, updatedBy = :by',
              ConditionExpression: 'version = :v',
              ExpressionAttributeValues: {
                ':p': [phase],
                ':v': plan.version,
                ':next': plan.version + 1,
                ':at': new Date().toISOString(),
                ':by': principal.sub,
              },
            }),
          );
        } catch (err) {
          if ((err as Error).name === 'ConditionalCheckFailedException') {
            throw new HttpError(409, 'A plan changed while the stage was being added. Try again.');
          }
          throw err;
        }
        result.added.push(artistId);
      }
      return json(200, result);
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
      const todo: Todo = withReminder(
        {
          todoId,
          artistId,
          title: body.title,
          ...(body.notes ? { notes: body.notes } : {}),
          ...(body.due ? { due: body.due } : {}),
          ...(body.due && body.dueTime ? { dueTime: body.dueTime } : {}),
          ...(body.reminder ? { reminder: body.reminder } : {}),
          ...(body.phaseId ? { phaseId: body.phaseId } : {}),
          done: false,
          source: principal.role === 'artist' ? 'artist' : 'bmg',
          visibility: body.bmgOnly ? 'bmg-only' : 'normal',
          createdBy: principal.sub,
          createdAt: new Date().toISOString(),
        },
        true,
      );
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
      const saved = await scheduleReminder(todo);
      return json(201, publicTodo(saved));
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
      // Artists and Blueprint can both edit any to-do they can see (BMG-only
      // ones are invisible to artists, and `ensure` above refuses them).
      const merged: Todo = {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.done !== undefined ? { done: patch.done } : {}),
      };
      if (patch.due === null) delete merged.due;
      else if (patch.due !== undefined) merged.due = patch.due;
      if (patch.dueTime === null) delete merged.dueTime;
      else if (patch.dueTime !== undefined) merged.dueTime = patch.dueTime;
      if (patch.reminder === null) delete merged.reminder;
      else if (patch.reminder !== undefined) merged.reminder = patch.reminder;
      if (!merged.due) {
        delete merged.dueTime;
        // No due date, nothing to remind about.
        if (patch.reminder === undefined) delete merged.reminder;
      }
      if (!merged.notes) delete merged.notes;
      const changed = changedFields(existing, merged);
      if (changed.length === 0) return json(200, publicTodo(existing));
      // Only a newly set timing is held to "not in the past"; ticking an old to-do is fine.
      const timing = changed.some((f) => f === 'due' || f === 'dueTime' || f === 'reminder');
      const updated: Todo = {
        ...withReminder(merged, timing),
        updatedAt: new Date().toISOString(),
        updatedBy: principal.sub,
      };
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: key,
          UpdateExpression:
            'SET title = :title, notes = :notes, done = :done, #due = :due, dueTime = :dueTime, reminder = :reminder, remindAt = :remindAt, GSI2SK = :gsi2, updatedAt = :at, updatedBy = :by',
          ExpressionAttributeNames: { '#due': 'due' },
          ExpressionAttributeValues: {
            ':title': updated.title,
            ':notes': updated.notes ?? null,
            ':done': updated.done,
            ':due': updated.due ?? null,
            ':dueTime': updated.dueTime ?? null,
            ':reminder': updated.reminder ?? null,
            ':remindAt': updated.remindAt ?? null,
            ':gsi2': todoGsi2Sk(updated.due, artistId, todoId),
            ':at': updated.updatedAt,
            ':by': principal.sub,
          },
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      const saved = await scheduleReminder(updated);
      const notify = notifyOnEdit(principal.role, existing);
      if (notify) {
        await domainEvent('todo.updated', {
          artistId,
          todoId,
          changedFields: changed,
          byRole: principal.role,
          notify,
        });
      }
      await audit(event, 'todo.update', 'success', { artistId, todoId, fields: changed.join(',') });
      return json(200, publicTodo(saved));
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
