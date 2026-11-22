import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok, subOf } from '../src/api.ts';

/** UAT script C: plan editing, history and the plan owner (rev 12), through the API. */

interface Phase {
  id: string;
  name: string;
  goal: string;
  milestones: { id: string; title: string; done: boolean; measures: string[] }[];
}
interface PlanView {
  plan: {
    outcome: string;
    measures: { id: string; label: string }[];
    phases: Phase[];
    version: number;
  };
  exists: boolean;
  owner: { sub: string } | null;
  ownerNeeded: boolean;
}

test.describe.configure({ mode: 'serial' });

let artistId: string;
let adminSub: string;

test.beforeAll(async () => {
  artistId = await artistIdOf('artistOn');
  adminSub = await subOf('admin');
});

const getPlan = () => ok<PlanView>('admin', 'GET', `/artists/${artistId}/plan`);
const body = (
  v: PlanView,
  changes: Partial<PlanView['plan']> & { ownerSub?: string; handoverNote?: string },
) => ({
  outcome: v.plan.outcome,
  measures: v.plan.measures,
  phases: v.plan.phases,
  version: v.plan.version,
  ...changes,
});

test('C-03: the test artist has a plan with a Blueprint owner', async () => {
  let v = await getPlan();
  if (!v.exists || v.ownerNeeded) {
    await ok('admin', 'PUT', `/artists/${artistId}/plan`, body(v, { ownerSub: adminSub }));
    v = await getPlan();
  }
  expect(v.exists).toBe(true);
  expect(v.owner).not.toBeNull();
  expect(v.ownerNeeded).toBe(false);
});

test('C-05, C-14: editing the outcome saves and is recorded in History', async () => {
  const before = await ok<{ changes: unknown[] }>(
    'admin',
    'GET',
    `/artists/${artistId}/plan/history`,
  );
  const v = await getPlan();
  const outcome = `E2E test outcome. ${tag('saved')}`;
  const saved = await ok<{ version: number }>(
    'admin',
    'PUT',
    `/artists/${artistId}/plan`,
    body(v, { outcome }),
  );
  expect(saved.version).toBe(v.plan.version + 1);
  expect((await getPlan()).plan.outcome).toBe(outcome);

  const after = await ok<{ changes: unknown[] }>(
    'admin',
    'GET',
    `/artists/${artistId}/plan/history`,
  );
  expect(after.changes.length).toBeGreaterThan(before.changes.length);
  // The artist sees the same history.
  const theirs = await ok<{ changes: unknown[] }>(
    'artistOn',
    'GET',
    `/artists/${artistId}/plan/history`,
  );
  expect(theirs.changes.length).toBe(after.changes.length);
});

test('C-09: a stage can be added and removed', async () => {
  const v = await getPlan();
  const extra: Phase = { id: `e2e${Date.now()}`, name: 'E2E stage', goal: '', milestones: [] };
  await ok(
    'admin',
    'PUT',
    `/artists/${artistId}/plan`,
    body(v, { phases: [...v.plan.phases, extra] }),
  );
  const added = await getPlan();
  expect(added.plan.phases.map((p) => p.id)).toContain(extra.id);
  await ok(
    'admin',
    'PUT',
    `/artists/${artistId}/plan`,
    body(added, { phases: added.plan.phases.filter((p) => p.id !== extra.id) }),
  );
  expect((await getPlan()).plan.phases.map((p) => p.id)).not.toContain(extra.id);
});

test('C-10: a plan can’t be left without stages', async () => {
  const v = await getPlan();
  // Sent with an old version too, so even a broken rule couldn't save an empty plan.
  const empty = body(v, { phases: [], version: v.plan.version - 1 });
  expect((await call('admin', 'PUT', `/artists/${artistId}/plan`, empty)).status).toBe(400);
  expect((await getPlan()).plan.phases.length).toBeGreaterThan(0);
});

