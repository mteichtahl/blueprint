import { describe, expect, it } from 'vitest';
import { TeamPatch } from '../src/access/model.ts';
import { ProfilePatch } from '../src/handlers/me.ts';
import { DisplayName, NAME_MAX, rosterSortKey, shownName } from '../src/people/names.ts';
import { plan } from '../src/notifications/model.ts';

describe('names (rev 22)', () => {
  it('tidies spaces and keeps any script', () => {
    expect(DisplayName.parse('  Chloe   Poli ')).toBe('Chloe Poli');
    expect(DisplayName.parse('SARUN')).toBe('SARUN');
    expect(DisplayName.parse('Beyoncé')).toBe('Beyoncé');
    expect(DisplayName.parse('宇多田ヒカル')).toBe('宇多田ヒカル');
  });

  it('refuses empty, too long, emoji-only and control characters', () => {
    expect(DisplayName.safeParse('   ').success).toBe(false);
    expect(DisplayName.safeParse('x'.repeat(NAME_MAX + 1)).success).toBe(false);
    expect(DisplayName.safeParse('🎸🎸').success).toBe(false);
    expect(DisplayName.safeParse('A\u0007B').success).toBe(false);
  });

  it('sorts the roster by name', () => {
    expect(rosterSortKey('Chloe Poli', 'art_x')).toBe('chloe poli#art_x');
  });

  it('can be changed with PATCH /me and by an admin on a team member', () => {
    expect(ProfilePatch.parse({ displayName: ' Kyra T ' }).displayName).toBe('Kyra T');
    expect(TeamPatch.parse({ displayName: 'Sam Lee' }).displayName).toBe('Sam Lee');
    expect(TeamPatch.safeParse({ displayName: '' }).success).toBe(false);
  });

  it('shows the artist’s roster name to artists and the profile name to Blueprint', () => {
    expect(shownName('artist', { displayName: 'Chloe Poli' }, { displayName: 'ignored' })).toBe(
      'Chloe Poli',
    );
    expect(shownName('bmg-admin', undefined, { displayName: 'Kyra' })).toBe('Kyra');
    expect(shownName('bmg-staff', undefined, {})).toBeNull();
  });
});

describe('notifications (rev 22)', () => {
  const everyone = [
    { sub: 's-artist', role: 'artist' as const, artistId: 'art_a', email: 'a@x' },
    { sub: 's-other', role: 'artist' as const, artistId: 'art_b', email: 'b@x' },
    { sub: 's-admin', role: 'bmg-admin' as const, email: 'k@x' },
    { sub: 's-staff', role: 'bmg-staff' as const, email: 's@x' },
  ];

  it('tells only that artist when Blueprint renames them', () => {
    const p = plan(
      {
        type: 'artist.renamed',
        artistId: 'art_a',
        name: 'Chloe Poli',
        bySub: 's-admin',
        byName: 'Kyra',
      },
      everyone as never,
    )!;
    expect(p.to.map((r) => r.sub)).toEqual(['s-artist']);
    expect(p.draft.title).toBe('Kyra updated your name to Chloe Poli');
  });

  it('tells every admin when a deletion finishes, with mentions to review', () => {
    const p = plan(
      {
        type: 'artist.deleted',
        artistId: 'art_a',
        name: 'Chloe Poli',
        bySub: 's-admin',
        mentions: 2,
      },
      everyone as never,
    )!;
    expect(p.to.map((r) => r.sub)).toEqual(['s-admin']);
    expect(p.draft.body).toContain('2 Blueprint documents still mention them');
  });
});
