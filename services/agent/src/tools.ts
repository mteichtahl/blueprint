import { tool } from '@strands-agents/sdk';
import { ActionList, type Action } from '@bmg/prompts/actions';
import { z } from 'zod';

/**
 * The agent's tools (design 10.2). Read tools call the BMG API as the person
 * (their own token, tagged `x-bmg-context: ai`), so normal authorisation and
 * the AI consent checks apply. The only "write" tool drafts a checklist; it
 * changes nothing.
 */

export interface TurnContext {
  apiUrl: string;
  token: string;
  role: 'artist' | 'bmg-admin' | 'bmg-staff';
  artistId?: string;
  descriptions: Record<string, string>;
  /** Filled by propose_actions during the turn. */
  proposed: Action[];
  toolsUsed: Set<string>;
}

export type Fetch = typeof fetch;

export async function callApi(
  ctx: TurnContext,
  path: string,
  fetchImpl: Fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(new URL(path.replace(/^\//, ''), ctx.apiUrl.replace(/\/?$/, '/')), {
    headers: { authorization: `Bearer ${ctx.token}`, 'x-bmg-context': 'ai' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // The model sees a short reason, never internals.
    return { error: String(body.detail ?? body.title ?? `Request failed (${res.status})`) };
  }
  return body;
}

const describe = (ctx: TurnContext, name: string, fallback: string) =>
  ctx.descriptions[`tools.${name}`] ?? fallback;

export function buildTools(ctx: () => TurnContext, fetchImpl: Fetch = fetch) {
  const c = ctx();
  const tools = [
    tool({
      name: 'get_workspace',
      description: describe(
        c,
        'get_workspace',
        "Get an artist's plan (outcome and phases with progress), open to-dos, upcoming gigs and open submissions.",
      ),
      inputSchema: z.object({
        artistId: z
          .string()
          .optional()
          .describe('The artist id (art_…). Blueprint staff must give one; artists leave it out.'),
      }),
      callback: async ({ artistId }) => {
        const t = ctx();
        t.toolsUsed.add('get_workspace');
        const id = t.role === 'artist' ? t.artistId : artistId;
        if (!id) return { error: 'Say which artist (use list_artists to find their id).' };
        return callApi(t, `/ai/tools/workspace?artistId=${encodeURIComponent(id)}`, fetchImpl);
      },
    }),
    tool({
      name: 'propose_actions',
      description: describe(
        c,
        'propose_actions',
        'Draft a checklist of actions for the person to review. Nothing happens until they tap "Do it".',
      ),
      inputSchema: z.object({ actions: ActionList }),
      callback: ({ actions }) => {
        const t = ctx();
        t.toolsUsed.add('propose_actions');
        t.proposed = actions;
        return {
          ok: true,
          note: 'The checklist is shown to the person. Tell them to review it and tap "Do it"; do not say it is done.',
        };
      },
    }),
  ];
  if (c.role !== 'artist') {
    tools.unshift(
      tool({
        name: 'list_artists',
        description: describe(
          c,
          'list_artists',
          "List the artists whose workspaces you can see, with their ids. Artists who turned AI off aren't included.",
        ),
        inputSchema: z.object({}),
        callback: async () => {
          const t = ctx();
          t.toolsUsed.add('list_artists');
          return callApi(t, '/ai/tools/artists', fetchImpl);
        },
      }) as unknown as (typeof tools)[number],
    );
  }
  return tools;
}
