import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent, BedrockModel } from '@strands-agents/sdk';
import { Invocation, type AgentReply } from '@bmg/prompts/actions';
import { buildTools, type TurnContext } from './tools.ts';

/**
 * Blueprint AI on AgentCore Runtime (design 10.1), direct code deployment on
 * Node 22. HTTP contract: GET /ping, POST /invocations on port 8080.
 *
 * Only the API's chat function can invoke this runtime (IAM). It has already
 * checked who the person is and their AI consent, and it passes the published
 * prompts. Each AgentCore session runs in its own microVM, so the agent (and
 * its conversation) lives for that one person's session only.
 */

const MODEL_ID = process.env.MODEL_ID ?? 'au.anthropic.claude-sonnet-5-5';
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION ?? 'DRAFT';
const MAX_BODY = 64 * 1024;

let current: TurnContext | undefined;
let agent: Agent | undefined;
let agentKey = '';

function turn(): TurnContext {
  if (!current) throw new Error('No turn in progress');
  return current;
}

function agentFor(inv: Invocation): Agent {
  // One person per session; rebuild only if the prompt or role changed.
  const key = `${inv.role}|${inv.artistId ?? ''}|${inv.systemPrompt}`;
  if (agent && key === agentKey) return agent;
  agentKey = key;
  agent = new Agent({
    model: new BedrockModel({
      region: process.env.AWS_REGION ?? 'ap-southeast-2',
      modelId: MODEL_ID,
      maxTokens: 2048,
      temperature: 0.3,
      ...(GUARDRAIL_ID
        ? {
            guardrailConfig: {
              guardrailIdentifier: GUARDRAIL_ID,
              guardrailVersion: GUARDRAIL_VERSION,
              trace: 'disabled' as const,
              redaction: { input: true, output: true },
            },
          }
        : {}),
    }),
    systemPrompt: inv.systemPrompt,
    tools: buildTools(turn),
    printer: false,
  });
  return agent;
}

export async function runTurn(inv: Invocation): Promise<AgentReply> {
  current = {
    apiUrl: inv.apiUrl,
    token: inv.token,
    role: inv.role,
    ...(inv.artistId ? { artistId: inv.artistId } : {}),
    descriptions: inv.toolDescriptions,
    proposed: [],
    toolsUsed: new Set(),
  };
  try {
    const result = await agentFor(inv).invoke(inv.message);
    return {
      reply: String(result).trim(),
      actions: current.proposed,
      toolsUsed: [...current.toolsUsed],
    };
  } finally {
    current = undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error('Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

let busy = false;

export const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    return send(res, 200, { status: busy ? 'HealthyBusy' : 'Healthy' });
  }
  if (req.method !== 'POST' || req.url !== '/invocations') return send(res, 404, {});
  void (async () => {
    busy = true;
    try {
      const parsed = Invocation.safeParse(JSON.parse(await readBody(req)));
      if (!parsed.success) return send(res, 400, { error: 'Bad invocation' });
      send(res, 200, await runTurn(parsed.data));
    } catch (err) {
      // Log the error type only: prompts and replies are never logged (design 10.5).
      console.error(JSON.stringify({ level: 'error', error: (err as Error).name }));
      send(res, 500, { error: 'The assistant hit a problem. Try again.' });
    } finally {
      busy = false;
    }
  })();
});

if (process.env.NODE_ENV !== 'test') server.listen(8080, '0.0.0.0');
