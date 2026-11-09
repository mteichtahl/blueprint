import { describe, expect, it } from 'vitest';
import { temporaryPassword } from '../src/handlers/artists.ts';

describe('temporaryPassword', () => {
  it('meets the Cognito password policy', () => {
    for (let i = 0; i < 200; i++) {
      const p = temporaryPassword();
      expect(p).toHaveLength(16);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#%*\-_+=?]/);
      expect(p).not.toMatch(/[<>&"']/);
    }
  });
});
