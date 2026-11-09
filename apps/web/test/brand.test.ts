import { describe, expect, it } from 'vitest';
import { guessCategory } from '../src/pages/Assets.tsx';
import { contrastRatio } from '../src/pages/BrandKit.tsx';

describe('assets and brand kit helpers', () => {
  it('guesses an asset kind from the file type', () => {
    expect(guessCategory('image/jpeg')).toBe('press-photo');
    expect(guessCategory('image/svg+xml')).toBe('logo');
    expect(guessCategory('video/mp4')).toBe('video');
    expect(guessCategory('audio/wav')).toBe('audio');
    expect(guessCategory('application/pdf')).toBe('other');
  });

  it('works out WCAG contrast both ways round', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);
    expect(contrastRatio('#FFFFFF', '#011935')).toBe(contrastRatio('#011935', '#FFFFFF'));
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
});
