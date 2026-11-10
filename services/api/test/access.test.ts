import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  rulesFrom,
  SettingsBody,
  teamChangeRefused,
  TeamInvite,
  TeamPatch,
} from '../src/access/model.ts';
import { planConversation, sendRefused, type Viewer } from '../src/messages/model.ts';

const A = 'art_aaaaaaaaaaaaaaaa';
const B = 'art_bbbbbbbbbbbbbbbb';
const artistA: Viewer = { role: 'artist', artistId: A };
const admin: Viewer = { role: 'bmg-admin' };
const OFF = { artistDirectChats: false, artistGroups: false, artistGigSharing: false };
const ON = { artistDirectChats: true, artistGroups: true, artistGigSharing: true };

describe('access settings', () => {
  it('defaults to the canvas: artist chats on, artist groups off, gig sharing on', () => {
    expect(rulesFrom(undefined)).toEqual(DEFAULT_RULES);
    expect(DEFAULT_RULES).toEqual({
      artistDirectChats: true,
      artistGroups: false,
      artistGigSharing: true,
    });
    expect(rulesFrom({ artistGroups: true, artistDirectChats: 'yes' })).toEqual({
      ...DEFAULT_RULES,
      artistGroups: true,
    });
  });

  it('needs every switch and a version', () => {
    expect(SettingsBody.safeParse({ version: 0, ...ON }).success).toBe(true);
    expect(SettingsBody.safeParse({ ...ON }).success).toBe(false);
    expect(SettingsBody.safeParse({ version: 0, ...ON, extra: 1 }).success).toBe(false);
  });
});

describe('chats follow the switches', () => {
  it('artist ↔ artist chats need direct chats on', () => {
    expect(planConversation(artistA, { kind: 'direct', artistId: B }, ON).ok).toBe(true);
    const off = planConversation(artistA, { kind: 'direct', artistId: B }, OFF);
    expect(off).toEqual({ ok: false, reason: 'Blueprint has turned off chats between artists' });
    // Their chat with Blueprint is always allowed.
    expect(planConversation(artistA, { kind: 'direct' }, OFF).ok).toBe(true);
  });

  it('artists start groups only when allowed, and always join their own group', () => {
    const req = { kind: 'group' as const, title: 'Writers', artistIds: [B] };
    expect(planConversation(artistA, req, OFF).ok).toBe(false);
    const plan = planConversation(artistA, req, ON);
    expect(plan).toMatchObject({ ok: true, type: 'group', artistIds: [A, B].sort() });
    expect(planConversation(artistA, { ...req, artistIds: [A] }, ON).ok).toBe(false);
    // Announcements stay Blueprint's.
    expect(
      planConversation(artistA, { kind: 'announcement', title: 'x', artistIds: [B] }, ON).ok,
    ).toBe(false);
    // Blueprint is never bound by these switches.
    expect(planConversation(admin, req, OFF).ok).toBe(true);
  });

  it('turning artist chats off makes existing ones read-only for artists', () => {
    const pair = { type: 'artist-to-artist' as const, artistIds: [A, B] };
    expect(sendRefused(artistA, pair, undefined, ON)).toBeNull();
    expect(sendRefused(artistA, pair, undefined, OFF)).toMatch(/turned off chats/);
  });

  it('gig cards to other artists follow gig sharing', () => {
    const group = { type: 'group' as const, artistIds: [A, B] };
    const mine = { type: 'bmg-artist' as const, artistIds: [A] };
    const rules = { ...ON, artistGigSharing: false };
    expect(sendRefused(artistA, group, 'gig', rules)).toMatch(/sharing gigs/);
    expect(sendRefused(artistA, group, 'file', rules)).toBeNull();
    expect(sendRefused(artistA, mine, 'gig', rules)).toBeNull();
    expect(sendRefused(admin, group, 'gig', rules)).toBeNull();
  });
});

describe('Blueprint team', () => {
  const kyra = { sub: 'k', role: 'bmg-admin' as const, enabled: true };
  const sam = { sub: 's', role: 'bmg-staff' as const, enabled: true };

  it('validates invites and patches', () => {
    expect(
      TeamInvite.parse({ email: 'sam@example.com', displayName: 'Sam', role: 'bmg-staff' }),
    ).toMatchObject({ jobTitle: '', artistIds: [] });
    expect(TeamInvite.safeParse({ email: 'x@y.z', displayName: 'X', role: 'artist' }).success).toBe(
      false,
    );
    expect(TeamPatch.safeParse({}).success).toBe(false);
    expect(TeamPatch.parse({ artistIds: [B, A, B] }).artistIds).toEqual([A, B]);
  });

  it('never locks Blueprint out of its own app', () => {
    expect(teamChangeRefused('k', kyra, { enabled: false }, 2)).toMatch(/your own login/);
    expect(teamChangeRefused('k', kyra, { role: 'bmg-staff' }, 2)).toMatch(/your own role/);
    expect(teamChangeRefused('x', kyra, { role: 'bmg-staff' }, 1)).toMatch(/at least one admin/);
    expect(teamChangeRefused('x', kyra, { enabled: false }, 1)).toMatch(/at least one admin/);
    expect(teamChangeRefused('x', kyra, { enabled: false }, 2)).toBeNull();
    expect(teamChangeRefused('k', sam, { role: 'bmg-admin' }, 1)).toBeNull();
    expect(teamChangeRefused('k', kyra, { jobTitle: 'Founder' }, 1)).toBeNull();
  });
});
