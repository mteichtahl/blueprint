import { createHash, randomUUID } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import { BatchWriteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { render } from '@bmg/prompts';
import {
  ACTION_TOKEN_SECONDS,
  actionsHash,
  ActionList,
  type AgentReply,
} from '@bmg/prompts/actions';
import {
  canUseAssistant,
  ChatBody,
  claimsBytes,
  encodeToken,
  HISTORY_DAYS,
  historyPk,
  SessionId,
  sessionId as newSessionId,
} from '../ai/model.ts';
import { aiStates, livePrompt, toolDescriptions } from '../ai/prompts.ts';
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
import { artistPk, PLAN_SK, type Plan } from '../workspace/model.ts';

/**
 * POST /ai/chat (design 10, F4). Checks who is asking and their AI consent,
 * fills in the published prompt, and asks the agent on AgentCore Runtime. The
 * agent can only read through `/ai/tools/*` with the person's own token, and
 * can only propose actions: the reply carries a checklist and a single-use
 * token that /ai/actions/confirm needs within 60 seconds.
 *
 * Neither prompts nor replies are logged (design 10.5). The person's own
 * history is kept for 30 days so the panel can reopen a conversation.
 */

const agentcore = new BedrockAgentCoreClient({});
const kms = new KMSClient({});
const table = () => env('MAIN_TABLE');

function today() {
  return new Date().toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Melbourne',
  });
}

/** Stable per person and conversation; AgentCore needs at least 33 characters. */
const runtimeSession = (sub: string, sid: string) =>
  createHash('sha256').update(`${sub}:${sid}`).digest('hex');

function bearer(event: { headers?: Record<string, string | undefined> | null }) {
  const h = event.headers?.Authorization ?? event.headers?.authorization ?? '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (token.length < 20) throw new HttpError(401, 'Sign in again');
  return token;
}

function apiUrl(event: { requestContext: { domainName?: string; stage?: string } }) {
  const { domainName, stage } = event.requestContext;
  if (!domainName) throw new Error('No API domain');
  return `https://${domainName}/${stage ?? ''}`.replace(/\/$/, '');
}

export const handler = handle(async (event) => {
  const ctx = authContext(event);
  const principal = await principalFor(ctx);
  const route = `${event.httpMethod} ${event.resource}`;

  if (route === 'GET /ai/chat/history') {
    const sid = SessionId.safeParse(event.queryStringParameters?.sessionId);
    if (!sid.success) throw new HttpError(400, 'Unknown conversation');
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':pk': historyPk(ctx.sub), ':s': `S#${sid.data}#` },
        Limit: 100,
      }),
    );
    return json(200, {
      messages: (res.Items ?? []).map((m) => ({ from: m.from, text: m.text, at: m.at })),
    });
  }
  if (route !== 'POST /ai/chat') throw new HttpError(404, 'Not found');

  const artistOptedIn = principal.artistId
    ? ((await aiStates([principal.artistId]))[principal.artistId] ?? false)
    : false;
  const refused = canUseAssistant(principal, artistOptedIn);
  if (refused) throw new HttpError(403, refused);

  const body = parseBody(event, ChatBody);
  const sid = body.sessionId ?? newSessionId();

  // Fill in the published prompt with what this feature supplies (design 10.6).
  let systemPrompt: string;
  if (principal.role === 'artist') {
    const pk = artistPk(principal.artistId!);
    const [profile, plan] = await Promise.all([
      db.send(new GetCommand({ TableName: table(), Key: { PK: pk, SK: 'PROFILE' } })),
      db.send(new GetCommand({ TableName: table(), Key: { PK: pk, SK: PLAN_SK } })),
    ]);
    const p = plan.Item as Plan | undefined;
    const current = p?.phases.find((ph) => ph.milestones.some((m) => !m.done)) ?? p?.phases.at(-1);
    const artistName = String(profile.Item?.displayName ?? 'the artist');
    systemPrompt = render(await livePrompt('assistant.artist'), {
      today: today(),
      userName: artistName,
      artistName,
      planPhase: current?.name ?? 'getting started',
    });
  } else {
    systemPrompt = render(await livePrompt('assistant.bmg'), {
      today: today(),
      userName: String(event.requestContext.authorizer?.name ?? 'the Blueprint team'),
    });
  }

  let reply: AgentReply;
  try {
    const res = await agentcore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: env('AGENT_RUNTIME_ARN'),
        runtimeSessionId: runtimeSession(ctx.sub, sid),
        runtimeUserId: ctx.sub,
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(
          JSON.stringify({
            message: body.message,
            token: bearer(event),
            apiUrl: apiUrl(event),
            systemPrompt,
            toolDescriptions: await toolDescriptions(),
            role: principal.role,
            ...(principal.artistId ? { artistId: principal.artistId } : {}),
          }),
        ),
      }),
    );
    const text = (await res.response?.transformToString()) ?? '{}';
    reply = JSON.parse(text) as AgentReply;
  } catch (err) {
    console.error(
      JSON.stringify({ level: 'error', msg: 'agent call failed', error: (err as Error).name }),
    );
    await audit(event, 'ai.chat', 'failed', { sessionId: sid });
    throw new HttpError(502, 'The assistant is unavailable right now. Try again in a moment.');
  }

  // Re-validate what the agent proposed: anything malformed is dropped.
  const parsed = ActionList.safeParse(reply.actions ?? []);
  const actions = parsed.success ? parsed.data : [];
  let actionToken: string | undefined;
  if (actions.length) {
    const claims = {
      sub: ctx.sub,
      sid,
      h: actionsHash(actions),
      exp: Math.floor(Date.now() / 1000) + ACTION_TOKEN_SECONDS,
      jti: randomUUID(),
    };
    const mac = await kms.send(
      new GenerateMacCommand({
        KeyId: env('ACTION_KEY_ID'),
        MacAlgorithm: 'HMAC_SHA_256',
        Message: claimsBytes(claims),
      }),
    );
    actionToken = encodeToken(claims, mac.Mac!);
  }

  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + HISTORY_DAYS * 86_400;
  const at = now.toISOString();
  await db.send(
    new BatchWriteCommand({
      RequestItems: {
        [table()]: [
          { from: 'me', text: body.message, at },
          { from: 'ai', text: reply.reply, at: new Date(now.getTime() + 1).toISOString() },
        ].map((m) => ({
          PutRequest: {
            Item: {
              PK: historyPk(ctx.sub),
              SK: `S#${sid}#${m.at}`,
              type: 'aiMessage',
              ...m,
              ttl,
            },
          },
        })),
      },
    }),
  );
  await audit(event, 'ai.chat', 'success', {
    sessionId: sid,
    tools: (reply.toolsUsed ?? []).join(',').slice(0, 200),
    proposed: actions.length,
  });
  return json(200, {
    sessionId: sid,
    reply: reply.reply,
    actions,
    ...(actionToken ? { actionToken } : {}),
  });
});
