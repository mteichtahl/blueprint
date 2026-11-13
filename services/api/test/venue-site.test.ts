import { describe, expect, it } from 'vitest';
import {
  addressPages,
  embeddable,
  findAddress,
  findSiteName,
  fromText,
} from '../src/address-book/site.ts';

describe('findAddress (paste a website, get the address)', () => {
  it('reads schema.org JSON-LD, including inside @graph', () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"x"},
      {"@type":"MusicVenue","name":"The Corner","address":{"@type":"PostalAddress",
        "streetAddress":"57 Swan St","addressLocality":"Richmond VIC","postalCode":"3121"}}]}</script>`;
    expect(findAddress(html)).toEqual({ address: '57 Swan St', suburb: 'Richmond' });
  });

  it('skips broken JSON-LD and falls back to microdata', () => {
    const html = `<script type="application/ld+json">{oops</script>
      <div itemscope><span itemprop="streetAddress">29 Smith St</span>
      <span itemprop="addressLocality">Fitzroy</span></div>`;
    expect(findAddress(html)).toEqual({ address: '29 Smith St', suburb: 'Fitzroy' });
  });

  it('reads Open Graph business meta tags', () => {
    const html = `<meta property="business:contact_data:street_address" content="1 Brunswick St">
      <meta property="business:contact_data:locality" content="Fitzroy">`;
    expect(findAddress(html)).toEqual({ address: '1 Brunswick St', suburb: 'Fitzroy' });
  });

  it('finds an Australian address in the page text', () => {
    const html = `<footer><p>Find us</p><p>Shop 2/123 High Street,<br>Northcote VIC 3070</p>
      <script>var x = "9 Fake St, Nowhere VIC 3000"</script></footer>`;
    expect(findAddress(html)).toEqual({ address: 'Shop 2/123 High Street', suburb: 'Northcote' });
    expect(fromText('Visit us at 418 Sydney Road, Brunswick, VIC 3056 any night')).toEqual({
      address: '418 Sydney Road',
      suburb: 'Brunswick',
    });
  });

  it('returns null when the page gives no address', () => {
    expect(findAddress('<h1>Gigs this week</h1><p>Call 03 9000 0000</p>')).toBeNull();
  });
});

describe('findSiteName', () => {
  it('prefers og:site_name, else the title before the separator', () => {
    expect(findSiteName('<meta property="og:site_name" content="Howler">')).toBe('Howler');
    expect(findSiteName('<title>The Tote Hotel | Live Music Collingwood</title>')).toBe(
      'The Tote Hotel',
    );
    expect(findSiteName('<title>Home</title>')).toBe('');
  });
});

describe('addressPages', () => {
  it('picks same-site contact pages first, never other sites', () => {
    const html = `<a href="/about-us">About</a><a href="/contact">Contact</a>
      <a href="https://facebook.com/contact">FB</a><a href="/gigs">Gigs</a>`;
    expect(addressPages(html, 'https://venue.com.au/')).toEqual([
      'https://venue.com.au/contact',
      'https://venue.com.au/about-us',
    ]);
  });
});

describe('embeddable (can it sit beside the map?)', () => {
  it('allows https sites that do not forbid framing', () => {
    expect(embeddable('https://a.com/', {})).toBe(true);
    expect(
      embeddable('https://a.com/', { 'content-security-policy': "frame-ancestors 'self' https:" }),
    ).toBe(true);
  });
  it('refuses X-Frame-Options, a strict frame-ancestors, and plain http', () => {
    expect(embeddable('https://a.com/', { 'x-frame-options': 'SAMEORIGIN' })).toBe(false);
    expect(
      embeddable('https://a.com/', {
        'content-security-policy': "default-src *; frame-ancestors 'self'",
      }),
    ).toBe(false);
    expect(embeddable('http://a.com/', {})).toBe(false);
  });
});
