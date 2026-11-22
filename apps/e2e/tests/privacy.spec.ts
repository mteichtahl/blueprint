import { expect, test } from '@playwright/test';
import { account } from '../src/accounts.ts';
import {
  aiTool,
  answerMfa,
  artistIdOf,
  call,
  CognitoError,
  ok,
  startPasswordSignIn,
  subOf,
} from '../src/api.ts';
import { wrongCode } from '../src/totp.ts';

/**
 * The UAT "P" steps that the API decides: who can sign in, who can see whose
 * data, and what AI may touch. Checked straight against the API, so they hold
 * whatever any screen shows. None of these calls changes anything when the
 * rule holds; where a broken rule would write, the write repeats what is there.
 */

const denied = (status: number) => expect([403, 404], `status ${status}`).toContain(status);

test.describe('Sign-in', () => {
  test('A-10: a wrong 6-digit code is refused', async () => {
    const a = await account('artistOther');
    const first = await startPasswordSignIn(a.email, a.password);
    expect(first.ChallengeName).toBe('SOFTWARE_TOKEN_MFA');
    const err = await answerMfa(a.email, first.Session!, wrongCode(a.totpSecret)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CognitoError);
    expect((err as CognitoError).type).toBe('CodeMismatchException');
  });

  test('A-02: a password alone never signs in', async () => {
    const a = await account('artistOther');
    const first = await startPasswordSignIn(a.email, a.password);
    expect(first.AuthenticationResult).toBeUndefined();
  });

  test('the API refuses calls without a signed-in user', async () => {
    const res = await call(null, 'GET', '/me');
    expect([401, 403]).toContain(res.status);
  });
});

test.describe('Roles', () => {
  test('artists can’t reach Blueprint-only areas', async () => {
    for (const path of [
      '/access/team',
      '/ai/prompts',
      '/gigs',
      '/review-queue',
      '/events',
      '/insights',
    ]) {
      await test.step(path, async () => denied((await call('artistOn', 'GET', path)).status));
    }
    // A real refusal, not the 404 any request without the assistant's marker gets.
    expect((await aiTool('artistOn', '/ai/tools/artists')).status).toBe(403);
  });

  test('O-01, O-02: only an admin can change Access & permissions', async () => {
    const current = await ok<Record<string, unknown>>('admin', 'GET', '/access/settings');
    // The same values back, so a broken rule could only bump the version.
    const same = {
      artistDirectChats: current.artistDirectChats,
      artistGroups: current.artistGroups,
      artistGigSharing: current.artistGigSharing,
      version: current.version,
    };
    denied((await call('staff', 'PUT', '/access/settings', same)).status);
    denied((await call('artistOn', 'PUT', '/access/settings', same)).status);
    const after = await ok<Record<string, unknown>>('admin', 'GET', '/access/settings');
    expect(after.version).toBe(current.version);
  });

  test('C-20: artists see their plan but can’t edit it', async () => {
    const id = await artistIdOf('artistOn');
    const got = await ok<{ plan: Record<string, unknown> }>(
      'artistOn',
      'GET',
      `/artists/${id}/plan`,
    );
    const res = await call('artistOn', 'PUT', `/artists/${id}/plan`, got.plan);
    expect(res.status).toBe(403);
  });

  test('an artist’s roster holds only themselves', async () => {
    const id = await artistIdOf('artistOn');
    const { artists } = await ok<{ artists: { artistId: string }[] }>(
      'artistOn',
      'GET',
      '/artists',
    );
    expect(artists.map((a) => a.artistId)).toEqual([id]);
  });
});

test.describe('Staff see only the artists they look after', () => {
  // E2E Staff is assigned to E2E Artist (AI on) only.
  test('a team member’s roster and workspaces are their artists only', async () => {
    const on = await artistIdOf('artistOn');
    const off = await artistIdOf('artistOff');
    const { artists } = await ok<{ artists: { artistId: string }[] }>('staff', 'GET', '/artists');
    const ids = artists.map((a) => a.artistId);
    expect(ids).toContain(on);
    expect(ids).not.toContain(off);
    expect(ids).not.toContain(await artistIdOf('artistOther'));
    for (const path of [
      `/artists/${off}/plan`,
      `/artists/${off}/todos`,
      `/artists/${off}/gigs`,
      `/artists/${off}/files`,
      `/artists/${off}/folders`,
      `/artists/${off}/submissions`,
    ]) {
      await test.step(path, async () => denied((await call('staff', 'GET', path)).status));
    }
    const all = await ok<{ todos: { artistId: string }[] }>('staff', 'GET', '/todos');
    expect(all.todos.some((t) => t.artistId === off)).toBe(false);
  });

  test('the team list hides email addresses from non-admins, and artists can’t see it', async () => {
    const { team } = await ok<{ team: { email: string }[] }>('staff', 'GET', '/access/team');
    expect(team.length).toBeGreaterThan(0);
    expect(team.every((m) => m.email === '')).toBe(true);
    denied((await call('artistOn', 'GET', '/access/team')).status);
  });
});

