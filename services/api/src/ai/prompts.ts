import { BatchGetCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { promptDef, PROMPTS } from '@bmg/prompts';
import { db, env } from '../lib.ts';

/**
 * The live text of each prompt (design 10.6): the published version, or the
 * built-in default. Cached for 60 s, so a publish is live within about a minute.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { text: string; at: number }>();

async function load(id: string): Promise<string> {
  const def = promptDef(id);
  if (!def) throw new Error(`Unknown prompt ${id}`);
  const meta = await db.send(
    new GetCommand({ TableName: env('MAIN_TABLE'), Key: { PK: `PROMPT#${id}`, SK: 'META' } }),
  );
  const live = meta.Item?.liveVersion as number | undefined;
  if (!live) return def.defaultText;
  const v = await db.send(
    new GetCommand({
      TableName: env('MAIN_TABLE'),
      Key: { PK: `PROMPT#${id}`, SK: `VERSION#${String(live).padStart(5, '0')}` },
    }),
  );
  return (v.Item?.text as string | undefined) ?? def.defaultText;
}

export async function livePrompt(id: string): Promise<string> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  const text = await load(id);
  cache.set(id, { text, at: Date.now() });
  return text;
}

/** Every `tools.*` description, keyed by prompt id. */
export async function toolDescriptions(): Promise<Record<string, string>> {
  const ids = PROMPTS.map((p) => p.id).filter((id) => id.startsWith('tools.'));
  const texts = await Promise.all(ids.map(livePrompt));
  return Object.fromEntries(ids.map((id, i) => [id, texts[i]!]));
}

/** Current AI choice for each artist (`ARTIST#id / AI`); missing means opted out. */
export async function aiStates(artistIds: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (let i = 0; i < artistIds.length; i += 100) {
    const keys = artistIds.slice(i, i + 100).map((id) => ({ PK: `ARTIST#${id}`, SK: 'AI' }));
    const res = await db.send(
      new BatchGetCommand({ RequestItems: { [env('MAIN_TABLE')]: { Keys: keys } } }),
    );
    for (const item of res.Responses?.[env('MAIN_TABLE')] ?? []) {
      out[String(item.PK).slice('ARTIST#'.length)] = item.aiOptIn === true;
    }
  }
  return Object.fromEntries(artistIds.map((id) => [id, out[id] ?? false]));
}
