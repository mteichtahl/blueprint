import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

/**
 * Venue logos. A venue can have one logo: uploaded by the person adding it, or
 * found on the venue's website when "Automatically get logo" is on (the
 * default) and nothing was uploaded.
 *
 * Both routes end the same way: the browser draws the image onto a canvas and
 * sends a small PNG/WebP/JPEG as a data URL, so what's stored is always a
 * re-encoded raster image (never SVG or anything with script in it), at most
 * `LOGO_MAX_BYTES`. It lives in its own item (`VENUELOGO#<id>`) so the venue
 * list stays small; the venue only carries a version for caching.
 *
 * Everything here is pure, so it is unit-tested. The network side is in
 * `logo-fetch.ts`.
 */

export const venueLogoSk = (id: string) => `VENUELOGO#${id}`;
/** A stored logo, after the browser has shrunk it (max 512px on the long side). */
export const LOGO_MAX_BYTES = 160 * 1024;
export const LOGO_MAX_SIDE = 512;
/** Limits while looking on a website. */
export const PAGE_MAX_BYTES = 1_500_000;
export const IMAGE_MAX_BYTES = 1_000_000;

export type LogoSource = 'upload' | 'website';
export interface VenueLogoMeta {
  /** Changes whenever the image does; the web app caches by it. */
  version: string;
  source: LogoSource;
  /** Where on the web it came from (website logos only). */
  sourceUrl?: string;
  updatedAt: string;
}

type StoredType = 'image/png' | 'image/jpeg' | 'image/webp';

export const LogoUpload = z
  .object({
    dataUrl: z.string().max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 64),
    source: z.enum(['upload', 'website']).default('upload'),
    sourceUrl: z.string().trim().max(1000).optional(),
  })
  .strict();

export const LogoLookup = z
  .object({ url: z.string().trim().min(1, 'Add the venue website first').max(300) })
  .strict();

// ── Image sniffing ────────────────────────────────────────────────────────
export type SniffedType = StoredType | 'image/gif' | 'image/x-icon' | 'image/svg+xml';

/** What an image really is, from its first bytes (never trust a Content-Type). */
export function sniffImage(b: Uint8Array): SniffedType | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    b.length >= 6 &&
    (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))
  )
    return 'image/gif';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return 'image/webp';
  if (b.length >= 6 && at(0, 0x00, 0x00, 0x01, 0x00) && b[4]! > 0) return 'image/x-icon';
  // SVG: text whose first real element is <svg (after a BOM, <?xml ?>, comments or a doctype).
  // Skips only what comes *before* the first element, one item at a time, by
  // position (this is a type check, not sanitising: the text is never shown).
  let head = new TextDecoder('utf-8', { fatal: false })
    .decode(b.subarray(0, 2048))
    .replace(/^\uFEFF/, '');
  for (let i = 0; i < 20; i++) {
    head = head.trimStart();
    const end = head.startsWith('<?')
      ? head.indexOf('?>') + 2
      : head.startsWith('<!--')
        ? head.indexOf('-->', 4) + 3
        : /^<!doctype/i.test(head)
          ? head.indexOf('>') + 1
          : 0;
    if (end <= 2) break; // nothing to skip, or an unterminated item
    head = head.slice(end);
  }
  if (/^<svg[\s>/]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Width and height of a PNG (from its IHDR chunk), or null. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (sniffImage(b) !== 'image/png' || b.length < 24) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/**
 * Checks a logo the browser sends: a base64 data URL of a PNG, JPEG or WebP,
 * whose bytes really are that type, small enough to store.
 */
export function parseLogoDataUrl(dataUrl: string): { contentType: StoredType; bytes: Buffer } {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) throw new Error('The logo must be a PNG, JPEG or WebP image');
  const contentType = m[1] as StoredType;
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length === 0) throw new Error('The logo is empty');
  if (bytes.length > LOGO_MAX_BYTES) throw new Error('The logo is too large');
  if (sniffImage(bytes) !== contentType) throw new Error("The logo isn't a valid image");
  const size = pngSize(bytes);
  if (size && (size.width > LOGO_MAX_SIDE || size.height > LOGO_MAX_SIDE))
    throw new Error(`The logo must be at most ${LOGO_MAX_SIDE}px on each side`);
  return { contentType, bytes };
}

export const logoVersion = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('base64url').slice(0, 12);

// ── Which addresses we may fetch ─────────────────────────────────────────
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/**
 * True only for ordinary internet addresses. Private, loopback, link-local
 * (including the instance metadata and Lambda runtime endpoints), CGNAT,
 * multicast and documentation ranges are all refused, as are IPv6 forms that
 * wrap an IPv4 address.
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return !blocked.check(ip, 'ipv4');
  if (kind !== 6) return false;
  const lower = ip.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (/^::ffff:/i.test(lower)) return false;
  return !blocked.check(ip, 'ipv6');
}

/**
 * The website to look at: http or https on the normal ports, no user name or
 * password. A bare domain gets https:// added. Returns null if it can't be used.
 */
export function siteUrl(input: string): URL | null {
  const raw = input.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return null;
  if (isIP(host) && !isPublicAddress(host)) return null;
  if (!isIP(host) && !host.includes('.')) return null;
  u.hash = '';
  return u;
}

// ── Finding logo candidates in a page ────────────────────────────────────
export interface LogoCandidate {
  url: string;
  why:
    | 'structured-data'
    | 'header-logo'
    | 'logo-image'
    | 'apple-touch-icon'
    | 'icon'
    | 'og-logo'
    | 'favicon';
  score: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1),
      );
    return ENTITIES[e.toLowerCase()] ?? all;
  });

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m; (m = re.exec(raw));) {
    const k = m[1]!.toLowerCase();
    if (!(k in out)) out[k] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** The biggest side in a `sizes` attribute ("32x32 192x192" → 192, "any" → 512). */
function largestSize(sizes: string | undefined): number {
  if (!sizes) return 0;
  if (/\bany\b/i.test(sizes)) return 512;
  return Math.max(
    0,
    ...[...sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)].map((m) => Math.min(+m[1]!, +m[2]!)),
  );
}

