import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Newsroom (screens doc "Newsroom", design 10.5, F6): a weekly newsletter
 * draft that waits for a BMG admin's approval. Pure: keys, schemas, feed
 * parsing and the fallback draft, so the rules are unit-tested.
 */

export const NEWSROOM_PK = 'ORG#newsroom';
export const SETTINGS_SK = 'SETTINGS';
export const siteSk = (id: string) => `SITE#${id}`;
export const draftSk = (weekOf: string) => `DRAFT#${weekOf}`;

export const SITE_KINDS = [
  'Music press',
  'Industry body',
  'Funding & grants',
  'Festival',
  'Venue',
] as const;

export interface Site {
  siteId: string;
  name: string;
  url: string;
  kind: (typeof SITE_KINDS)[number];
  /** feed: RSS/Atom; page: tell us when the page changes. */
  mode: 'feed' | 'page';
  enabled: boolean;
  lastCheckedAt?: string;
  lastFound?: number;
  lastPicked?: number;
  pageHash?: string;
}

const HttpsUrl = z.url({ protocol: /^https$/ }).max(500);

export const SiteBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: HttpsUrl,
    kind: z.enum(SITE_KINDS),
    mode: z.enum(['feed', 'page']).default('feed'),
  })
  .strict();
export const SitePatch = z.object({ enabled: z.boolean() }).strict();

export const Settings = z
  .object({
    lookFor: z
      .string()
      .trim()
      .max(300)
      .default('emerging artists, Melbourne, grants, festivals, venues'),
    skip: z.string().trim().max(300).default('celebrity news, chart gossip'),
    storiesPerIssue: z.number().int().min(3).max(5).default(3),
    include: z
      .object({
        blueprint: z.boolean().default(true),
        artists: z.boolean().default(true),
        industry: z.boolean().default(true),
      })
      .default({ blueprint: true, artists: true, industry: true }),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;
export const DEFAULT_SETTINGS: Settings = Settings.parse({});

const Text = (max: number) => z.string().trim().max(max);
export const Block = z
  .object({
    id: z.string().min(1).max(40),
    heading: Text(120).optional(),
    text: Text(1200),
    link: HttpsUrl.optional(),
    linkLabel: Text(40).optional(),
  })
  .strict();
export const Story = z
  .object({
    id: z.string().min(1).max(40),
    title: Text(200),
    summary: Text(600),
    url: HttpsUrl,
    source: Text(80),
  })
  .strict();
export const Sections = z
  .object({
    blueprint: z.array(Block).max(6),
    artists: z.array(Block).max(12),
    industry: z.array(Story).max(5),
  })
  .strict();
export type Sections = z.infer<typeof Sections>;
export type Story = z.infer<typeof Story>;

export interface Draft {
  weekOf: string;
  week: number;
  title: string;
  status: 'draft' | 'approved';
  sections: Sections;
  /** Opted-out artists: their news is never auto-drafted, so BMG adds it by hand. */
  addByHand: { artistId: string; name: string }[];
  /** Industry stories found this week that weren't picked (for "Swap a story"). */
  spare: Story[];
  generatedAt: string;
  generatedBy: 'ai' | 'fallback';
  editedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  /** Sent through Mailchimp (or scheduled, or a campaign made for a test send). */
  mailchimp?: MailchimpState;
}

export const DraftEdit = z.object({ sections: Sections }).strict();

/** Where an approved issue is in Mailchimp (the newsletter is sent from there). */
export interface MailchimpState {
  campaignId: string;
  status: 'draft' | 'scheduled' | 'sent';
  /** When it was sent, or when it's scheduled for. */
  at?: string;
  by?: string;
}

/** Test, send now, or schedule (admins, fresh sign-in). Test can go before approval. */
export const MailchimpBody = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('test'),
      emails: z.array(z.email().max(200)).min(1).max(5),
    })
    .strict(),
  z.object({ action: z.literal('send') }).strict(),
  z.object({ action: z.literal('schedule'), at: z.iso.datetime() }).strict(),
  z.object({ action: z.literal('unschedule') }).strict(),
]);

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The issue as email HTML: the same content "Copy as HTML" puts on the
 * clipboard, in a plain page Mailchimp wraps with the audience's footer
 * (which carries the unsubscribe link and address it requires).
 */
export function issueHtml(d: Pick<Draft, 'title' | 'week' | 'weekOf' | 'sections'>): string {
  const sec = (title: string, body: string) => (body ? `<h2>${esc(title)}</h2>${body}` : '');
  const date = new Date(`${d.weekOf}T00:00:00Z`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const body = [
    `<h1>${esc(d.title)}</h1><p>Week ${d.week} · ${esc(date)}</p>`,
    sec(
      'From Blueprint',
      d.sections.blueprint
        .map(
          (b) =>
            `${b.heading ? `<h3>${esc(b.heading)}</h3>` : ''}<p>${esc(b.text)}</p>${
              b.link
                ? `<p><a href="${esc(b.link)}">${esc(b.linkLabel || 'Find out more')}</a></p>`
                : ''
            }`,
        )
        .join(''),
    ),
    sec('From our artists', d.sections.artists.map((b) => `<p>${esc(b.text)}</p>`).join('')),
    sec(
      'Industry news',
      d.sections.industry
        .map(
          (s) =>
            `<p><b>${esc(s.title)}</b> ${esc(s.summary)} <a href="${esc(s.url)}">Read more</a></p>`,
        )
        .join(''),
    ),
  ].join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;color:#011935;max-width:640px;margin:0 auto;padding:16px">${body}</body></html>`;
}

/** The Monday that starts the week of `d` (ISO week), as YYYY-MM-DD. */
export function weekOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

/** ISO week number. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

export const storyId = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 16);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** One pass over entities, so "&amp;lt;" becomes "&lt;" and is never decoded twice. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/**
 * Drops every tag, and the whole contents of script and style elements, by
 * scanning characters rather than matching markup with regular expressions.
 */
function stripTags(s: string): string {
  const lower = s.toLowerCase();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    out += `${s.slice(i, lt)} `;
    if (s.startsWith('<![CDATA[', lt)) {
      const close = s.indexOf(']]>', lt + 9);
      out += close === -1 ? s.slice(lt + 9) : s.slice(lt + 9, close);
      i = close === -1 ? s.length : close + 3;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) break; // an unclosed tag: drop the rest
    const name = lower.slice(lt + 1, gt).match(/^([a-z0-9]+)/)?.[1];
    i = gt + 1;
    if (name === 'script' || name === 'style') {
      // Skip to the matching end tag, whatever spacing or attributes it has.
      const end = lower.indexOf(`</${name}`, i);
      const endGt = end === -1 ? -1 : lower.indexOf('>', end);
      i = endGt === -1 ? s.length : endGt + 1;
    }
  }
  return out;
}

