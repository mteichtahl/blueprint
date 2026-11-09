import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { authorize, type Action, type Principal } from '@bmg/authz';
import {
  artistKeyAlias,
  DataAccessSessions,
  decryptForArtist,
  encryptForArtist,
  isArtistId,
} from '@bmg/crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  bmgChangedTiming,
  byPriorityThenDate,
  FeedbackBody,
  patchAllowed,
  publicSubmission,
  queuePk,
  queueSk,
  SUBMISSION_ID_PATTERN,
  SubmissionCreate,
  SubmissionPatch,
  submissionSk,
  type Submission,
  type SubmissionStatus,
} from '../review/model.ts';
import { fileSk } from '../files/model.ts';
import {
  artistPk,
  newId,
  todoGsi2Sk,
  todoSk,
  TODOS_GSI2PK,
  type Todo,
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

const sessions = new DataAccessSessions();
const events = new EventBridgeClient({});
const table = () => env('MAIN_TABLE');

function artistIdParam(event: APIGatewayProxyEvent): string {
  const id = event.pathParameters?.artistId;
  if (!isArtistId(id)) throw new HttpError(404, 'No such artist');
  return id;
}

function submissionIdParam(event: APIGatewayProxyEvent): string {
  const id = event.pathParameters?.submissionId ?? '';
  if (!SUBMISSION_ID_PATTERN.test(id)) throw new HttpError(404, 'No such submission');
  return id;
}

function ensure(principal: Principal, action: Action, artistId: string) {
  const d = authorize(principal, action, { kind: 'artist-data', artistId, visibility: 'normal' });
  if (!d.allow) throw new HttpError(403, d.reason);
}

/** Notes and feedback are sealed with the artist's own key, in a session for the caller (design F3, 9.1). */
async function cipher(principal: Principal, artistId: string) {
  const credentials = await sessions.credentials({
    roleArn: env('DATA_ACCESS_ROLE_ARN'),
    artistId,
    role: principal.role,
  });
  const alias = artistKeyAlias(env('PROJECT'), env('BMG_ENV'), artistId);
  const opts = {
    keyId: `arn:aws:kms:${env('AWS_REGION')}:${env('ACCOUNT_ID')}:${alias}`,
    artistId,
    credentials,
  };
  return {
    seal: (text: string) => encryptForArtist(opts, text),
    open: async (blob: Uint8Array | undefined) =>
      blob ? Buffer.from((await decryptForArtist(opts, blob)).plaintext).toString('utf8') : '',
  };
}

async function load(artistId: string, submissionId: string): Promise<Submission> {
  const res = await db.send(
    new GetCommand({
      TableName: table(),
      Key: { PK: artistPk(artistId), SK: submissionSk(submissionId) },
    }),
  );
  if (!res.Item) throw new HttpError(404, 'No such submission');
  return res.Item as Submission;
}

/** Domain events for notifications (design 7.3); ids only. */
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

/** Only files from the artist's own library that are ready can be attached. */
async function checkFiles(artistId: string, fileIds: string[]) {
  if (fileIds.length === 0) return;
  const res = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [table()]: { Keys: fileIds.map((id) => ({ PK: artistPk(artistId), SK: fileSk(id) })) },
      },
    }),
  );
  const found = res.Responses?.[table()] ?? [];
  const ok = found.filter((f) => f.status === 'available' && f.visibility !== 'private');
  if (ok.length !== new Set(fileIds).size) {
    throw new HttpError(400, 'Attach files from your library that are ready and not private');
  }
}

/**
 * Submissions and the review queue. Artists submit and edit their own while
 * open; BMG can change priority and date and gives feedback, which becomes
 * to-dos in one transaction.
 */
