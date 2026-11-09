import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { render } from '@bmg/prompts';
import { aiStates, livePrompt } from '../ai/prompts.ts';
import type { Gig } from '../events/model.ts';
import { EVENTS_PK } from '../events/model.ts';
import { LIBRARY_PK, type FileRecord } from '../files/model.ts';
import { db, env } from '../lib.ts';
import {
  DEFAULT_SETTINGS,
  draftSk,
  fallbackSections,
  isoWeek,
  MODEL_OUTPUT,
  ModelReply,
  NEWSROOM_PK,
  pageSnapshot,
  parseFeed,
  rankStories,
  sectionsFromModel,
  Settings,
  SETTINGS_SK,
  siteSk,
  weekOf,
  type Draft,
  type Sections,
  type Site,
  type Story,
} from '../newsroom/model.ts';
import { artistPk, ROSTER_GSI1PK } from '../workspace/model.ts';

/**
 * The weekly newsletter draft (design 10.5, F6). Runs on Sunday at 6:00 am
 * Melbourne (and on "Regenerate"). It reads the managed industry sites,
 * Blueprint's upcoming events and new library items, and news only from
 * artists who opted in to AI, then drafts with the summary model. Opted-out
 * artists are listed to add by hand. Nothing is ever sent from here: an
 * approved draft is sent by a person.
 */

const bedrock = new BedrockRuntimeClient({});
const table = () => env('MAIN_TABLE');
const DAY = 86_400_000;
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', event, ...fields }));

async function q(pk: string, prefix: string, extra: Record<string, unknown> = {}) {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': pk, ':p': prefix },
      ...extra,
    }),
  );
  return res.Items ?? [];
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'BlueprintNewsroom/1.0',
        accept: 'application/rss+xml, application/atom+xml, text/html;q=0.8, */*;q=0.5',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    return text.slice(0, 2_000_000);
  } catch {
    return undefined;
  }
}

async function industry(sites: Site[], since: Date) {
  const found: Story[] = [];
  for (const site of sites.filter((s) => s.enabled)) {
    const body = await fetchText(site.url);
    let stories: Story[] = [];
    let pageHash = site.pageHash;
    if (body && site.mode === 'feed') stories = parseFeed(body, site.name, since);
    if (body && site.mode === 'page') {
      const snap = pageSnapshot(body);
      if (site.pageHash && snap.hash !== site.pageHash) {
        stories = [
          {
            id: `p${snap.hash.slice(0, 15)}`,
            title: `Updated: ${snap.title || site.name}`,
            summary: `${site.name} has updated this page.`,
            url: site.url,
            source: site.name,
          },
        ];
      }
      pageHash = snap.hash;
    }
    found.push(...stories);
    await db.send(
      new UpdateCommand({
        TableName: table(),
        Key: { PK: NEWSROOM_PK, SK: siteSk(site.siteId) },
        UpdateExpression:
          'SET lastCheckedAt = :at, lastFound = :n' + (pageHash ? ', pageHash = :h' : ''),
        ExpressionAttributeValues: {
          ':at': new Date().toISOString(),
          ':n': stories.length,
          ...(pageHash ? { ':h': pageHash } : {}),
        },
      }),
    );
  }
  return found;
}

export async function handler(): Promise<
  { weekOf: string; generatedBy: string } | { skipped: string }