/**
 * "logo" in a class, id, alt, title or file name. ("brand" alone is too loose:
 * design systems put it in every class name.)
 */
const LOGO_WORD = /(?:^|[^a-z])logo(?:type|s)?(?:[^a-z]|$)/i;
const NOT_LOGO =
  /(?:sponsor|partner|payment|visa|mastercard|paypal|afterpay|apple-?pay|google-?play|app-?store|badge|footer|social|facebook|instagram|twitter|tiktok|youtube|spotify|linkedin)/i;

function collectJsonLdLogos(node: unknown, out: string[], depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdLogos(n, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'logo') {
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const u = o.url ?? o.contentUrl ?? o['@id'];
        if (typeof u === 'string') out.push(u);
      }
    } else collectJsonLdLogos(v, out, depth + 1);
  }
}

/**
 * Where a venue's logo might be on its home page, best first: the logo named
 * in structured data, an image marked as the logo (in the header first), the
 * Apple touch icon, the larger site icons, an og:image that is clearly a logo,
 * and finally /favicon.ico.
 */
export function findLogoCandidates(html: string, pageUrl: string): LogoCandidate[] {
  const found: LogoCandidate[] = [];
  let base = pageUrl;
  const baseHref = /<base\b([^>]*)>/i.exec(html);
  if (baseHref) {
    const href = attrs(baseHref[1]!).href;
    if (href) {
      try {
        base = new URL(href, pageUrl).toString();
      } catch {
        /* keep the page URL */
      }
    }
  }
  const add = (raw: string | undefined, why: LogoCandidate['why'], score: number) => {
    if (!raw) return;
    const v = raw.trim();
    if (!v) return;
    if (/^data:image\//i.test(v)) {
      if (v.length <= Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 100)
        found.push({ url: v, why, score });
      return;
    }
    try {
      const u = new URL(v, base);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
      u.hash = '';
      found.push({ url: u.toString(), why, score });
    } catch {
      /* not a URL */
    }
  };

  // Structured data (schema.org Organization / LocalBusiness / MusicVenue logo).
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const logos: string[] = [];
      collectJsonLdLogos(JSON.parse(m[1]!.trim()), logos);
      for (const l of logos) add(l, 'structured-data', 100);
    } catch {
      /* bad JSON-LD is common; ignore it */
    }
  }

  // Where the first <header> (or role=banner) is, to favour logos inside it.
  const headerStart = html.search(/<header\b|role\s*=\s*["']?banner/i);
  const headerEnd = headerStart >= 0 ? html.indexOf('</header>', headerStart) : -1;
  const inHeader = (i: number) =>
    headerStart >= 0 &&
    i >= headerStart &&
    (headerEnd < 0 ? i - headerStart < 20_000 : i <= headerEnd);

  let imgOrder = 0;
  for (const m of html.matchAll(/<(link|meta|img|source)\b([^>]*)>/gi)) {
    const tag = m[1]!.toLowerCase();
    const a = attrs(m[2]!);
    if (tag === 'link') {
      const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed'))
        add(a.href, 'apple-touch-icon', 70 + Math.min(largestSize(a.sizes), 512) / 100);
      else if (rel.includes('icon') || rel.includes('mask-icon')) {
        if (rel.includes('mask-icon')) continue; // single-colour Safari pin, a poor logo
        const svg = /svg/i.test(a.type ?? '') || /\.svg(?:$|\?)/i.test(a.href ?? '');
        const size = svg ? 512 : largestSize(a.sizes);
        add(a.href, 'icon', size >= 96 ? 60 + size / 100 : 30 + size / 10);
      }
    } else if (tag === 'meta') {
      const prop = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
      if (prop === 'og:logo' || prop === 'logo') add(a.content, 'og-logo', 75);
      else if ((prop === 'og:image' || prop === 'twitter:image') && /logo/i.test(a.content ?? ''))
        add(a.content, 'og-logo', 55);
    } else if (tag === 'img') {
      const src = a.src && !/^data:image\/gif/i.test(a.src) ? a.src : (a['data-src'] ?? a.src);
      const firstSrcset = (a.srcset ?? a['data-srcset'] ?? '')
        .split(',')[0]
        ?.trim()
        .split(/\s+/)[0];
      const url = src || firstSrcset;
      const words = [a.class, a.id, a.alt, a.title, a.itemprop, url].filter(Boolean).join(' ');
      if (!LOGO_WORD.test(words) || NOT_LOGO.test(words)) continue;
      const header = inHeader(m.index ?? 0);
      // Earlier logo images beat later ones (the site's own logo comes first).
      add(url, header ? 'header-logo' : 'logo-image', (header ? 90 : 80) - Math.min(imgOrder++, 9));
    }
  }

  // Inline <svg> logos can't be fetched; they're skipped (the icons still work).
  try {
    add(new URL('/favicon.ico', pageUrl).toString(), 'favicon', 10);
  } catch {
    /* ignore */
  }

  const seen = new Set<string>();
  return found
    .sort((x, y) => y.score - x.score)
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

/** A data: URL found in a page, decoded (still to be sniffed). */
export function decodeDataUrl(u: string): Buffer | null {
  const m = /^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,(.*)$/is.exec(u);
  if (!m) return null;
  try {
    return m[3] ? Buffer.from(m[4]!, 'base64') : Buffer.from(decodeURIComponent(m[4]!), 'utf8');
  } catch {
    return null;
  }
}