test.describe('Admin-only settings', () => {
  // Each write is sent with a body the server would reject, so a broken rule
  // answers 400 and still changes nothing; a working one answers 403 first.

  test('O-01: team members read AI prompts but can’t publish them', async () => {
    const { prompts } = await ok<{ prompts: { id: string }[] }>('staff', 'GET', '/ai/prompts');
    expect(prompts.length).toBeGreaterThan(0);
    const res = await call('staff', 'POST', `/ai/prompts/${prompts[0]!.id}/publish`, { note: 5 });
    expect(res.status).toBe(403);
    denied((await call('artistOn', 'GET', '/ai/prompts')).status);
  });

  test('only an admin sets up connector apps', async () => {
    denied((await call('staff', 'GET', '/connectors/apps')).status);
    const res = await call('staff', 'PUT', '/connectors/apps/google', { clientId: '' });
    expect(res.status).toBe(403);
    denied((await call('artistOn', 'GET', '/connectors')).status);
  });

  test('the newsroom is Blueprint’s; only an admin changes its settings', async () => {
    expect((await call('staff', 'GET', '/newsroom')).status).toBe(200);
    denied((await call('artistOn', 'GET', '/newsroom')).status);
    const res = await call('staff', 'PUT', '/newsroom/settings', { lookFor: 5 });
    expect(res.status).toBe(403);
  });

  test('O-05: an admin changes a team member’s job title; a team member can’t', async () => {
    const staffSub = await subOf('staff');
    const title = async () =>
      (
        await ok<{ team: { sub: string; jobTitle: string }[] }>('admin', 'GET', '/access/team')
      ).team.find((m) => m.sub === staffSub)?.jobTitle ?? '';
    const before = await title();
    try {
      await ok('admin', 'PATCH', `/access/team/${staffSub}`, { jobTitle: 'E2E renamed by admin' });
      expect(await title()).toBe('E2E renamed by admin');
    } finally {
      await ok('admin', 'PATCH', `/access/team/${staffSub}`, { jobTitle: before });
    }
    const res = await call('staff', 'PATCH', `/access/team/${await subOf('admin')}`, {
      jobTitle: 5,
    });
    expect(res.status).toBe(403);
  });

  test('O-06: an admin can’t change their own role', async () => {
    // Refused before anything is written.
    const res = await call('admin', 'PATCH', `/access/team/${await subOf('admin')}`, {
      role: 'bmg-staff',
    });
    expect(res.status).toBe(409);
    expect((await ok<{ role: string }>('admin', 'GET', '/me')).role).toBe('bmg-admin');
  });

  test('P-01, P-06: an artist’s job title is always “Artist”; Blueprint sets their own', async () => {
    expect((await call('artistOn', 'PATCH', '/me', { jobTitle: 'Producer' })).status).toBe(403);
    expect((await ok<{ jobTitle: string }>('artistOn', 'GET', '/me')).jobTitle).toBe('Artist');
    const before = (await ok<{ jobTitle: string }>('staff', 'GET', '/me')).jobTitle;
    try {
      await ok('staff', 'PATCH', '/me', { jobTitle: 'E2E job title' });
      expect((await ok<{ jobTitle: string }>('staff', 'GET', '/me')).jobTitle).toBe(
        'E2E job title',
      );
    } finally {
      await ok('staff', 'PATCH', '/me', { jobTitle: before });
    }
  });
});

test.describe('Artists can’t see each other', () => {
  test('J-05, K-11: another artist’s workspace is closed', async () => {
    const other = await artistIdOf('artistOn');
    const paths = [
      `/artists/${other}`,
      `/artists/${other}/plan`,
      `/artists/${other}/plan/history`,
      `/artists/${other}/todos`,
      `/artists/${other}/gigs`,
      `/artists/${other}/files`,
      `/artists/${other}/folders`,
      `/artists/${other}/brand-kit`,
      `/artists/${other}/submissions`,
      `/artists/${other}/stats`,
    ];
    for (const path of paths) {
      await test.step(path, async () => denied((await call('artistOther', 'GET', path)).status));
    }
  });
});

test.describe('AI opt-out', () => {
  test('M-06: an opted-out artist can’t use the assistant', async () => {
    const res = await call('artistOff', 'POST', '/ai/chat', { message: 'Hello' });
    expect(res.status).toBe(403);
  });

  test('M-07: Blueprint’s assistant can’t see an opted-out artist', async () => {
    const off = await artistIdOf('artistOff');
    const on = await artistIdOf('artistOn');
    expect((await aiTool('admin', `/ai/tools/workspace?artistId=${off}`)).status).toBe(403);
    expect((await aiTool('admin', `/ai/tools/workspace?artistId=${on}`)).status).toBe(200);

    const res = await aiTool<{ artists: { artistId: string }[] }>('admin', '/ai/tools/artists');
    expect(res.status).toBe(200);
    const ids = res.data.artists.map((a) => a.artistId);
    expect(ids).toContain(on);
    expect(ids).not.toContain(off);
  });

  test('M-04: an artist’s assistant can’t read another artist', async () => {
    const other = await artistIdOf('artistOther');
    expect((await aiTool('artistOn', `/ai/tools/workspace?artistId=${other}`)).status).toBe(403);
  });

  test('A-14: Artists & access shows each artist’s AI choice', async () => {
    const { artists } = await ok<{ artists: { artistId: string; aiOptIn: boolean | null }[] }>(
      'admin',
      'GET',
      '/artists',
    );
    const byId = new Map(artists.map((a) => [a.artistId, a.aiOptIn]));
    expect(byId.get(await artistIdOf('artistOn'))).toBe(true);
    expect(byId.get(await artistIdOf('artistOff'))).toBe(false);
  });
});
