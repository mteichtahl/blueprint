import { z } from 'zod';

/**
 * What we can learn about a venue from its website, beyond its logo:
 *
 * - its street address and suburb, so pasting a website when adding a venue
 *   fills them in (schema.org JSON-LD, then microdata, then Open Graph /
 *   business meta tags, then an Australian street address in the page text);
 * - its name (og:site_name or the page title), used only when the name is empty;
 * - whether the site lets itself be shown inside another app (an iframe), so
 *   the venue page can show it beside the map, or say why it can't.
 *
 * Everything here is pure, so it is unit-tested. The network side is in
 * `logo-fetch.ts` (`inspectVenueSite`).
 */

export const SiteLookup = z
  .object({ url: z.string().trim().min(1, 'Add the venue website first').max(300) })
  .strict();

export interface FoundAddress {
  address: string;
  suburb: string;
}

const STATES = 'VIC|NSW|QLD|SA|WA|TAS|NT|ACT';
const STATE_RE = new RegExp(`\\b(?:${STATES})\\b`, 'i');
const STREET_TYPES =
  'Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Parade|Pde|Place|Pl|Drive|Dr|Highway|Hwy|Boulevard|Blvd|Terrace|Tce|Way|Crescent|Cres|Court|Ct|Esplanade|Esp|Square|Sq|Close|Cl|Grove|Gr|Walk|Mall|Arcade|Circuit|Cct|Quay|Promenade|Row|Alley';

const ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  lt: '<',
  gt: '>',
  ndash: '–',
  mdash: '—',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&([a-z]+|#39);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}
const safeChar = (n: number) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '');

const clean = (s: unknown, max = 160): string =>
  typeof s === 'string'
    ? decodeEntities(s)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .slice(0, max)
    : '';

/** "Fitzroy VIC 3065" → "Fitzroy" (the app keeps the suburb on its own). */
function suburbOnly(s: string): string {
  return s
    .replace(new RegExp(`[,\\s]+(?:${STATES})\\b.*$`, 'i'), '')
    .replace(/[,\s]+\d{4}$/, '')
    .replace(/,?\s*Australia$/i, '')
    .trim();
}

function fromParts(street: string, locality: string): FoundAddress | null {
  const address = clean(street);
  const suburb = suburbOnly(clean(locality, 80));
  if (!address || !/\d|[a-z]{3}/i.test(address)) return null;
  return { address, suburb };
}

// ── JSON-LD ──────────────────────────────────────────────────────────────
function walkJsonLd(node: unknown, depth = 0): FoundAddress | null {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = walkJsonLd(n, depth + 1);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const o = node as Record<string, unknown>;
  const addr = o.address ?? o.location;
  if (addr && typeof addr === 'object' && !Array.isArray(addr)) {
    const a = addr as Record<string, unknown>;
    if (a.streetAddress) {
      const f = fromParts(String(a.streetAddress), String(a.addressLocality ?? ''));
      if (f) return f;
    }
    const nested = walkJsonLd(a, depth + 1);
    if (nested) return nested;
  } else if (typeof addr === 'string') {
    const f = fromText(addr);
    if (f) return f;
  }
  if (o.streetAddress) {
    const f = fromParts(String(o.streetAddress), String(o.addressLocality ?? ''));
    if (f) return f;
  }
  for (const k of ['@graph', 'mainEntity', 'location', 'subOrganization', 'department']) {
    const f = walkJsonLd(o[k], depth + 1);
    if (f) return f;
  }
  return null;
}

function fromJsonLd(html: string): FoundAddress | null {
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      const f = walkJsonLd(JSON.parse(m[1]!.trim()));
      if (f) return f;
    } catch {
      // Not valid JSON; try the next block.
    }
  }
  return null;
}

// ── Microdata ────────────────────────────────────────────────────────────
function itemprop(html: string, name: string): string {
  const re = new RegExp(
    `<([a-z0-9]+)\\b[^>]*itemprop\\s*=\\s*["']${name}["'][^>]*>([\\s\\S]*?)</\\1>`,
    'i',
  );
  const m = re.exec(html);
  if (m) return clean(m[2]);
  const meta = new RegExp(
    `<meta\\b[^>]*itemprop\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i',
  ).exec(html);
  return meta ? clean(meta[1]) : '';
}

function fromMicrodata(html: string): FoundAddress | null {
  const street = itemprop(html, 'streetAddress');
  return street ? fromParts(street, itemprop(html, 'addressLocality')) : null;
}

// ── Meta tags (Open Graph / Facebook business) ──────────────────────────
function metaContent(html: string, names: string[]): string {
  for (const n of names) {
    const esc = n.replace(/[.:]/g, '\\$&');
    const a = new RegExp(
      `<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${esc}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
      'i',
    ).exec(html);
    if (a) return clean(a[1]);
    const b = new RegExp(
      `<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${esc}["']`,
      'i',
    ).exec(html);
    if (b) return clean(b[1]);
  }
  return '';
}