test('C-11: ticking a milestone done is saved and shows for the artist', async () => {
  const v = await getPlan();
  const milestone = { id: `m${Date.now()}`, title: tag('milestone'), done: false, measures: [] };
  const stage: Phase = {
    id: `e2e${Date.now()}`,
    name: 'E2E stage',
    goal: '',
    milestones: [milestone],
  };
  await ok(
    'admin',
    'PUT',
    `/artists/${artistId}/plan`,
    body(v, { phases: [...v.plan.phases, stage] }),
  );
  try {
    const added = await getPlan();
    const ticked = added.plan.phases.map((p) =>
      p.id === stage.id ? { ...p, milestones: p.milestones.map((m) => ({ ...m, done: true })) } : p,
    );
    await ok('admin', 'PUT', `/artists/${artistId}/plan`, body(added, { phases: ticked }));
    const theirs = await ok<{ plan: PlanView['plan'] }>(
      'artistOn',
      'GET',
      `/artists/${artistId}/plan`,
    );
    const m = theirs.plan.phases.find((p) => p.id === stage.id)?.milestones[0];
    expect(m?.done).toBe(true);
  } finally {
    const now = await getPlan();
    await ok(
      'admin',
      'PUT',
      `/artists/${artistId}/plan`,
      body(now, { phases: now.plan.phases.filter((p) => p.id !== stage.id) }),
    );
  }
});

test('C-02: an artist with no plan shows only "Start a new plan"', async () => {
  const { artists } = await ok<{ artists: { artistId: string; hasPlan: boolean }[] }>(
    'admin',
    'GET',
    '/artists',
  );
  const e2e = [await artistIdOf('artistOff'), await artistIdOf('artistOther')];
  const none = artists.find((a) => e2e.includes(a.artistId) && !a.hasPlan);
  test.skip(!none, 'Both other test artists have a plan');
  const v = await ok<PlanView>('admin', 'GET', `/artists/${none!.artistId}/plan`);
  expect(v.exists).toBe(false);
  expect(v.owner).toBeNull();
});

test('Q-07: Artists & access shows terms, AI status and the plan owner', async () => {
  const { artists } = await ok<{
    artists: {
      artistId: string;
      termsAcceptedAt: string | null;
      aiOptIn: boolean | null;
      hasPlan: boolean;
      planOwner: { sub: string } | null;
      planOwnerNeeded: boolean;
    }[];
  }>('admin', 'GET', '/artists');
  const row = artists.find((a) => a.artistId === artistId);
  expect(row?.termsAcceptedAt).toBeTruthy();
  expect(row?.aiOptIn).toBe(true);
  expect(row?.hasPlan).toBe(true);
  expect(row?.planOwner?.sub).toBe(adminSub);
  expect(row?.planOwnerNeeded).toBe(false);
});

test('a stale save is refused, not lost', async () => {
  const v = await getPlan();
  const stale = body(v, { version: v.plan.version - 1, outcome: 'stale' });
  expect((await call('admin', 'PUT', `/artists/${artistId}/plan`, stale)).status).toBe(409);
});

test('C-15 to C-18: changing the owner hands the plan over, and back', async () => {
  const staffSub = await subOf('staff');
  const v = await getPlan();
  const res = await ok<{ owner: { sub: string } }>(
    'admin',
    'PUT',
    `/artists/${artistId}/plan`,
    body(v, { ownerSub: staffSub, handoverNote: tag('handover') }),
  );
  expect(res.owner.sub).toBe(staffSub);
  expect((await getPlan()).owner?.sub).toBe(staffSub);

  // Back to the admin, so the next run starts the same way.
  const now = await getPlan();
  const back = await ok<{ owner: { sub: string } }>(
    'admin',
    'PUT',
    `/artists/${artistId}/plan`,
    body(now, { ownerSub: adminSub }),
  );
  expect(back.owner.sub).toBe(adminSub);
});

test('O-11: an owner taken off the artist leaves the plan needing an owner', async () => {
  const staffSub = await subOf('staff');
  const team = (assigned: string[]) =>
    ok('admin', 'PATCH', `/access/team/${staffSub}`, { artistIds: assigned });
  const v = await getPlan();
  await ok('admin', 'PUT', `/artists/${artistId}/plan`, body(v, { ownerSub: staffSub }));
  try {
    // E2E Staff is assigned to this artist only; take that away while they own the plan.
    await team([]);
    const needs = await getPlan();
    expect(needs.ownerNeeded).toBe(true);
    // A save that doesn't choose a new owner is refused until someone does.
    const res = await call('admin', 'PUT', `/artists/${artistId}/plan`, body(needs, {}));
    expect(res.status).toBe(400);
  } finally {
    await team([artistId]);
    const now = await getPlan();
    await ok('admin', 'PUT', `/artists/${artistId}/plan`, body(now, { ownerSub: adminSub }));
  }
  expect((await getPlan()).owner?.sub).toBe(adminSub);
});
