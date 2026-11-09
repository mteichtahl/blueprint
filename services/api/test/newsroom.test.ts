import { describe, expect, it } from 'vitest';
import { routeOf } from '../src/handlers/newsroom.ts';
import {
  DEFAULT_SETTINGS,
  fallbackSections,
  isoWeek,
  pageSnapshot,
  parseFeed,
  rankStories,
  sectionsFromModel,
  weekOf,
  type Story,
} from '../src/newsroom/model.ts';

const since = new Date('2026-11-01T00:00:00Z');

describe('newsroom feeds', () => {
  it('reads RSS and Atom, keeps recent https items as plain text', () => {
    const rss = `<rss><channel>
      <item><title><![CDATA[Grants open for <b>emerging</b> artists]]></title><link>https://musicvic.example/grants</link>
        <pubDate>Mon, 09 Nov 2026 01:00:00 GMT</pubDate><description>&lt;p&gt;Apply by Dec&lt;/p&gt; &amp; more</description></item>
      <item><title>Old</title><link>https://x.example/old</link><pubDate>Mon, 05 Oct 2026 01:00:00 GMT</pubDate></item>
      <item><title>Insecure</title><link>http://x.example/plain</link></item>
    </channel></rss>`;
    const atom = `<feed><entry><title>Festival lineup</title><link href="https://fest.example/a"/><updated>2026-11-08T00:00:00Z</updated><summary>Big news</summary></entry></feed>`;
    const r = parseFeed(rss, 'Music Victoria', since);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      title: 'Grants open for emerging artists',
      url: 'https://musicvic.example/grants',
      summary: 'Apply by Dec & more',
    });
    expect(parseFeed(atom, 'Fest', since)[0]).toMatchObject({
      title: 'Festival lineup',
      url: 'https://fest.example/a',
    });
  });

  it('never lets markup through', () => {
    const r = parseFeed(
      '<item><title>&lt;script&gt;alert(1)&lt;/script&gt;Hi</title><link>https://a.example/x</link></item>',
      'S',
      since,
    );
    expect(r[0]!.title).not.toMatch(/[<>]/);
  });

  it('notices page changes by hash', () => {
    const a = pageSnapshot('<title>Grants</title><body>Round 1</body>');
    const b = pageSnapshot('<title>Grants</title><body>Round 2</body>');
    expect(a.title).toBe('Grants');
    expect(a.hash).not.toBe(b.hash);
  });

  it('ranks by what to look for, drops what to skip and duplicates', () => {
    const s = (id: string, title: string): Story => ({
      id,
      title,
      summary: '',
      url: `https://x.example/${id}`,
      source: 'X',
    });
    const ranked = rankStories(
      [
        s('1', 'Celebrity news roundup'),
        s('2', 'Chart update'),
        s('3', 'New grants for emerging artists'),
        s('3', 'dup'),
      ],
      DEFAULT_SETTINGS,
    );
    expect(ranked.map((x) => x.id)).toEqual(['3', '2']);
  });
});

describe('newsroom drafts', () => {
  const stories: Story[] = [
    { id: 's1', title: 'T', summary: 'S', url: 'https://x.example/1', source: 'X' },
  ];

  it('uses only stories we found, never links the model made up', () => {
    const sections = sectionsFromModel(
      {
        blueprint: [{ heading: 'Mixer', text: 'Come along' }],
        artists: [{ text: 'Chloe played' }],
        industry: [
          { url: 'https://x.example/1', summary: 'Good one' },
          { url: 'https://made-up.example/2', summary: 'Invented' },
        ],
      },
      stories,
      DEFAULT_SETTINGS,
    );
    expect(sections.industry.map((s) => s.url)).toEqual(['https://x.example/1']);
    expect(sections.industry[0]!.summary).toBe('Good one');
  });

  it('always has a plain draft to fall back to, honouring what goes in', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      include: { blueprint: true, artists: false, industry: true },
    };
    const f = fallbackSections(
      {
        blueprint: [{ heading: 'Mixer', text: 'Wed' }],
        artists: [{ name: 'Chloe', text: 'played' }],
      },
      stories,
      settings,
    );
    expect(f.artists).toEqual([]);
    expect(f.blueprint).toHaveLength(1);
    expect(f.industry).toHaveLength(1);
  });

  it('weeks start on Monday', () => {
    expect(weekOf(new Date('2026-11-15T20:00:00Z'))).toBe('2026-11-09');
    expect(weekOf(new Date('2026-11-16T01:00:00Z'))).toBe('2026-11-16');
    expect(isoWeek(new Date('2026-11-09T00:00:00Z'))).toBe(46);
  });

  it('routes under the proxy resource', () => {
    expect(routeOf('GET', '/newsroom')).toEqual({ route: 'GET /', id: '' });
    expect(routeOf('POST', '/newsroom/drafts/2026-11-16/approve')).toEqual({
      route: 'POST /drafts/:id/approve',
      id: '2026-11-16',
    });
    expect(routeOf('PUT', '/newsroom/settings')).toEqual({ route: 'PUT /settings', id: '' });
    expect(routeOf('DELETE', '/newsroom/sites/abc/')).toMatchObject({ route: 'DELETE /sites/:id' });
  });
});

describe('newsroom text extraction', () => {
  it('drops script and style contents however their end tags are written', () => {
    const a = pageSnapshot(
      '<title>T</title><script>alert(1)</script ><p>Body</p><STYLE>x{}</style\n>',
    );
    const b = pageSnapshot('<title>T</title><p>Body</p>');
    expect(a.hash).toBe(b.hash);
  });

  it('decodes entities once only', () => {
    const r = parseFeed(
      '<item><title>Tom &amp;amp; Jerry &#8217;s</title><link>https://a.example/x</link></item>',
      'S',
      new Date(0),
    );
    expect(r[0]!.title).toBe('Tom &amp; Jerry ’s');
  });
});
