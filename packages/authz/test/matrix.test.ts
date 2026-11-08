import { describe, expect, it } from 'vitest';
import { authorize, type Action, type Principal, type Resource } from '../src/index.ts';

/**
 * The authorisation matrix (design 6.3), written out row by row. The Phase 2
 * gate is "the authz matrix passes": every row here must hold.
 */

const A = 'art_aaaaaaaaaaaa';
const B = 'art_bbbbbbbbbbbb';
const fresh = { mfaSatisfied: true, secondsSinceAuth: 60 };

const admin: Principal = { sub: 'u-admin', role: 'bmg-admin', ...fresh };
const staleAdmin: Principal = { ...admin, secondsSinceAuth: 3600 };
const staffA: Principal = { sub: 'u-staff', role: 'bmg-staff', assignedArtistIds: [A], ...fresh };
const artistA: Principal = { sub: 'u-a', role: 'artist', artistId: A, ...fresh };
const artistB: Principal = { sub: 'u-b', role: 'artist', artistId: B, ...fresh };
const federatedNoStepUp: Principal = { ...artistA, mfaSatisfied: false };

const dataA = (visibility: 'normal' | 'bmg-only' | 'private' = 'normal'): Resource => ({
  kind: 'artist-data',
  artistId: A,
  visibility,
});
const dataB: Resource = { kind: 'artist-data', artistId: B, visibility: 'normal' };
const sharedToB: Resource = {
  kind: 'artist-data',
  artistId: A,
  visibility: 'normal',
  sharedWithArtistIds: [B],
};
const library: Resource = { kind: 'org-shared', visibility: 'normal' };
const bmgOnlyLibrary: Resource = { kind: 'org-shared', visibility: 'bmg-only' };
const settings: Resource = { kind: 'org-admin' };
const a2aChat: Resource = {
  kind: 'conversation',
  type: 'artist-to-artist',
  participantSubs: ['u-a', 'u-b'],
};
const bmgChat: Resource = {
  kind: 'conversation',
  type: 'bmg-artist',
  participantSubs: ['u-staff', 'u-a'],
};
const signup: Resource = { kind: 'public' };

type Row = [string, Principal | undefined, Action, Resource, boolean];

const matrix: Row[] = [
  // BMG Admin: everything across artists, except artist-to-artist chats and private items.
  ['admin reads an artist workspace', admin, 'read', dataA(), true],
  ['admin reads a BMG-only item', admin, 'read', dataA('bmg-only'), true],
  ['admin cannot read a private item', admin, 'read', dataA('private'), false],
  ['admin manages settings', admin, 'write', settings, true],
  ['admin cannot read artist-to-artist chats', admin, 'read', a2aChat, false],
  ['admin reads BMG-artist chats', admin, 'read', bmgChat, true],
  ['admin invites with a fresh step-up', admin, 'admin', dataA(), true],
  ['admin action refused without a fresh step-up', staleAdmin, 'admin', settings, false],

  // BMG Staff: assigned artists, shared library, events, newsroom.
  ['staff read an assigned artist', staffA, 'read', dataA(), true],
  ['staff write to an assigned artist', staffA, 'write', dataA(), true],
  ['staff cannot read an unassigned artist', staffA, 'read', dataB, false],
  ['staff cannot read private items', staffA, 'read', dataA('private'), false],
  ['staff read the shared library', staffA, 'read', library, true],
  ['staff cannot open settings or billing', staffA, 'read', settings, false],
  ['staff cannot read artist-to-artist chats', staffA, 'read', a2aChat, false],
  ['staff cannot do admin actions', staffA, 'admin', dataA(), false],

  // Artist: own workspace, files shared with them, chats they're in, own stats.
  ['artist reads own workspace', artistA, 'read', dataA(), true],
  ['artist writes own workspace', artistA, 'write', dataA(), true],
  ['artist reads own private item', artistA, 'read', dataA('private'), true],
  ['artist cannot read BMG-only items', artistA, 'read', dataA('bmg-only'), false],
  ["artist cannot read another artist's workspace", artistA, 'read', dataB, false],
  ["artist cannot write another artist's workspace", artistB, 'write', dataA(), false],
  ['artist reads a file shared with them', artistB, 'read', sharedToB, true],
  ['artist cannot change a file shared with them', artistB, 'write', sharedToB, false],
  ['artist reads the shared library', artistA, 'read', library, true],
  ['artist cannot read BMG-only library items', artistA, 'read', bmgOnlyLibrary, false],
  ['artist cannot change the library', artistA, 'write', library, false],
  ['artist reads a chat they are in', artistA, 'read', a2aChat, true],
  ['artist cannot open settings', artistA, 'read', settings, false],
  ['artist cannot do admin actions', artistA, 'admin', dataA(), false],

  // Two-step verification and anonymous access.
  ['social sign-in without step-up is refused', federatedNoStepUp, 'read', dataA(), false],
  ['anonymous cannot read artist data', undefined, 'read', dataA(), false],
  ['anyone can use the newsletter sign-up', undefined, 'write', signup, true],
];

describe('authorisation matrix (design 6.3)', () => {
  it.each(matrix)('%s', (_name, principal, action, resource, expected) => {
    const decision = authorize(principal, action, resource);
    expect(decision.allow, decision.reason).toBe(expected);
  });

  it('always explains its decision', () => {
    for (const [, principal, action, resource] of matrix) {
      expect(authorize(principal, action, resource).reason.length).toBeGreaterThan(0);
    }
  });
});
