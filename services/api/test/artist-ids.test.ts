import { newArtistId } from '@bmg/crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * Regression: AI state, knowledge-base provisioning and AI actions checked
 * for exactly 12 characters after `art_`, but real ids have 16, so no real
 * artist's AI choice was ever recorded. Tests here use real-length ids.
 */
const sent: unknown[] = [];
vi.mock('../src/lib.ts', () => ({
  db: { send: async (c: unknown) => void sent.push(c) },
  env: (n: string) => (n === 'MAIN_TABLE' ? 'main' : n),
}));

describe('real artist ids', () => {
  it('records the AI choice for a real-length artist id', async () => {
    const { projectAiState } = await import('../src/ai/state.ts');
    const id = newArtistId();
    expect(id).toMatch(/^art_[a-z0-9]{16}$/);
    await projectAiState(id, true, '2026-11-10T00:00:00.000Z');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain(`ARTIST#${id}`);
  });

  it('still ignores anything that is not an artist id', async () => {
    const { projectAiState } = await import('../src/ai/state.ts');
    sent.length = 0;
    await projectAiState('bmg', true, '2026-11-10T00:00:00.000Z');
    expect(sent).toHaveLength(0);
  });
});
