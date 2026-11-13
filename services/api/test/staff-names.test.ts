/** Artists see Blueprint people by name in their chats (decided 13 Nov 2026). */
import { describe, expect, it } from 'vitest';
import type { Person } from '../src/files/people.ts';
import { shownSender, staffLabel } from '../src/handlers/messages.ts';

const KYRA = '11111111-1111-4111-8111-111111111111';
const team = new Map<string, Person>([
  [KYRA, { sub: KYRA, role: 'bmg-admin', displayName: 'Kyra', jobTitle: 'Founder & Director' }],
]);
const fromKyra = { senderRole: 'bmg-admin' as const, senderSub: KYRA, senderName: 'Blueprint' };

describe('staff names in chats with artists', () => {
  it('labels a Blueprint person with their name and Blueprint', () => {
    expect(staffLabel('Kyra')).toBe('Kyra · Blueprint');
  });
  it('names older messages stored as "Blueprint" from the team list', () => {
    expect(shownSender({ type: 'bmg-artist' }, fromKyra, team)).toBe('Kyra · Blueprint');
    expect(shownSender({ type: 'group' }, fromKyra, team)).toBe('Kyra · Blueprint');
    expect(shownSender({ type: 'announcement' }, fromKyra, team)).toBe('Kyra · Blueprint');
  });
  it('keeps "Blueprint" for someone no longer on the team', () => {
    expect(shownSender({ type: 'bmg-artist' }, fromKyra, new Map())).toBe('Blueprint');
  });
  it('leaves artists, system notes and team chats as stored', () => {
    const artist = { senderRole: 'artist' as const, senderSub: 'x', senderName: 'Chloe Poli' };
    expect(shownSender({ type: 'bmg-artist' }, artist, team)).toBe('Chloe Poli');
    expect(shownSender({ type: 'group' }, { ...fromKyra, system: true }, team)).toBe('Blueprint');
    expect(shownSender({ type: 'staff-direct' }, { ...fromKyra, senderName: 'Kyra' }, team)).toBe(
      'Kyra',
    );
  });
});
