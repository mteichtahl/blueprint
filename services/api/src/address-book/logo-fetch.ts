import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  decodeDataUrl,
  findLogoCandidates,
  IMAGE_MAX_BYTES,
  isPublicAddress,
  PAGE_MAX_BYTES,
  siteUrl,
  sniffImage,
  type LogoCandidate,
  type SniffedType,
} from './logo.ts';
import { addressPages, embeddable, findAddress, findSiteName, type FoundAddress } from './site.ts';

/**
 * Looks on a venue's website for its logo ("Automatically get logo").
 *
 * The Lambda fetches pages that people type in, so it guards against being
 * pointed inward (SSRF): every hostname is resolved by our own `lookup`, which
 * refuses private, loopback and link-local addresses at connect time (so DNS
 * rebinding can't slip past a check made earlier); IP-literal hosts are
 * checked directly; each redirect is checked again; only ports 80 and 443;
 * and every response is capped in size and time.
 */

const USER_AGENT = 'BlueprintMusicGroup-LogoFinder/1.0 (+https://blueprintmusic.group)';
const MAX_REDIRECTS = 4;
const MAX_TRIES = 6;

export class Refused extends Error {}

type Resolver = (
  host: string,
  opts: { all: true },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for http(s).request that refuses the connection if the name
 * resolves to any non-public address. Exported (with a resolver to swap in)
 * for tests.
 */
export const makeSafeLookup =
  (resolve: Resolver = dnsLookup as unknown as Resolver): LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const list = addresses as LookupAddress[];
      if (!list.length || list.some((a) => !isPublicAddress(a.address)))
        return callback(new Refused(`Refused to connect to ${hostname}`), '', 4);
      if ((options as { all?: boolean }).all)
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
const safeLookup = makeSafeLookup();

export interface Fetched {
  url: string;
  contentType: string;
  body: Buffer;
  headers: IncomingMessage['headers'];
}

function decoded(res: IncomingMessage): NodeJS.ReadableStream {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip());
  if (enc === 'br') return res.pipe(createBrotliDecompress());
  if (enc === 'deflate') return res.pipe(createInflate());
  return res;
}

/** One GET, following up to four redirects, each checked like the first. */
export async function fetchLimited(
  start: string,
  { accept, maxBytes, deadline }: { accept: string; maxBytes: number; deadline: number },
): Promise<Fetched> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = siteUrl(url);
    if (!u) throw new Refused('Not a website we can look at');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) throw new Refused('Refused address');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timed out');

    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = (u.protocol === 'https:' ? https : http).request(
        u,
        {
          method: 'GET',
          lookup: safeLookup,
          headers: {
            'user-agent': USER_AGENT,
            accept,
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-AU,en;q=0.8',
          },
          timeout: Math.min(remaining, 5000),
          agent: false,
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error('Timed out')));
      req.on('error', reject);
      setTimeout(() => req.destroy(new Error('Timed out')), remaining).unref();
      req.end();
    });

    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, u).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`HTTP ${status}`);
    }
    const declared = Number(res.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
      res.destroy();
      throw new Error('Too large');
    }
    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const stream = decoded(res);
      const timer = setTimeout(
        () => {
          res.destroy();
          reject(new Error('Timed out'));
        },
        Math.max(0, deadline - Date.now()),
      );
      timer.unref();
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          clearTimeout(timer);
          res.destroy();
          reject(new Error('Too large'));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      stream.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    return {
      url: u.toString(),
      contentType: String(res.headers['content-type'] ?? ''),
      body,
      headers: res.headers,
    };
  }
  throw new Error('Too many redirects');
}

export interface FoundLogo {
  /** The image as a data URL, for the browser to resize and save. */
  dataUrl: string;
  contentType: SniffedType;
  /** Where it came from (the page itself for an inline data: image). */
  sourceUrl: string;
  why: LogoCandidate['why'];
}

/**
 * The best logo we can find on a venue's website, or null. Gives up after
 * `budgetMs` overall, and tries at most six candidates.
 */
export async function findVenueLogo(website: string, budgetMs = 8000): Promise<FoundLogo | null> {
  const u = siteUrl(website);
  if (!u) return null;
  const deadline = Date.now() + budgetMs;

  let candidates: LogoCandidate[];
  let page = u.toString();
  try {
    const res = await fetchLimited(page, {
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      maxBytes: PAGE_MAX_BYTES,
      deadline,
    });
    page = res.url;
    const html =
      /html|xml|text\/plain/i.test(res.contentType) || !res.contentType
        ? res.body.toString('utf8')
        : '';
    candidates = findLogoCandidates(html, page);
  } catch (e) {
    if (e instanceof Refused) return null;
    // The page wouldn't load; the favicon may still.
    candidates = findLogoCandidates('', page);
  }

  for (const c of candidates.slice(0, MAX_TRIES)) {
    if (Date.now() >= deadline) break;
    try {
      const bytes = c.url.startsWith('data:')
        ? decodeDataUrl(c.url)
        : (
            await fetchLimited(c.url, {
              accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8',
              maxBytes: IMAGE_MAX_BYTES,
              deadline,
            })
          ).body;
      if (!bytes || bytes.length < 64 || bytes.length > IMAGE_MAX_BYTES) continue;
      const type = sniffImage(bytes);
      if (!type) continue;
      return {
        dataUrl: `data:${type};base64,${bytes.toString('base64')}`,
        contentType: type,
        sourceUrl: c.url.startsWith('data:') ? page : c.url,
        why: c.why,
      };
    } catch {
      // Try the next one.
    }
  }
  return null;
}

export interface SiteInfo {
  /** Where the website ended up after redirects (what the venue page frames). */
  url: string;
  /** The street address and suburb, when the site says where the venue is. */
  address: FoundAddress | null;
  /** A name for the venue (og:site_name or the page title), or ''. */
  name: string;
  /** Whether the site lets itself be shown in an iframe on our page. */
  embeddable: boolean;
}

const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';
const htmlOf = (r: Fetched) =>
  /html|xml|text\/plain/i.test(r.contentType) || !r.contentType ? r.body.toString('utf8') : '';

/**
 * Looks at a venue's website for its address and name, and whether it can be
 * shown beside the map. If the home page doesn't give an address, tries up to
 * two "contact" / "find us" pages on the same site. Same SSRF guards and limits
 * as the logo finder; null if the site can't be reached at all.
 */
export async function inspectVenueSite(website: string, budgetMs = 8000): Promise<SiteInfo | null> {
  const u = siteUrl(website);
  if (!u) return null;
  const deadline = Date.now() + budgetMs;
  let home: Fetched;
  try {
    home = await fetchLimited(u.toString(), {
      accept: HTML_ACCEPT,
      maxBytes: PAGE_MAX_BYTES,
      deadline,
    });
  } catch {
    return null;
  }
  const html = htmlOf(home);
  let address = findAddress(html);
  for (const page of address ? [] : addressPages(html, home.url)) {
    if (Date.now() >= deadline) break;
    try {
      address = findAddress(
        htmlOf(
          await fetchLimited(page, { accept: HTML_ACCEPT, maxBytes: PAGE_MAX_BYTES, deadline }),
        ),
      );
      if (address) break;
    } catch {
      // Try the next page.
    }
  }
  return {
    url: home.url,
    address,
    name: findSiteName(html),
    embeddable: embeddable(home.url, home.headers),
  };
}
