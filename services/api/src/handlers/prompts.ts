import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { authorize, type Action, type Principal } from '@bmg/authz';
import {
  MAX_PROMPT_CHARS,
  PLATFORM_RULES,
  PROMPTS,
  promptDef,
  unknownVariables,
  type PromptDef,
} from '@bmg/prompts';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { z } from 'zod';
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

/**
 * Settings → AI prompts (design 10.6). Each save of a draft is kept on the
 * prompt; publishing turns the draft into a new immutable version and makes it
 * live. Rollback points "live" at any earlier version. The agent reads the
 * live version (cached 60 s), falling back to the built-in default.
 */

const table = () => env('MAIN_TABLE');
const pk = (id: string) => `PROMPT#${id}`;
const versionSk = (n: number) => `VERSION#${String(n).padStart(5, '0')}`;

interface Meta {
  liveVersion?: number;
  latestVersion?: number;
  draft?: { text: string; note: string; by: string; at: string };
  publishedAt?: string;
  publishedBy?: string;
}
interface Version {
  version: number;
  text: string;
  note: string;
  editor: string;
  at: string;
}

const Note = z.string().trim().max(300).default('');
const DraftBody = z.object({ text: z.string().max(MAX_PROMPT_CHARS), note: Note }).strict();
const PublishBody = z.object({ note: Note }).strict();
const RollbackBody = z.object({ version: z.number().int().min(1) }).strict();

function ensure(principal: Principal, action: Action) {
  const d = authorize(principal, action, { kind: 'ai-prompt' });
  if (!d.allow) throw new HttpError(403, d.reason);
}

function defParam(event: APIGatewayProxyEvent): PromptDef {
  const def = promptDef(event.pathParameters?.promptId ?? '');
  if (!def) throw new HttpError(404, 'No such prompt');
  return def;
}

async function loadMeta(id: string): Promise<Meta> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: pk(id), SK: 'META' } }),
  );
  return (res.Item ?? {}) as Meta;
}

function checkText(def: PromptDef, text: string) {
  if (!text.trim()) throw new HttpError(400, 'A prompt cannot be empty');
  const unknown = unknownVariables(text, def.variables);
  if (unknown.length) {
    throw new HttpError(
      400,
      `${unknown.map((v) => `{{${v}}}`).join(', ')} ${unknown.length === 1 ? "isn't" : "aren't"} available here. Use: ${def.variables.map((v) => `{{${v}}}`).join(', ') || 'no variables'}`,
    );
  }
}

const summary = (def: PromptDef, m: Meta) => ({
  id: def.id,
  label: def.label,
  usedBy: def.usedBy,
  variables: def.variables,
  liveVersion: m.liveVersion ?? null,
  latestVersion: m.latestVersion ?? 0,
  hasDraft: !!m.draft,
  publishedAt: m.publishedAt ?? null,
});

