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

describe('artist ids in actions', () => {
  it('accepts real artist ids (art_ + 16), not only short test ids', async () => {
    const { Action } = await import('../src/actions.ts');
    const ok = (artistId: string) =>
      Action.safeParse({ type: 'createTodo', summary: 'Add a to-do', artistId, title: 'x' })
        .success;
    expect(ok('art_k3v9q2m7x1p8z4wa')).toBe(true);
    expect(ok('art_aaaaaaaaaaaa')).toBe(true);
    expect(ok('art_short')).toBe(false);
  });
});

describe('messaging a teammate (rev 14)', () => {
  it('takes a team member sub, and nothing that isn’t one', async () => {
    const { Action } = await import('../src/actions.ts');
    const ok = (staffSub: string) =>
      Action.safeParse({ type: 'sendMessage', summary: 'Message Sam', text: 'Hi', staffSub })
        .success;
    expect(ok('22222222-2222-4222-8222-222222222222')).toBe(true);
    expect(ok('art_aaaaaaaaaaaa')).toBe(false);
    expect(ok('sam')).toBe(false);
  });
});
