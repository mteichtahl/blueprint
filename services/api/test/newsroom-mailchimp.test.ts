import type { APIGatewayProxyEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Sending the approved newsletter through Mailchimp (Newsroom). */

const items = new Map<string, Record<string, unknown>>();
const calls: string[] = [];

vi.mock('../src/lib.ts', async (orig) => {
  const real = await orig<typeof import('../src/lib.ts')>();
  return {
    ...real,
    env: (n: string) => n.toLowerCase(),
    audit: async () => {},
    principalFor: async () => ({
      sub: 'kyra',
      role: 'bmg-admin',
      mfaSatisfied: true,
      secondsSinceAuth: 10,
    }),
    db: {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        const i = cmd.input as {
          Key: { PK: string; SK: string };
          ExpressionAttributeValues: Record<string, unknown>;
        };
        const key = `${i.Key.PK}|${i.Key.SK}`;
        if (cmd.constructor.name === 'GetCommand') return { Item: structuredClone(items.get(key)) };
        if (cmd.constructor.name === 'UpdateCommand') {
          items.get(key)!.mailchimp = i.ExpressionAttributeValues[':m'];
          return {};
        }
        throw new Error(cmd.constructor.name);
      },
    },
  };
});
vi.mock('../src/connectors/store.ts', () => ({ loadConnection: async () => undefined }));
vi.mock('../src/connectors/mailchimp.ts', async (orig) => {
  const real = await orig<typeof import('../src/connectors/mailchimp.ts')>();
  return {
    ...real,
    mailchimp: async () => ({ apiHost: 'h', token: 't', listId: 'L' }),
    makeCampaign: async (_: unknown, issue: { html: string }, existing?: string) => {
      calls.push(`content:${existing ?? 'new'}:${issue.html.includes('<h1>') ? 'html' : '?'}`);
      return existing ?? 'camp1';
    },
    call: async (_: unknown, method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return {};
    },
  };
});

const { handler } = await import('../src/handlers/newsroom.ts');

const WEEK = '2026-11-16';
const send = async (body: unknown) => {
  const r = await handler({
    httpMethod: 'POST',
    path: `/newsroom/drafts/${WEEK}/mailchimp`,
    resource: '/newsroom/{proxy+}',
    body: JSON.stringify(body),
    requestContext: { authorizer: { sub: 'kyra', role: 'bmg-admin', sessionId: 's' } },
  } as unknown as APIGatewayProxyEvent);
  return { status: r.statusCode, body: JSON.parse(r.body || '{}') as Record<string, never> };
};

beforeEach(() => {
  calls.length = 0;
  items.clear();
  items.set(`ORG#newsroom|DRAFT#${WEEK}`, {
    weekOf: WEEK,
    week: 47,
    title: 'This week at Blueprint',
    status: 'draft',
    sections: { blueprint: [], artists: [], industry: [] },
  });
});

const draft = () => [...items.values()][0]!;

describe('sending the newsletter through Mailchimp', () => {
  it('sends a test before approval, but only sends to the audience once approved', async () => {
    expect((await send({ action: 'test', emails: ['kyra@example.com'] })).status).toBe(200);
    expect(calls).toEqual(['content:new:html', 'POST /campaigns/camp1/actions/test']);
    const early = await send({ action: 'send' });
    expect(early.status).toBe(409);
    expect(early.body.detail).toBe('Approve the issue before it’s sent');
  });

  it('sends an approved issue once, reusing the test’s campaign', async () => {
    draft().status = 'approved';
    await send({ action: 'test', emails: ['kyra@example.com'] });
    calls.length = 0;
    expect((await send({ action: 'send' })).status).toBe(200);
    expect(calls).toEqual(['content:camp1:html', 'POST /campaigns/camp1/actions/send']);
    expect(draft().mailchimp).toMatchObject({ campaignId: 'camp1', status: 'sent', by: 'kyra' });
    const again = await send({ action: 'send' });
    expect(again.status).toBe(409);
    expect(again.body.detail).toBe('This issue has already been sent');
  });

  it('schedules on the quarter hour, at least 15 minutes ahead, and can unschedule', async () => {
    draft().status = 'approved';
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    expect((await send({ action: 'schedule', at: soon })).status).toBe(400);
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    expect((await send({ action: 'schedule', at: later })).status).toBe(200);
    const m = draft().mailchimp as { status: string; at: string };
    expect(m.status).toBe('scheduled');
    expect(new Date(m.at).getUTCMinutes() % 15).toBe(0);
    expect((await send({ action: 'unschedule' })).status).toBe(200);
    expect(draft().mailchimp).toMatchObject({ status: 'draft' });
  });
});