function fromMeta(html: string): FoundAddress | null {
  const street = metaContent(html, [
    'business:contact_data:street_address',
    'og:street-address',
    'place:location:street_address',
  ]);
  if (!street) return null;
  return fromParts(street, metaContent(html, ['business:contact_data:locality', 'og:locality']));
}

// ── Plain text (Australian addresses) ───────────────────────────────────
/** The page as readable text: no scripts, styles or tags. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ', ')
      .replace(/<\/(p|div|li|h\d|address|span|td)>/gi, ' | ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*,){2,}\s*/g, ', ')
    .trim();
}

const STREET_RE = new RegExp(
  // "Shop 2/", "Level 1,", "1/" … then a number (or range) and a street name and type.
  String.raw`((?:(?:Shop|Level|Suite|Unit)\s*\d+[A-Za-z]?\s*[,/]\s*)?\d{1,5}[A-Za-z]?(?:\s*[-–/]\s*\d{1,5}[A-Za-z]?)?\s+(?:[A-Z][A-Za-z'’.-]*\s+){1,4}(?:${STREET_TYPES})\.?)` +
    // Then the suburb, the state and a postcode.
    String.raw`\s*,?\s*((?:[A-Z][A-Za-z'’.-]*\s+){0,3}[A-Z][A-Za-z'’.-]*)\s*,?\s+(?:${STATES})\s*,?\s*(\d{4})\b`,
);

export function fromText(text: string): FoundAddress | null {
  const m = STREET_RE.exec(text);
  if (!m) return null;
  return fromParts(m[1]!, m[2]!);
}

/** The venue's street address and suburb, if the page says where it is. */
export function findAddress(html: string): FoundAddress | null {
  return (
    fromJsonLd(html) ??
    fromMicrodata(html) ??
    fromMeta(html) ??
    (STATE_RE.test(html) ? fromText(visibleText(html)) : null)
  );
}

/** A name for the venue: og:site_name, else the page title before any " | …". */
export function findSiteName(html: string): string {
  const og = metaContent(html, ['og:site_name']);
  if (og) return og.slice(0, 80);
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!t) return '';
  return clean(t[1], 200)
    .split(/\s+[|–—-]\s+|\s*[|•·]\s*/)[0]!
    .replace(/^(home|welcome)\s*$/i, '')
    .trim()
    .slice(0, 80);
}

/**
 * Pages on the same site likely to give the address: contact, find us,
 * location, visit, about. At most `limit`, in that order of preference.
 */
export function addressPages(html: string, pageUrl: string, limit = 2): string[] {
  let host: string;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return [];
  }
  const rank = [
    /contact/i,
    /find[-_ ]?us|getting[-_ ]?here|directions/i,
    /location|visit/i,
    /about/i,
  ];
  const found: { url: string; score: number }[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m && found.length < 60; m = re.exec(html)) {
    const href = /href\s*=\s*["']([^"'#]+)["']/i.exec(m[1]!)?.[1];
    if (!href) continue;
    let u: URL;
    try {
      u = new URL(decodeEntities(href), pageUrl);
    } catch {
      continue;
    }
    if (u.hostname !== host || !/^https?:$/.test(u.protocol)) continue;
    const hay = `${u.pathname} ${clean(m[2], 60)}`;
    const score = rank.findIndex((r) => r.test(hay));
    if (score < 0) continue;
    u.hash = '';
    const url = u.toString();
    if (url !== pageUrl && !found.some((f) => f.url === url)) found.push({ url, score });
  }
  return found
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((f) => f.url);
}

/**
 * Can the site be shown in an iframe on our page? No if it sends any
 * X-Frame-Options, or a CSP frame-ancestors that doesn't allow every https
 * site, or if it's plain http (the browser blocks it on an https page).
 */
export function embeddable(
  finalUrl: string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!/^https:/i.test(finalUrl)) return false;
  const get = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v.join(', ') : (v ?? '');
  };
  if (get('x-frame-options').trim()) return false;
  const csp = get('content-security-policy');
  const fa = /(?:^|;|,)\s*frame-ancestors\s+([^;,]*)/i.exec(csp)?.[1];
  if (fa !== undefined) {
    const sources = fa.trim().toLowerCase().split(/\s+/);
    if (!sources.some((s) => s === '*' || s === 'https:')) return false;
  }
  return true;
}
