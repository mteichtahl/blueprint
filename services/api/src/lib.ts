import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Principal, Role } from '@bmg/authz';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { z } from 'zod';

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const events = new EventBridgeClient({});

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Values the authorizer puts in the request context (design 7.2). Never taken from the request body. */
export interface AuthContext {
  sub: string;
  role: Role;
  artistId?: string;
  mfaLevel: 'cognito' | 'federated';
  mfaSatisfied: boolean;
  /** Epoch seconds of the last sign-in or step-up. */
  authTime: number;
  /** Stable id of the sign-in session (`origin_jti`), used for step-up state. */
  sessionId: string;
}

export function authContext(event: APIGatewayProxyEvent): AuthContext {
  const c = (event.requestContext.authorizer ?? {}) as Record<string, string | undefined>;
  if (!c.sub || !c.role || !c.sessionId) throw new HttpError(401, 'Not signed in');
  return {
    sub: c.sub,
    role: c.role as Role,
    ...(c.artistId ? { artistId: c.artistId } : {}),
    mfaLevel: c.mfaLevel === 'federated' ? 'federated' : 'cognito',
    mfaSatisfied: c.mfaSatisfied === 'true',
    authTime: Number(c.authTime ?? 0),
    sessionId: c.sessionId,
  };
}

/** Staff assignments live in the main table as STAFF#<sub> / ASSIGN#<artistId>. */
export async function principalFor(ctx: AuthContext): Promise<Principal> {
  let assignedArtistIds: string[] | undefined;
  if (ctx.role === 'bmg-staff') {
    const res = await db.send(
      new GetCommand({
        TableName: env('MAIN_TABLE'),
        Key: { PK: `STAFF#${ctx.sub}`, SK: 'ASSIGNMENTS' },
      }),
    );
    assignedArtistIds = (res.Item?.artistIds as string[] | undefined) ?? [];
  }
  return {
    sub: ctx.sub,
    role: ctx.role,
    ...(ctx.artistId ? { artistId: ctx.artistId } : {}),
    ...(assignedArtistIds ? { assignedArtistIds } : {}),
    mfaSatisfied: ctx.mfaSatisfied,
    secondsSinceAuth: Math.max(0, Math.floor(Date.now() / 1000) - ctx.authTime),
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  429: 'Too many requests',
  500: 'Internal error',
};

/** RFC 9457 problem+json. No stack traces or internal ids reach the client (design 7.2). */
export function problem(status: number, detail?: string): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    body: JSON.stringify({
      type: 'about:blank',
      title: TITLES[status] ?? 'Error',
      status,
      ...(detail ? { detail } : {}),
    }),
  };
}

export function json(status: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export function parseBody<T extends z.ZodType>(event: APIGatewayProxyEvent, schema: T): z.infer<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(event.body ?? '{}');
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));
  return parsed.data;
}

/** Wraps a handler: maps HttpError to problem+json and hides everything else. */
export function handle(fn: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>) {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) return problem(err.status, err.message);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'api.unhandled',
          requestId: event.requestContext?.requestId,
          name: (err as Error).name,
        }),
      );
      return problem(500);
    }
  };
}

export type AuditOutcome = 'success' | 'denied' | 'failed';

/**
 * Writes a security event to the environment's bus; a rule delivers it to the
 * Object Lock audit archive (design 15). Ids only, no personal data.
 */
export async function audit(
  event: APIGatewayProxyEvent,
  action: string,
  outcome: AuditOutcome,
  fields: Record<string, string | number | boolean> = {},
): Promise<void> {
  const ctx = event.requestContext.authorizer as Record<string, string> | undefined;
  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: env('EVENT_BUS'),
          Source: 'bmg.audit',
          DetailType: action,
          Detail: JSON.stringify({
            id: randomUUID(),
            at: new Date().toISOString(),
            action,
            outcome,
            actorSub: ctx?.sub,
            actorRole: ctx?.role,
            requestId: event.requestContext.requestId,
            sourceIpHash: hashIp(event.requestContext.identity?.sourceIp),
            ...fields,
          }),
        },
      ],
    }),
  );
}

/** One-way hash of the caller's IP: enough to correlate events, not to identify a person. */
export function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash('sha256').update(`bmg-ip:${ip}`).digest('hex').slice(0, 16);
}