> {
  const now = new Date();
  // Drafted on Sunday for the week that starts on Monday.
  const week = weekOf(new Date(now.getTime() + DAY));
  const existing = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: NEWSROOM_PK, SK: draftSk(week) } }),
  );
  if ((existing.Item as Draft | undefined)?.status === 'approved')
    return { skipped: 'already approved' };

  const settingsItem = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: NEWSROOM_PK, SK: SETTINGS_SK } }),
  );
  const settings = settingsItem.Item
    ? Settings.parse(settingsItem.Item.settings)
    : DEFAULT_SETTINGS;
  const since = new Date(now.getTime() - 7 * DAY);
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + 45 * DAY).toISOString().slice(0, 10);

  // ── From Blueprint: upcoming events and new library items shared with everyone ──
  const blueprint: { heading: string; text: string }[] = [];
  if (settings.include.blueprint) {
    for (const e of await q(EVENTS_PK, 'EVENT#')) {
      if (String(e.date) < today || String(e.date) > soon) continue;
      const price = Number(e.ticketPriceCents)
        ? ` Tickets $${(Number(e.ticketPriceCents) / 100).toFixed(0)}.`
        : '';
      blueprint.push({
        heading: String(e.name),
        text: `${String(e.name)} is on ${String(e.date)}${e.venue ? ` at ${String(e.venue)}` : ''}.${price}`,
      });
    }
    for (const f of (await q(LIBRARY_PK, 'FILE#')) as FileRecord[]) {
      if (
        f.status === 'available' &&
        f.sharing === 'all-artists' &&
        (f.availableAt ?? '') >= since.toISOString()
      ) {
        blueprint.push({ heading: 'New in the library', text: f.name });
      }
    }
  }

  // ── From our artists: only artists who opted in to AI (design 10.4) ──
  const roster = await db.send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :r',
      ExpressionAttributeValues: { ':r': ROSTER_GSI1PK },
    }),
  );
  const artists = (roster.Items ?? []).map((a) => ({
    id: String(a.artistId),
    name: String(a.displayName ?? ''),
  }));
  const states = await aiStates(artists.map((a) => a.id));
  const addByHand = artists
    .filter((a) => !states[a.id])
    .map((a) => ({ artistId: a.id, name: a.name }));
  const artistNews: { name: string; text: string }[] = [];
  if (settings.include.artists) {
    for (const a of artists.filter((x) => states[x.id])) {
      const gigs = ((await q(artistPk(a.id), 'GIG#')) as Gig[]).filter((g) => g.shared);
      const played = gigs.filter(
        (g) =>
          g.date >= since.toISOString().slice(0, 10) && g.date < today && g.status !== 'cancelled',
      );
      const upcoming = gigs.filter(
        (g) =>
          g.date >= today &&
          g.date <= new Date(now.getTime() + 14 * DAY).toISOString().slice(0, 10) &&
          (g.status === 'confirmed' || g.status === 'booked'),
      );
      for (const g of played)
        artistNews.push({
          name: a.name,
          text: `played ${g.title}${g.venue ? ` at ${g.venue}` : ''}.`,
        });
      for (const g of upcoming)
        artistNews.push({
          name: a.name,
          text: `plays ${g.title}${g.venue ? ` at ${g.venue}` : ''} on ${g.date}.`,
        });
    }
  }

  // ── Industry ──
  const sites = (await q(NEWSROOM_PK, 'SITE#')) as Site[];
  const stories = settings.include.industry
    ? rankStories(await industry(sites, since), settings)
    : [];

  // ── Draft with the model; fall back to a plain draft if it can't be used ──
  let sections: Sections = fallbackSections({ blueprint, artists: artistNews }, stories, settings);
  let generatedBy: Draft['generatedBy'] = 'fallback';
  if (blueprint.length + artistNews.length + stories.length > 0) {
    try {
      const prompt = render(await livePrompt('newsroom.weekly'), {
        today,
        weekOf: week,
        lookFor: settings.lookFor,
        blueprintNews:
          blueprint.map((b) => `- ${b.heading}: ${b.text}`).join('\n') || '(none this week)',
        artistNews: artistNews.map((a) => `- ${a.name} ${a.text}`).join('\n') || '(none this week)',
        industryNews:
          stories
            .slice(0, 20)
            .map((s) => `- ${s.title} (${s.source}) ${s.url}: ${s.summary.slice(0, 300)}`)
            .join('\n') || '(none this week)',
      });
      const res = await bedrock.send(
        new ConverseCommand({
          modelId: env('SUMMARY_MODEL'),
          messages: [{ role: 'user', content: [{ text: `${prompt}\n\n${MODEL_OUTPUT}` }] }],
          inferenceConfig: { maxTokens: 2000, temperature: 0.4 },
        }),
      );
      const text = res.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      const reply = ModelReply.safeParse(JSON.parse(json));
      if (reply.success) {
        sections = sectionsFromModel(reply.data, stories, settings);
        generatedBy = 'ai';
      }
    } catch (err) {
      log('newsroom.model.failed', { error: (err as Error).name });
    }
  }

  const picked = new Set(sections.industry.map((s) => s.id));
  const draft: Draft = {
    weekOf: week,
    week: isoWeek(new Date(`${week}T00:00:00Z`)),
    title: 'Build, Connect, Grow',
    status: 'draft',
    sections,
    addByHand,
    spare: stories.filter((s) => !picked.has(s.id)).slice(0, 10),
    generatedAt: now.toISOString(),
    generatedBy,
  };
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: { PK: NEWSROOM_PK, SK: draftSk(week), type: 'newsletterDraft', ...draft },
      // Never overwrite a draft someone approved in the meantime.
      ConditionExpression: 'attribute_not_exists(PK) OR #s <> :approved',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':approved': 'approved' },
    }),
  );
  log('newsroom.drafted', {
    weekOf: week,
    generatedBy,
    stories: stories.length,
    artists: artistNews.length,
  });
  return { weekOf: week, generatedBy };
}
