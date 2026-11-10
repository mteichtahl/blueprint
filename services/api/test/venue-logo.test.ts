import { describe, expect, it } from 'vitest';
import {
  findLogoCandidates,
  isPublicAddress,
  LOGO_MAX_BYTES,
  logoVersion,
  parseLogoDataUrl,
  siteUrl,
  sniffImage,
} from '../src/address-book/logo.ts';
import { VenueBody, venueFor, VenuePatch, type Venue } from '../src/address-book/model.ts';
import { routeOf } from '../src/handlers/address-book.ts';
import { makeSafeLookup, Refused } from '../src/address-book/logo-fetch.ts';

/** A real 1×1 PNG. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const pngOf = (w: number, h: number) => {
  const b = Buffer.from(PNG_1PX);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

describe('sniffImage', () => {
  it('knows images by their bytes', () => {
    expect(sniffImage(PNG_1PX)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe('image/x-icon');
    expect(
      sniffImage(Buffer.from('<?xml version="1.0"?>\n<!-- x --><svg viewBox="0 0 1 1"/>')),
    ).toBe('image/svg+xml');
  });
  it('refuses things that are not images', () => {
    expect(sniffImage(Buffer.from('<!doctype html><html>'))).toBeNull();
    expect(sniffImage(Buffer.from('{"logo":1}'))).toBeNull();
  });
});

describe('parseLogoDataUrl (what the browser saves)', () => {
  const url = (type: string, b: Buffer) => `data:${type};base64,${b.toString('base64')}`;
  it('accepts a small PNG and versions it by content', () => {
    const { contentType, bytes } = parseLogoDataUrl(url('image/png', PNG_1PX));
    expect(contentType).toBe('image/png');
    expect(logoVersion(bytes)).toHaveLength(12);
    expect(logoVersion(bytes)).toBe(logoVersion(PNG_1PX));
  });
  it('never stores SVG, mislabelled bytes, huge images or oversized files', () => {
    expect(() => parseLogoDataUrl(url('image/svg+xml', Buffer.from('<svg/>')))).toThrow();
    expect(() => parseLogoDataUrl(url('image/jpeg', PNG_1PX))).toThrow(/valid image/);
    expect(() => parseLogoDataUrl(url('image/png', pngOf(2000, 100)))).toThrow(/512px/);
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(LOGO_MAX_BYTES)]);
    expect(() => parseLogoDataUrl(url('image/png', big))).toThrow(/too large/);
    expect(() => parseLogoDataUrl('https://example.com/logo.png')).toThrow();
  });
});

describe('which addresses we may fetch', () => {
  it('allows public addresses only', () => {
    expect(isPublicAddress('203.2.218.214')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.100.1.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '64:ff9b::a9fe:a9fe',
      'not-an-ip',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });
  it('cleans up the website someone typed', () => {
    expect(siteUrl('thecorner.com.au')?.toString()).toBe('https://thecorner.com.au/');
    expect(siteUrl('http://venue.com/#top')?.toString()).toBe('http://venue.com/');
    for (const bad of [
      '',
      'ftp://venue.com',
      'file:///etc/passwd',
      'http://localhost/',
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://169.254.169.254/latest',
      'https://user:pw@venue.com',
      'https://venue.com:8443/',
      'http://intranet/',
      'http://metadata.google.internal/',
    ])
      expect(siteUrl(bad), bad).toBeNull();
  });
});

describe('findLogoCandidates', () => {
  const page = 'https://www.thecorner.com.au/gigs';
  it('ranks structured data, header logo, touch icon, icons, then favicon', () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
      <meta property="og:image" content="https://cdn.x.com/hero-crowd.jpg">
      <script type="application/ld+json">{"@type":"MusicVenue","logo":{"@type":"ImageObject","url":"https://cdn.x.com/brand/logo.png"}}</script>
      </head><body>
      <header><a href="/"><img class="site-logo" src="/img/corner-logo.png" alt="The Corner Hotel"></a></header>
      <img src="/img/hero.jpg" alt="crowd">
      <footer><img src="/img/sponsor-logo.png" alt="sponsor logo"></footer>
      </body></html>`;
    const c = findLogoCandidates(html, page);
    expect(c.map((x) => x.why)).toEqual([
      'structured-data',
      'header-logo',
      'apple-touch-icon',
      'icon',
      'icon',
      'favicon',
    ]);
    expect(c[0]!.url).toBe('https://cdn.x.com/brand/logo.png');
    expect(c[1]!.url).toBe('https://www.thecorner.com.au/img/corner-logo.png');
    expect(c.at(-1)!.url).toBe('https://www.thecorner.com.au/favicon.ico');
    // Hero photos and sponsor logos are never offered.
    expect(c.some((x) => /hero|sponsor/.test(x.url))).toBe(false);
  });

  it('handles lazy images, srcset, <base> and entities', () => {
    const html = `<base href="https://static.site.com/assets/">
      <img data-src="logo-main.png?w=300&amp;h=100" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" class="Header-branding-logo">
      <img srcset="brand-logo@2x.png 2x, brand-logo.png 1x" alt="logo">`;
    const urls = findLogoCandidates(html, page).map((x) => x.url);
    expect(urls[0]).toBe('https://static.site.com/assets/logo-main.png?w=300&h=100');
    expect(urls).toContain('https://static.site.com/assets/brand-logo@2x.png');
  });

  it('ignores bad JSON-LD and non-web links, and still offers the favicon', () => {
    const html = `<script type="application/ld+json">{oops</script>
      <link rel="icon" href="javascript:alert(1)"><img class="logo" src="ftp://x/logo.png">`;
    expect(findLogoCandidates(html, page)).toEqual([
      { url: 'https://www.thecorner.com.au/favicon.ico', why: 'favicon', score: 10 },
    ]);
  });
});

describe('venues and logos', () => {
  it('"Automatically get logo" is on by default and can be turned off', () => {
    expect(VenueBody.parse({ name: 'The Corner' }).autoLogo).toBe(true);
    expect(VenueBody.parse({ name: 'The Corner', autoLogo: false }).autoLogo).toBe(false);
    expect(VenuePatch.parse({ autoLogo: false })).toEqual({ autoLogo: false });
  });

  it('shows the logo version, not the image, and treats old venues as auto', () => {
    const v: Venue = {
      ...VenueBody.parse({ name: 'Old Venue' }),
      venueId: 'v0000000001',
      createdBy: 'u1',
      createdByRole: 'bmg',
      createdAt: '2026-11-01T00:00:00Z',
    };
    delete (v as Partial<Venue>).autoLogo;
    expect(venueFor(v, false, false, new Map())).toMatchObject({ autoLogo: true, logo: null });
    const withLogo: Venue = {
      ...v,
      logo: {
        version: 'abc123def456',
        source: 'website',
        sourceUrl: 'https://x.com/l.png',
        updatedAt: '',
      },
    };
    expect(venueFor(withLogo, false, false, new Map()).logo).toEqual({
      version: 'abc123def456',
      source: 'website',
      sourceUrl: 'https://x.com/l.png',
    });
  });

  it('routes the logo endpoints', () => {
    expect(routeOf('POST', '/venues/logo-lookup')).toEqual({
      route: 'POST /venues/:id',
      id: 'logo-lookup',
    });
    expect(routeOf('PUT', '/venues/abc0000001/logo').route).toBe('PUT /venues/:id/logo');
    expect(routeOf('GET', '/venues/abc0000001/logo').route).toBe('GET /venues/:id/logo');
  });
});

describe('connect-time DNS guard', () => {
  const resolveTo =
    (...ips: string[]) =>
    (_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(
        null,
        ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
  const run = (ips: string[], all = false) =>
    new Promise<{ err: Error | null; addr: unknown }>((done) =>
      makeSafeLookup(resolveTo(...ips))(
        'venue.example.com',
        { all } as never,
        ((err: Error | null, addr: unknown) => done({ err, addr })) as never,
      ),
    );

  it('connects to public addresses', async () => {
    expect((await run(['203.2.218.214'])).addr).toBe('203.2.218.214');
    expect((await run(['203.2.218.214'], true)).addr).toEqual([
      { address: '203.2.218.214', family: 4 },
    ]);
  });
  it('refuses a name that resolves (even partly) to an internal address', async () => {
    for (const ips of [['169.254.169.254'], ['127.0.0.1'], ['203.2.218.214', '10.0.0.5'], []])
      expect((await run(ips)).err).toBeInstanceOf(Refused);
  });
});
