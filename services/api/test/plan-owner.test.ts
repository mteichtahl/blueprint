import { describe, expect, it } from 'vitest';
import type { Person } from '../src/files/people.ts';
import { PlanBody } from '../src/workspace/model.ts';
import {
  canOwnPlan,
  movesWithOwner,
  ownerCandidates,
  ownerChangeLine,
  ownerStatus,
} from '../src/workspace/plan-owner.ts';

const CHLOE = 'art_chloe00000001';
const SARUN = 'art_sarun00000001';
const sub = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const kyra: Person = { sub: sub(1), role: 'bmg-admin', displayName: 'Kyra', jobTitle: 'Founder' };
const sam: Person = {
  sub: sub(2),
  role: 'bmg-staff',
  assignedArtistIds: [CHLOE],
  displayName: 'Sam',
  jobTitle: 'Artist manager',
};
const alex: Person = {
  sub: sub(3),
  role: 'bmg-staff',
  assignedArtistIds: [SARUN],
  displayName: 'Alex',
  jobTitle: '',
};
const chloe: Person = {
  sub: sub(4),
  role: 'artist',
  artistId: CHLOE,
  displayName: 'Chloe Poli',
  jobTitle: 'Artist',
};
const everyone = [chloe, sam, alex, kyra];

describe('who can own a plan (rev 12)', () => {
  it('admins, and staff assigned to the artist', () => {
    expect(canOwnPlan(kyra, CHLOE)).toBe(true);
    expect(canOwnPlan(sam, CHLOE)).toBe(true);
    expect(canOwnPlan(alex, CHLOE)).toBe(false);
  });
  it('never an artist, or someone who has left', () => {
    expect(canOwnPlan(chloe, CHLOE)).toBe(false);
    expect(canOwnPlan(undefined, CHLOE)).toBe(false);
  });
  it('offers only those people, by name', () => {
    expect(ownerCandidates(everyone, CHLOE).map((p) => p.displayName)).toEqual(['Kyra', 'Sam']);
    expect(ownerCandidates(everyone, SARUN).map((p) => p.displayName)).toEqual(['Alex', 'Kyra']);
  });
});

describe('plan owner status', () => {
  it('shows the owner by name and job title', () => {
    expect(ownerStatus(sam.sub, everyone, CHLOE)).toEqual({
      owner: { sub: sam.sub, displayName: 'Sam', jobTitle: 'Artist manager' },
      ownerNeeded: false,
    });
  });
  it('needs an owner when there is none, or the owner left or was unassigned', () => {
    expect(ownerStatus(undefined, everyone, CHLOE)).toEqual({ owner: null, ownerNeeded: true });
    expect(ownerStatus(sub(99), everyone, CHLOE)).toEqual({ owner: null, ownerNeeded: true });
    expect(ownerStatus(alex.sub, everyone, CHLOE).ownerNeeded).toBe(true);
  });
});

describe('to-dos that move with the plan', () => {
  it("moves the previous owner's open to-dos and unlooked-after ones", () => {
    expect(movesWithOwner({ done: false, bmgOwnerSub: sam.sub }, sam.sub)).toBe(true);
    expect(movesWithOwner({ done: false }, sam.sub)).toBe(true);
    expect(movesWithOwner({ done: false }, undefined)).toBe(true);
  });
  it('leaves done to-dos, and ones someone else looks after', () => {
    expect(movesWithOwner({ done: true, bmgOwnerSub: sam.sub }, sam.sub)).toBe(false);
    expect(movesWithOwner({ done: false, bmgOwnerSub: kyra.sub }, sam.sub)).toBe(false);
  });
});

describe('owner change in the history', () => {
  it('says who handed over to whom, without counting to-dos (artists read it)', () => {
    expect(ownerChangeLine('Kyra', 'Sam')).toBe('Changed the plan owner from Kyra to Sam');
    expect(ownerChangeLine(undefined, 'Sam')).toBe('Set the plan owner to Sam');
  });
});

describe('plan body', () => {
  const plan = {
    outcome: '',
    measures: [],
    phases: [{ id: 'p1', name: 'Release', goal: '', milestones: [] }],
    version: 0,
  };
  it('takes an owner and a handover note', () => {
    const parsed = PlanBody.parse({ ...plan, ownerSub: sam.sub, handoverNote: ' Over to you ' });
    expect(parsed.ownerSub).toBe(sam.sub);
    expect(parsed.handoverNote).toBe('Over to you');
  });
  it('refuses an owner that is not a person id, and long notes', () => {
    expect(PlanBody.safeParse({ ...plan, ownerSub: 'kyra' }).success).toBe(false);
    expect(PlanBody.safeParse({ ...plan, handoverNote: 'x'.repeat(501) }).success).toBe(false);
  });
});