/** Plain text from feed or page markup; nothing from outside is ever treated as markup. */
const decode = (s: string) =>
  stripTags(decodeEntities(stripTags(s)))
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]!) : undefined;
}

/**
 * RSS 2.0 and Atom items newer than `since`. Only https links are kept, and
 * text is reduced to plain characters (it is never rendered as HTML).
 */
export function parseFeed(xml: string, source: string, since: Date): Story[] {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: Story[] = [];
  for (const it of items.slice(0, 50)) {
    const title = tag(it, 'title');
    const link = tag(it, 'link') || it.match(/<link[^>]*href="([^"]+)"/i)?.[1] || tag(it, 'guid');
    const when = tag(it, 'pubDate') ?? tag(it, 'published') ?? tag(it, 'updated');
    const summary = tag(it, 'description') ?? tag(it, 'summary') ?? '';
    if (!title || !link || !/^https:\/\//.test(link)) continue;
    if (when && !Number.isNaN(Date.parse(when)) && new Date(when) < since) continue;
    out.push({
      id: storyId(link),
      title: title.slice(0, 200),
      summary: summary.slice(0, 600),
      url: link.slice(0, 500),
      source: source.slice(0, 80),
    });
  }
  return out;
}

/** Page checks: the page's title, and a hash of its text to notice a change. */
export function pageSnapshot(html: string): { title: string; hash: string } {
  const title = tag(html, 'title') ?? '';
  const body = decode(html);
  return { title: title.slice(0, 200), hash: createHash('sha256').update(body).digest('hex') };
}

/** Very rough relevance: stories mentioning "look for" words first, "skip" words dropped. */
export function rankStories(stories: Story[], settings: Settings): Story[] {
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean);
  const look = words(settings.lookFor);
  const skip = words(settings.skip);
  const seen = new Set<string>();
  return stories
    .filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      const t = `${s.title} ${s.summary}`.toLowerCase();
      return !skip.some((w) => t.includes(w));
    })
    .map((s) => {
      const t = `${s.title} ${s.summary}`.toLowerCase();
      return { s, score: look.filter((w) => t.includes(w)).length };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

/** A draft built without the model, so a newsletter is always ready to edit. */
export function fallbackSections(
  input: {
    blueprint: { heading: string; text: string }[];
    artists: { name: string; text: string }[];
  },
  stories: Story[],
  settings: Settings,
): Sections {
  return {
    blueprint: settings.include.blueprint
      ? input.blueprint
          .slice(0, 6)
          .map((b, i) => ({ id: `b${i}`, heading: b.heading, text: b.text }))
      : [],
    artists: settings.include.artists
      ? input.artists.slice(0, 12).map((a, i) => ({ id: `a${i}`, text: `${a.name}: ${a.text}` }))
      : [],
    industry: settings.include.industry ? stories.slice(0, settings.storiesPerIssue) : [],
  };
}

/** The shape the model must reply in; appended by code, so an edited prompt can't change it. */
export const MODEL_OUTPUT = `Reply with JSON only, no other text, in exactly this shape:
{"blueprint":[{"heading":"...","text":"..."}],"artists":[{"text":"..."}],"industry":[{"url":"<one of the given story urls>","summary":"..."}]}
Use only the facts given. Never invent artists, events, dates or links.`;

export const ModelReply = z.object({
  blueprint: z.array(z.object({ heading: z.string().max(120), text: z.string().max(1200) })).max(6),
  artists: z.array(z.object({ text: z.string().max(1200) })).max(12),
  industry: z.array(z.object({ url: z.string(), summary: z.string().max(600) })).max(5),
});

/** Turns the model's reply into sections, keeping only stories we actually found. */
export function sectionsFromModel(
  reply: z.infer<typeof ModelReply>,
  stories: Story[],
  settings: Settings,
): Sections {
  const byUrl = new Map(stories.map((s) => [s.url, s]));
  const industry = reply.industry
    .map((r) => {
      const s = byUrl.get(r.url);
      return s ? { ...s, summary: r.summary.trim().slice(0, 600) || s.summary } : undefined;
    })
    .filter((s): s is Story => !!s)
    .slice(0, settings.storiesPerIssue);
  return Sections.parse({
    blueprint: settings.include.blueprint
      ? reply.blueprint.map((b, i) => ({
          id: `b${i}`,
          heading: b.heading.trim(),
          text: b.text.trim(),
        }))
      : [],
    artists: settings.include.artists
      ? reply.artists.map((a, i) => ({ id: `a${i}`, text: a.text.trim() }))
      : [],
    industry: settings.include.industry ? industry : [],
  });
}
