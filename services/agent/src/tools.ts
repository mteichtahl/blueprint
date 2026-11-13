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

/** Just what the model needs to name folders and documents: ids, names, places and rights. */
export function trimLibrary(space: string, folders: unknown, files: unknown) {
  const f = folders as {
    error?: string;
    root?: { level: string };
    folders?: { folderId: string; name: string; parentId: string | null; level: string }[];
  };
  const d = files as {
    error?: string;
    files?: {
      fileId: string;
      displayName: string;
      folderId: string | null;
      level?: string;
      status: string;
    }[];
  };
  if (f.error) return { error: f.error };
  return {
    space,
    top: { level: f.root?.level ?? 'none' },
    folders: (f.folders ?? []).map((x) => ({
      folderId: x.folderId,
      name: x.name,
      parentId: x.parentId,
      level: x.level,
    })),
    documents: (d.files ?? [])
      .filter((x) => x.status === 'available')
      .slice(0, 300)
      .map((x) => ({
        fileId: x.fileId,
        name: x.displayName,
        folderId: x.folderId,
        level: x.level ?? 'view',
      })),
  };
}

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
      name: 'search_my_content',
      description: describe(
        c,
        'search_my_content',
        "Search the documents this person may see. Blueprint staff: give an artistId to search that artist's documents, or leave it out to search Blueprint's own library.",
      ),
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe('What to look for, in plain words'),
        artistId: z
          .string()
          .optional()
          .describe('Blueprint staff only: the artist whose documents to search'),
      }),
      callback: async ({ query, artistId }) => {
        const t = ctx();
        t.toolsUsed.add('search_my_content');
        const params = new URLSearchParams({ q: query });
        if (t.role !== 'artist' && artistId) params.set('artistId', artistId);
        return callApi(t, `/ai/tools/search?${params.toString()}`, fetchImpl);
      },
    }),
    tool({
      name: 'list_folders',
      description: describe(
        c,
        'list_folders',
        "List the folders and documents in a library, with their ids, so folder actions can name them. Use 'library' for Blueprint's own library, or an artist id for that artist's Library. Each item says how much this person may do with it.",
      ),
      inputSchema: z.object({
        space: z
          .string()
          .describe(
            "'library' (Blueprint only) or an artist id (art_…); artists give their own id",
          ),
      }),
      callback: async ({ space }) => {
        const t = ctx();
        t.toolsUsed.add('list_folders');
        const where = t.role === 'artist' ? (t.artistId ?? '') : space;
        if (where !== 'library' && !/^art_[a-z0-9]{10,32}$/.test(where)) {
          return { error: "Say 'library' or an artist id (use list_artists to find it)." };
        }
        const base = where === 'library' ? '/library' : `/artists/${where}`;
        const [folders, files] = await Promise.all([
          callApi(t, `${base}/folders`, fetchImpl),
          callApi(t, `${base}/files`, fetchImpl),
        ]);
        return trimLibrary(where, folders, files);
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
          "List the artists whose workspaces you can see, with their ids, and the Blueprint team (team: sub, name, job title) for messaging a teammate. Artists who turned AI off aren't included. Team chats themselves can't be read.",
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
