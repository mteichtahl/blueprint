import { describe, expect, it } from 'vitest';
import raw from 'emojibase-data/en/compact.json' with { type: 'json' };
import { GROUPS, prepare, searchEmoji, withTone } from '../src/components/EmojiPicker.tsx';

const all = prepare(raw as never);

describe('emoji picker', () => {
  it('has the full set, without bare skin-tone swatches', () => {
    expect(all.length).toBeGreaterThan(1800);
    expect(all.some((e) => e.group === 2)).toBe(false);
    for (const g of GROUPS) expect(all.some((e) => e.group === g.id)).toBe(true);
  });

  it('finds emoji by name and tag', () => {
    expect(searchEmoji(all, 'guitar').map((e) => e.unicode)).toContain('🎸');
    expect(searchEmoji(all, 'hi').map((e) => e.unicode)).toContain('👋');
    expect(searchEmoji(all, 'red heart').map((e) => e.unicode)).toContain('❤️');
    expect(searchEmoji(all, '')).toEqual([]);
  });

  it('applies skin tones where an emoji has them', () => {
    const wave = all.find((e) => e.unicode === '👋')!;
    expect(withTone(wave, 0)).toBe('👋');
    expect(withTone(wave, 3)).toBe('👋🏽');
    const guitar = all.find((e) => e.unicode === '🎸')!;
    expect(withTone(guitar, 3)).toBe('🎸');
  });
});
