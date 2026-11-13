import { describe, expect, it } from 'vitest';
import { QUICK_REACTIONS, toggleReaction } from '../src/pages/Messages.tsx';

describe('quick reactions in chat (rev 14)', () => {
  it('offers thumbs up, thumbs down, smile and sad, in that order', () => {
    expect(QUICK_REACTIONS.map((q) => q.emoji)).toEqual(['👍', '👎', '😊', '😢']);
  });

  it('adds my reaction', () => {
    const { next, send } = toggleReaction([], '👍');
    expect(send).toBe('👍');
    expect(next).toEqual([{ emoji: '👍', count: 1, mine: true, names: ['You'] }]);
  });

  it('takes it off when I tap the same one again', () => {
    const { next, send } = toggleReaction(
      [{ emoji: '👍', count: 2, mine: true, names: ['Kyra', 'You'] }],
      '👍',
    );
    expect(send).toBeNull();
    expect(next).toEqual([{ emoji: '👍', count: 1, mine: false, names: ['Kyra'] }]);
  });

  it('swaps to a different one (one reaction per person)', () => {
    const { next, send } = toggleReaction(
      [
        { emoji: '👍', count: 1, mine: true, names: ['You'] },
        { emoji: '😢', count: 1, mine: false, names: ['Chloe'] },
      ],
      '😊',
    );
    expect(send).toBe('😊');
    expect(next).toEqual([
      { emoji: '😊', count: 1, mine: true, names: ['You'] },
      { emoji: '😢', count: 1, mine: false, names: ['Chloe'] },
    ]);
  });
});
