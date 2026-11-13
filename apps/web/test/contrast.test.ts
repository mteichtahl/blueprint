import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/pages/BrandKit.tsx';

/**
 * Phase 6 gate, colour half: WCAG 2.2 AA contrast for the app's own colours,
 * read straight from index.css so a palette change can't slip past.
 * Text needs 4.5:1 (1.4.3); field borders and focus/selection indicators
 * need 3:1 against what's next to them (1.4.11).
 */
const css = readFileSync(resolve(import.meta.dirname, '../src/index.css'), 'utf8');

/** The value of `prop` in the first rule whose selector list is exactly `selector`. */
function value(selector: string, prop: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const block = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!block) throw new Error(`no rule for ${selector}`);
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`).exec(block[1]!);
  if (!m) throw new Error(`no ${prop} in ${selector}`);
  return m[1]!.trim().toLowerCase();
}
const token = (name: string, dark = false) => value(dark ? '.dark' : '@theme', `--color-${name}`);
const hex = (raw: string) => {
  const v = /^#[0-9a-f]{3}$/.test(raw) ? `#${[...raw.slice(1)].map((c) => c + c).join('')}` : raw;
  if (!/^#[0-9a-f]{6}$/.test(v)) throw new Error(`not a hex colour: ${v}`);
  return v.toUpperCase();
};

const WHITE = '#FFFFFF';
const NAVY = '#011935';

describe('colour contrast (WCAG 2.2 AA)', () => {
  const light = {
    bg: hex(token('background')),
    card: hex(token('card')),
    secondary: hex(token('secondary')),
    fg: hex(token('foreground')),
    muted: hex(token('muted-foreground')),
  };
  const dark = {
    bg: hex(token('background', true)),
    card: hex(token('card', true)),
    secondary: hex(token('secondary', true)),
    fg: hex(token('foreground', true)),
    muted: hex(token('muted-foreground', true)),
  };

  const text: [string, string, string][] = [
    ['body text on page', light.fg, light.bg],
    ['body text on card', light.fg, light.card],
    ['muted text on card', light.muted, light.card],
    ['muted text on page', light.muted, light.bg],
    ['muted text on grey panels', light.muted, light.secondary],
    ['eyebrow on card', hex(value('.eyebrow', 'color')), light.card],
    ['eyebrow on page', hex(value('.eyebrow', 'color')), light.bg],
    ['coral tag', hex(value('.tc', 'color')), hex(value('.tc', 'background'))],
    ['slate tag', hex(value('.ts', 'color')), hex(value('.ts', 'background'))],
    ['navy tag', hex(value('.tn', 'color')), hex(value('.tn', 'background'))],
    ['deep coral tag', hex(value('.tk', 'color')), hex(value('.tk', 'background'))],
    ['primary button', WHITE, hex(token('cta'))],
    ['primary button (hover)', WHITE, hex(token('cta-hover'))],
    ['navy button', hex(token('primary-foreground')), hex(token('primary'))],
    // Headliner: the light-coral buttons carry navy text.
    ['pop button', hex(token('pop-foreground')), hex(token('pop'))],
    ['pop button (hover)', hex(token('pop-foreground')), hex(token('pop-hover'))],
    ['sidebar item (current)', NAVY, hex(value(".nav[aria-current='page']", 'background'))],
    ['phone tab (current)', hex(value(".ptab[aria-current='page']", 'color')), NAVY],
    ['phone tab (on the off-white tab bar)', hex(value('.ptab', 'color')), '#F1F4F7'],
    ['selected workspace tab', hex(value(".wtab[aria-selected='true']", 'color')), NAVY],
    ['ask button', hex(value('.askbtn', 'color')), hex(value('.askbtn', 'background'))],
    ['lilac (hover)', NAVY, hex(token('lilac-hover'))],
    ['ribbon', hex(value('.ribbon', 'color')), hex(value('.ribbon', 'background'))],
    ['sidebar item', hex(value('.nav', 'color')), NAVY],
    ['sidebar section label', hex(value('.navlabel', 'color')), NAVY],
    ['workspace tab', hex(value('.wtab', 'color')), light.bg],
    [
      'placeholder',
      hex(value('::placeholder,\n.md .is-editor-empty:first-child::before', 'color')),
      WHITE,
    ],
    ['dark: body text on page', dark.fg, dark.bg],
    ['dark: body text on card', dark.fg, dark.card],
    ['dark: muted text on card', dark.muted, dark.card],
    ['dark: muted text on grey panels', dark.muted, dark.secondary],
    ['dark: eyebrow on card', hex(value('.dark .eyebrow', 'color')), dark.card],
    ['dark: eyebrow on panels', hex(value('.dark .eyebrow', 'color')), dark.secondary],
    [
      'dark: placeholder',
      hex(value('.dark ::placeholder,\n.dark .md .is-editor-empty:first-child::before', 'color')),
      dark.card,
    ],
  ];
  it.each(text)('%s is at least 4.5:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  const lightField = hex(
    value(
      "input:not([type='checkbox'], [type='radio'], [type='color'], [type='range']),\nselect,\ntextarea,\n.md-frame",
      'border-color',
    ),
  );
  const darkField = hex(
    value(
      ".dark input:not([type='checkbox'], [type='radio'], [type='color'], [type='range']),\n.dark select,\n.dark textarea,\n.dark .md-frame",
      'border-color',
    ),
  );
  const ui: [string, string, string][] = [
    ['field border on card', lightField, light.card],
    ['field border on page', lightField, light.bg],
    ['dark: field border on card', darkField, dark.card],
    ['dark: field border on page', darkField, dark.bg],
    ['selected tab underline', hex(token('accent')), light.bg],
    ['selected chip', NAVY, light.card],
  ];
  it.each(ui)('%s is at least 3:1', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
  });
});