export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const route = `${event.httpMethod} ${event.resource}`;
  const now = () => new Date().toISOString();

  switch (route) {
    case 'GET /review-queue': {
      if (principal.role === 'artist')
        throw new HttpError(403, 'The review queue is for Blueprint');
      const status: SubmissionStatus =
        event.queryStringParameters?.status === 'reviewed' ? 'reviewed' : 'open';
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          IndexName: 'GSI3',
          KeyConditionExpression: 'GSI3PK = :pk',
          ExpressionAttributeValues: { ':pk': queuePk(status) },
          // Reviewed items: most recent first is more useful than priority.
          ScanIndexForward: status === 'open',
          Limit: 500,
        }),
      );
      const submissions = ((res.Items ?? []) as Submission[])
        .filter(
          (s) =>
            authorize(principal, 'read', {
              kind: 'artist-data',
              artistId: s.artistId,
              visibility: 'normal',
            }).allow,
        )
        .map(publicSubmission);
      return json(200, { submissions });
    }

    case 'GET /artists/{artistId}/submissions': {
      const artistId = artistIdParam(event);
      ensure(principal, 'read', artistId);
      const res = await db.send(
        new QueryCommand({
          TableName: table(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
          ExpressionAttributeValues: { ':pk': artistPk(artistId), ':s': 'SUB#' },
          Limit: 300,
        }),
      );
      const all = (res.Items ?? []) as Submission[];
      const open = all.filter((s) => s.status === 'open').sort(byPriorityThenDate);
      const reviewed = all
        .filter((s) => s.status === 'reviewed')
        .sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? ''));
      return json(200, { submissions: [...open, ...reviewed].map(publicSubmission) });
    }

    case 'POST /artists/{artistId}/submissions': {
      const artistId = artistIdParam(event);
      ensure(principal, 'write', artistId);
      if (principal.role !== 'artist') throw new HttpError(403, 'Submissions come from the artist');
      const body = parseBody(event, SubmissionCreate);
      await checkFiles(artistId, body.fileIds);
      const submissionId = newId();
      const sub: Submission = {
        submissionId,
        artistId,
        title: body.title,
        submissionType: body.type,
        priority: body.priority,
        neededBy: body.neededBy,
        ...(body.phaseId ? { phaseId: body.phaseId } : {}),
        fileIds: [...new Set(body.fileIds)],
        ...(body.note
          ? { noteCipher: await (await cipher(principal, artistId)).seal(body.note) }
          : {}),
        status: 'open',
        createdBy: principal.sub,
        createdAt: now(),
      };
      await db.send(
        new PutCommand({
          TableName: table(),
          Item: {
            PK: artistPk(artistId),
            SK: submissionSk(submissionId),
            type: 'submission',
            ...sub,
            GSI3PK: queuePk('open'),
            GSI3SK: queueSk(sub),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      await domainEvent('submission.created', { artistId, submissionId, priority: sub.priority });
      return json(201, publicSubmission(sub));
    }

    case 'GET /artists/{artistId}/submissions/{submissionId}': {
      const artistId = artistIdParam(event);
      ensure(principal, 'read', artistId);
      const sub = await load(artistId, submissionIdParam(event));
      const c = await cipher(principal, artistId);
      return json(200, {
        ...publicSubmission(sub),
        note: await c.open(sub.noteCipher),
        feedback: sub.feedbackCipher ? await c.open(sub.feedbackCipher) : null,
      });
    }

    case 'PATCH /artists/{artistId}/submissions/{submissionId}': {
      const artistId = artistIdParam(event);
      ensure(principal, 'write', artistId);
      const sub = await load(artistId, submissionIdParam(event));
      const patch = parseBody(event, SubmissionPatch);
      const refused = patchAllowed(principal.role, sub.status, patch);
      if (refused) throw new HttpError(409, refused);
      const next = {
        ...sub,
        ...(patch.priority ? { priority: patch.priority } : {}),
        ...(patch.neededBy ? { neededBy: patch.neededBy } : {}),
        ...(patch.title ? { title: patch.title } : {}),
      };
      const told = bmgChangedTiming(principal.role, sub, patch);
      const noteCipher =
        patch.note !== undefined && patch.note !== ''
          ? await (await cipher(principal, artistId)).seal(patch.note)
          : undefined;
      try {
        await db.send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: artistPk(artistId), SK: submissionSk(sub.submissionId) },
            UpdateExpression: [
              'SET priority = :p, neededBy = :d, title = :t, GSI3SK = :sk, updatedAt = :at',
              told ? ', changedByBmgAt = :at' : '',
              noteCipher ? ', noteCipher = :n' : '',
              patch.note === '' ? ' REMOVE noteCipher' : '',
            ].join(''),
            ConditionExpression: '#s = :open',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':p': next.priority,
              ':d': next.neededBy,
              ':t': next.title,
              ':sk': queueSk(next),
              ':at': now(),
              ':open': 'open',
              ...(noteCipher ? { ':n': noteCipher } : {}),
            },
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'ConditionalCheckFailedException') {
          throw new HttpError(409, 'This submission has already been reviewed');
        }
        throw err;
      }
      if (told) {
        await domainEvent('submission.updated', {
          artistId,
          submissionId: sub.submissionId,
          priority: next.priority,
          neededBy: next.neededBy,
          byRole: principal.role,
        });
      }
      return json(200, publicSubmission({ ...next, ...(told ? { changedByBmgAt: now() } : {}) }));
    }

    case 'POST /artists/{artistId}/submissions/{submissionId}/feedback': {
      const artistId = artistIdParam(event);
      ensure(principal, 'write', artistId);
      if (principal.role === 'artist') throw new HttpError(403, 'Feedback comes from Blueprint');
      const sub = await load(artistId, submissionIdParam(event));
      if (sub.status !== 'open') throw new HttpError(409, 'Feedback has already been given');
      const body = parseBody(event, FeedbackBody);
      const feedbackCipher = body.comment
        ? await (await cipher(principal, artistId)).seal(body.comment)
        : undefined;
      const at = now();
      const todos: Todo[] = body.points.map((p) => ({
        todoId: newId(),
        artistId,
        title: p.title,
        ...(p.due ? { due: p.due } : {}),
        ...(sub.phaseId ? { phaseId: sub.phaseId } : {}),
        submissionId: sub.submissionId,
        done: false,
        source: 'feedback',
        visibility: 'normal',
        createdBy: principal.sub,
        createdAt: at,
      }));
      const reviewed = { ...sub, status: 'reviewed' as const };
      try {
        await db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: table(),
                  Key: { PK: artistPk(artistId), SK: submissionSk(sub.submissionId) },
                  UpdateExpression:
                    'SET #s = :reviewed, reviewedAt = :at, reviewedBy = :by, feedbackTodoIds = :ids, GSI3PK = :pk, GSI3SK = :sk' +
                    (feedbackCipher ? ', feedbackCipher = :f' : ''),
                  ConditionExpression: '#s = :open',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: {
                    ':reviewed': 'reviewed',
                    ':open': 'open',
                    ':at': at,
                    ':by': principal.sub,
                    ':ids': todos.map((t) => t.todoId),
                    ':pk': queuePk('reviewed'),
                    // Reviewed items sort by review time.
                    ':sk': `${at}#${artistId}#${sub.submissionId}`,
                    ...(feedbackCipher ? { ':f': feedbackCipher } : {}),
                  },
                },
              },
              ...todos.map((t) => ({
                Put: {
                  TableName: table(),
                  Item: {
                    PK: artistPk(artistId),
                    SK: todoSk(t.todoId),
                    type: 'todo',
                    ...t,
                    GSI2PK: TODOS_GSI2PK,
                    GSI2SK: todoGsi2Sk(t.due, artistId, t.todoId),
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              })),
            ],
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'TransactionCanceledException') {
          throw new HttpError(409, 'Feedback has already been given');
        }
        throw err;
      }
      await domainEvent('submission.feedbackGiven', {
        artistId,
        submissionId: sub.submissionId,
        todos: todos.length,
      });
      await audit(event, 'submission.feedback', 'success', {
        artistId,
        submissionId: sub.submissionId,
        todos: todos.length,
      });
      return json(200, {
        ...publicSubmission({
          ...reviewed,
          reviewedAt: at,
          feedbackTodoIds: todos.map((t) => t.todoId),
        }),
        todos: todos.map((t) => ({ todoId: t.todoId, title: t.title, due: t.due ?? null })),
      });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
