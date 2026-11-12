import { describe, expect, it } from 'vitest';
import { buildTools, type TurnContext } from '../src/tools.ts';

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  apiUrl: 'https://api.example.test/v1',
  token: 'token-for-the-person-xyz',
  role: 'artist',
  artistId: 'art_aaaaaaaaaaaa',
  descriptions: {},
  proposed: [],
  toolsUsed: new Set(),
  ...over,
});

function fakeFetch(calls: { url: string; headers: Record<string, string> }[]) {
  return (async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

const byName = (tools: ReturnType<typeof buildTools>, name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t as unknown as { invoke: (i: unknown) => Promise<unknown> };
};

describe('agent tools', () => {
  it('artists only get their own workspace, called as them with the AI context', async () => {
    const c = ctx();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const tools = buildTools(() => c, fakeFetch(calls));
    expect(tools.map((t) => t.name)).toEqual([
      'get_workspace',
      'search_my_content',
      'list_folders',
      'propose_actions',
    ]);
    await byName(tools, 'get_workspace').invoke({ artistId: 'art_bbbbbbbbbbbb' });
    expect(calls[0]!.url).toBe(
      'https://api.example.test/v1/ai/tools/workspace?artistId=art_aaaaaaaaaaaa',
    );
    expect(calls[0]!.headers).toEqual({
      authorization: 'Bearer token-for-the-person-xyz',
      'x-bmg-context': 'ai',
    });
  });

  it('Blueprint staff can list artists and must say which one', async () => {
    const c = ctx({ role: 'bmg-staff', artistId: undefined });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const tools = buildTools(() => c, fakeFetch(calls));
    expect(tools.map((t) => t.name)).toEqual([
      'list_artists',
      'get_workspace',
      'search_my_content',
      'list_folders',
      'propose_actions',
    ]);
    expect(await byName(tools, 'get_workspace').invoke({})).toMatchObject({
      error: /which artist/,
    });
    expect(calls).toHaveLength(0);
  });

  it('artists can only search their own documents', async () => {
    const c = ctx();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const tools = buildTools(() => c, fakeFetch(calls));
    await byName(tools, 'search_my_content').invoke({
      query: 'set list',
      artistId: 'art_bbbbbbbbbbbb',
    });
    expect(calls[0]!.url).toBe('https://api.example.test/v1/ai/tools/search?q=set+list');
  });

  it('propose_actions only records a valid checklist', async () => {
    const c = ctx();
    const tools = buildTools(() => c, fakeFetch([]));
    const action = {
      type: 'createTodo',
      summary: 'Add a to-do: send the pitch email',
      artistId: 'art_aaaaaaaaaaaa',
      title: 'Send the pitch email',
    };
    await byName(tools, 'propose_actions').invoke({ actions: [action] });
    expect(c.proposed).toEqual([action]);
    await expect(
      byName(tools, 'propose_actions').invoke({
        actions: [{ type: 'deleteEverything', summary: 'x' }],
      }),
    ).rejects.toThrow();
  });
});

describe('list_folders (rev 10)', () => {
  it("lists an artist's own Library whatever space they name, trimmed to ids and rights", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const served = (async (url: URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      const body = String(url).endsWith('/folders')
        ? {
            root: { level: 'manage' },
            folders: [
              {
                folderId: 'fold000000001',
                name: 'Contracts',
                parentId: null,
                level: 'manage',
                ownerName: 'X',
              },
            ],
          }
        : {
            files: [
              {
                fileId: 'file000000001',
                displayName: 'Rider',
                folderId: 'fold000000001',
                level: 'edit',
                status: 'available',
                thumbnailUrl: 'https://signed',
              },
              {
                fileId: 'file000000002',
                displayName: 'Scanning',
                folderId: null,
                status: 'pending',
              },
            ],
          };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const tools = buildTools(() => ctx(), served);
    const out = await byName(tools, 'list_folders').invoke({ space: 'library' });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/v1/artists/art_aaaaaaaaaaaa/folders',
      '/v1/artists/art_aaaaaaaaaaaa/files',
    ]);
    expect(calls[0]!.headers['x-bmg-context']).toBe('ai');
    expect(out).toEqual({
      space: 'art_aaaaaaaaaaaa',
      top: { level: 'manage' },
      folders: [{ folderId: 'fold000000001', name: 'Contracts', parentId: null, level: 'manage' }],
      documents: [
        { fileId: 'file000000001', name: 'Rider', folderId: 'fold000000001', level: 'edit' },
      ],
    });
  });
});
