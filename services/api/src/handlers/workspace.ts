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
  TransactWriteCommand,
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
  CommentCreate,
  publicComment,
  threadOf,
  todoCommentPrefix,
  todoCommentSk,
  type TodoComment,
} from '../workspace/model.ts';
import {
  PLAN_LOG_PREFIX,
  planChanges,
  publicChange,
  type PlanChange,
} from '../workspace/plan-history.ts';
import { changeEntry, loadPlan, planConflict, savePlan } from '../workspace/plan-store.ts';
import {
  canOwnPlan,
  MAX_TODOS_IN_MOVE,
  movesWithOwner,
  ownerCandidates,
  ownerChangeLine,
  ownerStatus,
  ownerView,
  PLAN_DIGEST_MINUTES,
  planDigestScheduleName,
} from '../workspace/plan-owner.ts';
import { people, type Person } from '../files/people.ts';
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
 * Schedules the reminder without ever failing the save: the to-do is already
 * stored, so a Scheduler error is logged and flagged on the to-do
 * (`reminderFailed`) instead of turning into a 500 and a duplicate on retry.
 */
async function scheduleReminder(todo: Todo, key: { PK: string; SK: string }): Promise<Todo> {
  let failed = false;
  try {
    await syncReminder(todo);
  } catch (err) {
    failed = true;
    console.error(
      JSON.stringify({
        msg: 'reminder.failed',
        artistId: todo.artistId,
        todoId: todo.todoId,
        error: (err as Error).name,
        detail: (err as Error).message,
      }),
    );
  }
  if (failed === !!todo.reminderFailed) return todo;
  await db.send(
    new UpdateCommand({
      TableName: table(),
      Key: key,
      UpdateExpression: failed ? 'SET reminderFailed = :t' : 'REMOVE reminderFailed',
      ...(failed ? { ExpressionAttributeValues: { ':t': true } } : {}),
      ConditionExpression: 'attribute_exists(PK)',
    }),
  );
  const next = { ...todo };
  if (failed) next.reminderFailed = true;
  else delete next.reminderFailed;
  return next;
}

/** The to-do a thread belongs to (404 if it doesn't exist). */
async function loadTodoFor(event: APIGatewayProxyEvent, artistId: string): Promise<Todo> {
  const todoId = event.pathParameters?.todoId ?? '';
  if (!/^[a-z0-9]{10,40}$/.test(todoId)) throw new HttpError(404, 'No such to-do');
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: todoSk(todoId) } }),
  );
  if (!res.Item) throw new HttpError(404, 'No such to-do');
  return res.Item as Todo;
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

/** `ARTIST#id / AI`: latest AI choice and the terms it was made with (BMG roster). */
async function consentSummaries(artistIds: string[]) {
  const out: Record<
    string,
    { termsVersion: string | null; termsAcceptedAt: string | null; aiOptIn: boolean | null }
  > = {};
  for (let i = 0; i < artistIds.length; i += 100) {
    const res = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table()]: {
            Keys: artistIds.slice(i, i + 100).map((id) => ({ PK: artistPk(id), SK: 'AI' })),
          },
        },
      }),
    );
    for (const it of res.Responses?.[table()] ?? []) {
      out[String(it.artistId ?? String(it.PK).slice('ARTIST#'.length))] = {
        termsVersion: typeof it.termsVersion === 'string' ? it.termsVersion : null,
        termsAcceptedAt: typeof it.termsAcceptedAt === 'string' ? it.termsAcceptedAt : null,
        aiOptIn: typeof it.aiOptIn === 'boolean' ? it.aiOptIn : null,
      };
    }
  }
  return out;
}

/**
 * Plan update notifications (rev 12): the first save by a person opens a
 * 10-minute window with a one-off schedule that puts `plan.digest` on the
 * bus; the notifier then tells the owner and the artist everything that
 * person changed in it. A save while the window is open finds the schedule
 * already there. Never fails the save.
 */
