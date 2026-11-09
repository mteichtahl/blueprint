import { describe, expect, it } from 'vitest';
import { PROMPTS, render, unknownVariables } from '../src/index.ts';

describe('prompts', () => {
  it('every default only uses the variables its feature supplies', () => {
    for (const p of PROMPTS) expect(unknownVariables(p.defaultText, p.variables), p.id).toEqual([]);
  });

  it('ids are unique', () => {
    expect(new Set(PROMPTS.map((p) => p.id)).size).toBe(PROMPTS.length);
  });

  it('flags variables a feature does not supply', () => {
    expect(unknownVariables('Hi {{artistName}}, {{ secret }} {{artistName}}', ['today'])).toEqual([
      'artistName',
      'secret',
    ]);
  });

  it('fills in variables and blanks unknown ones', () => {
    expect(render('Hi {{ name }}{{x}}!', { name: 'Chloe' })).toBe('Hi Chloe!');
  });
});