export const handler = handle(async (event) => {
  const principal = await principalFor(authContext(event));
  const route = `${event.httpMethod} ${event.resource}`;
  const now = new Date().toISOString();

  switch (route) {
    case 'GET /ai/prompts': {
      ensure(principal, 'read');
      const metas = await Promise.all(PROMPTS.map((p) => loadMeta(p.id)));
      return json(200, {
        prompts: PROMPTS.map((p, i) => summary(p, metas[i]!)),
        platformRules: PLATFORM_RULES,
      });
    }

    case 'GET /ai/prompts/{promptId}': {
      ensure(principal, 'read');
      const def = defParam(event);
      const [meta, res] = await Promise.all([
        loadMeta(def.id),
        db.send(
          new QueryCommand({
            TableName: table(),
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :v)',
            ExpressionAttributeValues: { ':pk': pk(def.id), ':v': 'VERSION#' },
            ScanIndexForward: false,
            Limit: 100,
          }),
        ),
      ]);
      const versions = ((res.Items ?? []) as Version[]).map(
        ({ version, text, note, editor, at }) => ({
          version,
          text,
          note,
          editor,
          at,
        }),
      );
      const live = versions.find((v) => v.version === meta.liveVersion);
      return json(200, {
        ...summary(def, meta),
        defaultText: def.defaultText,
        liveText: live?.text ?? def.defaultText,
        draft: meta.draft ?? null,
        versions,
        platformRules: PLATFORM_RULES,
      });
    }

    case 'PUT /ai/prompts/{promptId}/draft': {
      ensure(principal, 'write');
      const def = defParam(event);
      const body = parseBody(event, DraftBody);
      checkText(def, body.text);
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: pk(def.id), SK: 'META' },
          UpdateExpression: 'SET draft = :d, #t = :t',
          ExpressionAttributeNames: { '#t': 'type' },
          ExpressionAttributeValues: {
            ':d': { text: body.text, note: body.note, by: principal.sub, at: now },
            ':t': 'prompt',
          },
        }),
      );
      await audit(event, 'ai.promptDrafted', 'success', { promptId: def.id });
      return json(200, { ok: true });
    }

    case 'DELETE /ai/prompts/{promptId}/draft': {
      ensure(principal, 'write');
      const def = defParam(event);
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: pk(def.id), SK: 'META' },
          UpdateExpression: 'REMOVE draft',
        }),
      );
      return json(200, { ok: true });
    }

    case 'POST /ai/prompts/{promptId}/publish': {
      const def = defParam(event);
      try {
        ensure(principal, 'admin');
      } catch (err) {
        await audit(event, 'ai.promptPublished', 'denied', { promptId: def.id });
        throw err;
      }
      const body = parseBody(event, PublishBody);
      const meta = await loadMeta(def.id);
      if (!meta.draft) throw new HttpError(409, 'There is no draft to publish');
      checkText(def, meta.draft.text);
      const latest = meta.latestVersion ?? 0;
      const version = latest + 1;
      try {
        await db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table(),
                  Item: {
                    PK: pk(def.id),
                    SK: versionSk(version),
                    type: 'promptVersion',
                    version,
                    text: meta.draft.text,
                    note: body.note || meta.draft.note,
                    editor: principal.sub,
                    draftedBy: meta.draft.by,
                    at: now,
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Update: {
                  TableName: table(),
                  Key: { PK: pk(def.id), SK: 'META' },
                  UpdateExpression:
                    'SET liveVersion = :v, latestVersion = :v, publishedAt = :at, publishedBy = :by REMOVE draft',
                  ConditionExpression:
                    'attribute_not_exists(latestVersion) OR latestVersion = :latest',
                  ExpressionAttributeValues: {
                    ':v': version,
                    ':latest': latest,
                    ':at': now,
                    ':by': principal.sub,
                  },
                },
              },
            ],
          }),
        );
      } catch (err) {
        if ((err as Error).name === 'TransactionCanceledException') {
          throw new HttpError(
            409,
            'Someone else published this prompt just now. Reload and try again.',
          );
        }
        throw err;
      }
      await audit(event, 'ai.promptPublished', 'success', { promptId: def.id, version });
      return json(200, { liveVersion: version });
    }

    case 'POST /ai/prompts/{promptId}/rollback': {
      const def = defParam(event);
      try {
        ensure(principal, 'admin');
      } catch (err) {
        await audit(event, 'ai.promptRolledBack', 'denied', { promptId: def.id });
        throw err;
      }
      const { version } = parseBody(event, RollbackBody);
      const meta = await loadMeta(def.id);
      if (version > (meta.latestVersion ?? 0)) throw new HttpError(404, 'No such version');
      await db.send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: pk(def.id), SK: 'META' },
          UpdateExpression: 'SET liveVersion = :v, publishedAt = :at, publishedBy = :by',
          ConditionExpression: 'latestVersion >= :v',
          ExpressionAttributeValues: { ':v': version, ':at': now, ':by': principal.sub },
        }),
      );
      await audit(event, 'ai.promptRolledBack', 'success', {
        promptId: def.id,
        from: meta.liveVersion ?? 0,
        to: version,
      });
      return json(200, { liveVersion: version });
    }

    default:
      throw new HttpError(404, 'Not found');
  }
});
