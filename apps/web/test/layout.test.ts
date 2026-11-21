import { describe, expect, it } from 'vitest';
import { desktopFor } from '../src/lib/layout.ts';

describe('rev 16: which layout the artist app uses', () => {
  it('Automatic: desktop from 1024px wide (laptops, iPads held sideways), phone below', () => {
    expect(desktopFor('auto', true, true)).toBe(true);
    expect(desktopFor('auto', false, true)).toBe(false); // iPad held upright
    expect(desktopFor('auto', false, false)).toBe(false); // phone
  });
  it('Phone layout: always the phone layout', () => {
    expect(desktopFor('phone', true, true)).toBe(false);
  });
  it('Desktop layout: desktop down to 640px, then the phone layout', () => {
    expect(desktopFor('desktop', false, true)).toBe(true);
    expect(desktopFor('desktop', false, false)).toBe(false);
  });
});