async function scheduleDigest(artistId: string, bySub: string, since: string) {
  const fireAt = new Date(Date.now() + PLAN_DIGEST_MINUTES * 60_000).toISOString();
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: planDigestScheduleName(artistId, bySub),
        GroupName: env('REMINDER_GROUP'),
        ScheduleExpression: `at(${fireAt.slice(0, 19)})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: env('EVENT_BUS_ARN'),
          RoleArn: env('REMINDER_ROLE_ARN'),
          EventBridgeParameters: { DetailType: 'plan.digest', Source: 'bmg.workspace' },
          Input: JSON.stringify({ artistId, bySub, since }),
          RetryPolicy: { MaximumRetryAttempts: 10, MaximumEventAgeInSeconds: 3600 },
        },
      }),
    );
  } catch (err) {
    if (err instanceof ConflictException) return;
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'plan.digestNotScheduled',
        name: (err as Error).name,
      }),
    );
  }
}

/** Every to-do in an artist's workspace (the TODO# prefix holds no comments). */
async function allTodos(artistId: string): Promise<Todo[]> {
  const out: Todo[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :todo)',
        ExpressionAttributeValues: { ':pk': artistPk(artistId), ':todo': 'TODO#' },
        ExclusiveStartKey,
      }),
    );
    out.push(...((res.Items ?? []) as Todo[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * The Blueprint team, for plan owners (rev 12). If the user pool can't be
 * read, plans still load: owners just show as unknown.
 */
const team = () => people().catch(() => [] as Person[]);

/** Owner as shown; with no team list, a plan with an owner isn't flagged. */
function ownerFor(ownerSub: string | undefined, everyone: Person[], artistId: string) {
  if (everyone.length === 0) return { owner: null, ownerNeeded: !ownerSub };
  return ownerStatus(ownerSub, everyone, artistId);
}

/** Each listed artist's plan owner, for Studio HQ and Artists & access (BMG only). */
async function planOwners(artistIds: string[]) {
  const plans = new Map<string, { ownerSub?: string }>();
  for (let i = 0; i < artistIds.length; i += 100) {
    const res = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table()]: {
            Keys: artistIds.slice(i, i + 100).map((id) => ({ PK: artistPk(id), SK: PLAN_SK })),
            ProjectionExpression: 'artistId, ownerSub',
          },
        },
      }),
    );
    for (const item of res.Responses?.[table()] ?? []) {
      plans.set(String(item.artistId), { ownerSub: item.ownerSub as string | undefined });
    }
  }
  const everyone = plans.size ? await team() : [];
  return Object.fromEntries(
    artistIds.map((id) => {
      const plan = plans.get(id);
      if (!plan) return [id, { hasPlan: false, planOwner: null, planOwnerNeeded: false }];
      const s = ownerFor(plan.ownerSub, everyone, id);
      return [id, { hasPlan: true, planOwner: s.owner, planOwnerNeeded: s.ownerNeeded }];
    }),
  );
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
  dueTime: t.dueTime ?? null,
  reminder: t.reminder ?? null,
  remindAt: t.remindAt ?? null,
  reminderFailed: !!t.reminderFailed,
  commentCount: (t as Todo & { commentCount?: number }).commentCount ?? 0,
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
      if (principal.role === 'artist') return json(200, { artists: items.map(publicProfile) });
      // Artists & access: each artist's terms acceptance and AI status, and (rev 12) plan owner.
      const ids = items.map((i) => String(i.artistId));
      const [consent, owners] = await Promise.all([consentSummaries(ids), planOwners(ids)]);
      return json(200, {
        artists: items.map((i) => ({
          ...publicProfile(i),
          ...(consent[String(i.artistId)] ?? {
            termsVersion: null,
            termsAcceptedAt: null,
            aiOptIn: null,
          }),
          ...owners[String(i.artistId)],
        })),
      });
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
      const stored = res.Item as Plan | undefined;
      const plan = stored ?? templatePlan();
      const bmg = principal.role !== 'artist';
      // BMG edits plans, so only BMG gets the stages it can add to this one.
      const stages = !bmg
        ? []
        : (await listStages()).filter((st) => stageAppliesTo(st, artistId)).map(publicStage);
      // Plan owner (rev 12). BMG also gets who could own it and what would move.
      const everyone = await team();
      const status = stored
        ? ownerFor(stored.ownerSub, everyone, artistId)
        : { owner: null, ownerNeeded: false };
      const movableTodos =
        bmg && stored
          ? (await allTodos(artistId)).filter((t) => movesWithOwner(t, stored.ownerSub)).length
          : 0;
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
        owner: status.owner,
        ownerSince: stored?.ownerSince ?? null,
        ownerNeeded: bmg && status.ownerNeeded,
        ...(bmg ? { ownerCandidates: ownerCandidates(everyone, artistId), movableTodos } : {}),
      });
    }

    case 'PUT /artists/{artistId}/plan': {
      const artistId = artistIdParam(event);
      ensure(principal, 'write', artistId);
      // Plans are run by BMG; artists see them and tick off their to-dos.
      if (principal.role === 'artist') throw new HttpError(403, 'Plans are edited by Blueprint');
      const body = parseBody(event, PlanBody);
      const key = { PK: artistPk(artistId), SK: PLAN_SK };
      const current = (await db.send(new GetCommand({ TableName: table(), Key: key }))).Item as
        Plan | undefined;
      if ((current?.version ?? 0) !== body.version) {
        throw new HttpError(409, 'Someone else changed this plan. Reload and try again.');
      }
      const content = { outcome: body.outcome, measures: body.measures, phases: body.phases };

      // Every plan has a Blueprint owner (rev 12): required for a new plan and
      // for one without an owner; a different one hands the plan over.
      const everyone = await people();
      const ownerSub = body.ownerSub ?? current?.ownerSub;
      if (!ownerSub) throw new HttpError(400, 'Choose a plan owner');
      const owner = everyone.find((p) => p.sub === ownerSub);
      if (!canOwnPlan(owner, artistId)) {
        throw new HttpError(
          400,
          body.ownerSub
            ? 'The plan owner must be a Blueprint admin, or staff assigned to this artist'
            : "This plan's owner can't look after it any more. Choose a new plan owner.",
        );
      }
      const ownerChanged = ownerSub !== current?.ownerSub;
      // The previous owner's open to-dos (and unlooked-after ones) move with the plan.
      const moving =
        ownerChanged && current
          ? (await allTodos(artistId)).filter((t) => movesWithOwner(t, current.ownerSub))
          : [];
      const moveItem = (t: Todo) => ({
        Update: {
          TableName: table(),
          Key: { PK: artistPk(artistId), SK: todoSk(t.todoId) },
          UpdateExpression: 'SET bmgOwnerSub = :o',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':o': ownerSub },
        },
      });
      const previous = current?.ownerSub
        ? (everyone.find((p) => p.sub === current.ownerSub)?.displayName ?? 'a former team member')
        : undefined;
      const saved = await savePlan({
        principal,
        artistId,
        current,
        content,
        kind: 'edited',
        ...(ownerChanged
          ? {
              owner: ownerSub,
              ...(body.handoverNote ? { ownerNote: body.handoverNote } : {}),
              lead: [ownerChangeLine(previous, owner!.displayName)],
              extra: moving.slice(0, MAX_TODOS_IN_MOVE).map(moveItem),
            }
          : {}),
      });
      // More to-dos than fit in one transaction: the rest follow straight after.
      for (const t of moving.slice(MAX_TODOS_IN_MOVE)) {
        try {
          await db.send(new UpdateCommand(moveItem(t).Update));
        } catch (err) {
          if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
        }
      }
      if (ownerChanged && current) {
        await audit(event, 'plan.owner', 'success', { artistId, moved: moving.length });
      }
      // The owner and the artist hear about it, rolled up over 10 minutes (rev 12).
      if (saved.changeId) await scheduleDigest(artistId, principal.sub, saved.at);
      // The new owner gets a handover summary (also for a new plan someone else will own).
      if (ownerChanged && (current || ownerSub !== principal.sub)) {
        await domainEvent('plan.handover', {
          artistId,
          ...(current?.ownerSub ? { fromSub: current.ownerSub } : {}),
          toSub: ownerSub,
          bySub: principal.sub,
          moved: moving.length,
        });
      }
      const next = { ...content, version: saved.version };
      return json(200, {
        version: next.version,
        gaps: alignmentGaps(next),
        owner: ownerView(owner!),
        moved: moving.length,
      });
    }

    case 'GET /artists/{artistId}/plan/history': {
      // Everyone who can see the plan can see how it changed.
      const artistId = artistIdParam(event);
      ensure(principal, 'read', artistId);
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :log)',
          ExpressionAttributeValues: { ':pk': artistPk(artistId), ':log': PLAN_LOG_PREFIX },
          ScanIndexForward: false,
          Limit: 500,
        }),
      );
      return json(200, {
        changes: ((res.Items ?? []) as PlanChange[]).map(publicChange),
      });
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
        const at = new Date().toISOString();
        const log = await changeEntry(principal, artistId, {
          version: plan.version + 1,
          at,
          kind: 'stage-added',
          changes: planChanges(plan, { ...plan, phases: [...plan.phases, phase] }),
        });
        try {
          await db.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: table(),
                    Key: key,
                    UpdateExpression:
                      'SET phases = list_append(phases, :p), version = :next, updatedAt = :at, updatedBy = :by',
                    ConditionExpression: 'version = :v',
                    ExpressionAttributeValues: {
                      ':p': [phase],
                      ':v': plan.version,
                      ':next': plan.version + 1,
                      ':at': at,
                      ':by': principal.sub,
                    },
                  },
                },
                { Put: { TableName: table(), Item: log } },
              ],
            }),
          );
        } catch (err) {
          if (planConflict(err)) {
            throw new HttpError(409, 'A plan changed while the stage was being added. Try again.');
          }
          throw err;
        }
        result.added.push(artistId);
        await scheduleDigest(artistId, principal.sub, at);
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
      // Looked after on Blueprint's side by the plan owner (rev 12).
      const planOwner = (await loadPlan(artistId))?.ownerSub;
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
          ...(planOwner ? { bmgOwnerSub: planOwner } : {}),
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
      const saved = await scheduleReminder(todo, {
        PK: artistPk(artistId),
        SK: todoSk(todoId),
      });
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
      if (patch.bmgOnly !== undefined && principal.role === 'artist') {
        throw new HttpError(403, 'Only Blueprint can change who sees a to-do');
      }
      // Artists and Blueprint can both edit any to-do they can see (BMG-only
      // ones are invisible to artists, and `ensure` above refuses them).
      const merged: Todo = {
        ...existing,
        ...(patch.bmgOnly !== undefined
          ? { visibility: patch.bmgOnly ? ('bmg-only' as const) : ('normal' as const) }
          : {}),
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
      const visibilityChanged =
        (merged.visibility ?? 'normal') !== (existing.visibility ?? 'normal');
      // Saving unchanged still retries a reminder that couldn't be scheduled.
      if (changed.length === 0 && !visibilityChanged && !existing.reminderFailed)
        return json(200, publicTodo(existing));
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
            'SET title = :title, notes = :notes, done = :done, #due = :due, dueTime = :dueTime, reminder = :reminder, remindAt = :remindAt, visibility = :vis, GSI2SK = :gsi2, updatedAt = :at, updatedBy = :by',
          ExpressionAttributeNames: { '#due': 'due' },
          ExpressionAttributeValues: {
            ':title': updated.title,
            ':vis': updated.visibility ?? 'normal',
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
      const stored = await scheduleReminder(updated, key);
      const notify = changed.length > 0 && notifyOnEdit(principal.role, existing);
      if (notify) {
        await domainEvent('todo.updated', {
          artistId,
          todoId,
          changedFields: changed,
          byRole: principal.role,
          notify,
        });
      }
      await audit(event, 'todo.update', 'success', {
        artistId,
        todoId,
        fields: [...changed, ...(visibilityChanged ? ['visibility'] : [])].join(','),
      });
      return json(200, publicTodo(stored));
    }

    // ── To-do threads (rev 7): artist + Blueprint; BMG-only to-dos stay BMG-only ──
    case 'GET /artists/{artistId}/todos/{todoId}/comments': {
      const artistId = artistIdParam(event);
      const todo = await loadTodoFor(event, artistId);
      ensure(principal, 'read', artistId, todo.visibility);
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
          ExpressionAttributeValues: {
            ':pk': artistPk(artistId),
            ':c': todoCommentPrefix(todo.todoId),
          },
          Limit: 500,
        }),
      );
      const thread = threadOf((res.Items ?? []) as TodoComment[]).map((c) => ({
        ...publicComment(c, principal.sub),
        replies: c.replies.map((r) => publicComment(r, principal.sub)),
      }));
      return json(200, { thread });
    }

    case 'POST /artists/{artistId}/todos/{todoId}/comments': {
      const artistId = artistIdParam(event);
      const todo = await loadTodoFor(event, artistId);
      // Anyone who can see the to-do can talk about it.
      ensure(principal, 'read', artistId, todo.visibility);
      const body = parseBody(event, CommentCreate);
      if (body.parentId) {
        const parent = await db.send(
          new QueryCommand({
            TableName: table(),
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
            FilterExpression: 'commentId = :id',
            ExpressionAttributeValues: {
              ':pk': artistPk(artistId),
              ':c': todoCommentPrefix(todo.todoId),
              ':id': body.parentId,
            },
          }),
        );
        if (!parent.Items?.length) throw new HttpError(400, 'That comment is no longer there');
      }
      const createdAt = new Date().toISOString();
      const authorName =
        principal.role === 'artist'
          ? String(
              (
                await db.send(
                  new GetCommand({
                    TableName: table(),
                    Key: { PK: artistPk(artistId), SK: 'PROFILE' },
                  }),
                )
              ).Item?.displayName ?? 'Artist',
            )
          : 'Blueprint';
      const comment: TodoComment = {
        commentId: newId(),
        todoId: todo.todoId,
        artistId,
        ...(body.parentId ? { parentId: body.parentId } : {}),
        text: body.text,
        authorSub: principal.sub,
        authorRole: principal.role,
        authorName,
        createdAt,
      };
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            PK: artistPk(artistId),
            SK: todoCommentSk(todo.todoId, createdAt, comment.commentId),
            type: 'todo-comment',
            ...comment,
          },
        }),
      );
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: artistPk(artistId), SK: todoSk(todo.todoId) },
          UpdateExpression: 'ADD commentCount :one SET lastCommentAt = :at',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':one': 1, ':at': createdAt },
        }),
      );
      await domainEvent('todo.commented', {
        artistId,
        todoId: todo.todoId,
        title: todo.title,
        authorSub: principal.sub,
        authorName,
        byRole: principal.role,
        bmgOnly: todo.visibility === 'bmg-only',
      });
      return json(201, publicComment(comment, principal.sub));
    }

    case 'DELETE /artists/{artistId}/todos/{todoId}/comments/{commentId}': {
      const artistId = artistIdParam(event);
      const todo = await loadTodoFor(event, artistId);
      ensure(principal, 'read', artistId, todo.visibility);
      const commentId = event.pathParameters?.commentId ?? '';
      if (!/^[a-z0-9]{10,40}$/.test(commentId)) throw new HttpError(404, 'No such comment');
      const found = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
          FilterExpression: 'commentId = :id',
          ExpressionAttributeValues: {
            ':pk': artistPk(artistId),
            ':c': todoCommentPrefix(todo.todoId),
            ':id': commentId,
          },
        }),
      );
      const item = found.Items?.[0] as (TodoComment & { SK: string }) | undefined;
      if (!item || item.deletedAt) throw new HttpError(404, 'No such comment');
      // People remove their own comments; a BMG admin can remove any.
      if (item.authorSub !== principal.sub && principal.role !== 'bmg-admin')
        throw new HttpError(403, 'You can only remove your own comments');
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: artistPk(artistId), SK: item.SK },
          UpdateExpression: 'SET deletedAt = :at, #t = :empty',
          ExpressionAttributeNames: { '#t': 'text' },
          ExpressionAttributeValues: { ':at': new Date().toISOString(), ':empty': '' },
        }),
      );
      return json(200, { deleted: commentId });
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
