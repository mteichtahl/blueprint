import { expect, test } from '@playwright/test';
import { tag } from '../src/accounts.ts';
import { artistIdOf, call, ok } from '../src/api.ts';
import { noticeFor } from '../src/helpers.ts';

/**
 * UAT script L (the parts that don't need a recording) and rev 18: meetings
 * are Blueprint's; artists only hear about and list the ones they were in,
 * see more only when Blueprint shares one, and nothing with AI off is
 * transcribed. No audio is uploaded, so nothing is transcribed or summarised.
 * Every meeting made here is deleted at the end.
 */

interface Meeting {
  meetingId: string;
  space: string;
  shared: boolean;
  status: string;
  canTranscribe: boolean;
  transcribeBlockedReason: string | null;
  canDelete: boolean;
}
interface Mine {
  meetingId: string;
  title: string;
  attended: boolean;
  aboutMe: boolean;
  shared: boolean;
  with: string[];
}

test.describe.configure({ mode: 'serial' });

let onId: string;
let offId: string;
let withChloe: Meeting;
let withOff: Meeting;
const title = tag('meeting with the artist');
const made: Meeting[] = [];
const at = (m: Meeting) => `/meetings/${m.space}/${m.meetingId}`;
const mine = async (as: 'artistOn' | 'artistOther') =>
  (await ok<{ meetings: Mine[] }>(as, 'GET', '/meetings/mine')).meetings;
const create = (body: Record<string, unknown>) =>
  call<{ meeting: Meeting }>('admin', 'POST', '/meetings/items', body);

test.beforeAll(async () => {
  onId = await artistIdOf('artistOn');
  offId = await artistIdOf('artistOff');
});

test('L-01: nothing is recorded without everyone’s consent', async () => {
  const res = await create({ title: tag('no consent'), artistId: onId });
  expect(res.status).toBe(400);
  const no = await create({ title: tag('no consent'), artistId: onId, consent: false });
  expect(no.status).toBe(400);
});

test('rev 18: an artist in a meeting is told, and sees it in My meetings', async () => {
  const since = new Date().toISOString();
  const res = await create({
    title,
    artistId: onId,
    consent: true,
    attendees: [
      { kind: 'artist', id: onId, name: 'E2E Artist (AI on)' },
      { kind: 'staff', id: 'e2e-admin', name: 'E2E Admin' },
    ],
  });
  expect(res.status).toBe(201);
  withChloe = res.data.meeting;
  made.push(withChloe);
  expect(withChloe.shared).toBe(false);
  await noticeFor('artistOn', title, since);
  const listed = (await mine('artistOn')).find((m) => m.meetingId === withChloe.meetingId);
  expect(listed?.attended).toBe(true);
  expect(listed?.shared).toBe(false);
  expect(listed?.with).toContain('E2E Admin');
  // Another artist doesn't see it.
  expect((await mine('artistOther')).some((m) => m.meetingId === withChloe.meetingId)).toBe(false);
});

test('L-12: artists can’t open meetings, only list the ones they were in', async () => {
  expect((await call('artistOn', 'GET', '/meetings/items')).status).toBe(403);
  expect((await call('artistOn', 'GET', at(withChloe))).status).toBe(403);
  expect((await call('artistOn', 'POST', '/meetings/items', { title, consent: true })).status).toBe(
    403,
  );
});

test('L-13, L-14: sharing shows it to the artist; stopping hides it again', async () => {
  await ok('admin', 'PATCH', at(withChloe), { shared: true });
  expect((await mine('artistOn')).find((m) => m.meetingId === withChloe.meetingId)?.shared).toBe(
    true,
  );
  await ok('admin', 'PATCH', at(withChloe), { shared: false });
  expect((await mine('artistOn')).find((m) => m.meetingId === withChloe.meetingId)?.shared).toBe(
    false,
  );
  // A Blueprint-only meeting can't be shared at all.
  const lib = await create({ title: tag('Blueprint only'), consent: true });
  expect(lib.status).toBe(201);
  made.push(lib.data.meeting);
  expect((await call('admin', 'PATCH', at(lib.data.meeting), { shared: true })).status).toBe(400);
  expect((await mine('artistOn')).some((m) => m.meetingId === lib.data.meeting.meetingId)).toBe(
    false,
  );
});

test('L-15: a meeting with an artist who has AI off is never transcribed', async () => {
  const res = await create({ title: tag('meeting, AI off'), artistId: offId, consent: true });
  expect(res.status).toBe(201);
  withOff = res.data.meeting;
  made.push(withOff);
  expect(withOff.canTranscribe).toBe(false);
  expect(withOff.transcribeBlockedReason).toBe('ai_opt_out');
  // Refused for AI before anything else is checked (there's no recording either).
  expect((await call('admin', 'POST', `${at(withOff)}/transcribe`)).status).toBe(403);
});

test('staff only open meetings for the artists they look after', async () => {
  // E2E Staff is assigned to E2E Artist (AI on) only.
  expect((await call('staff', 'GET', at(withChloe))).status).toBe(200);
  expect([403, 404]).toContain((await call('staff', 'GET', at(withOff))).status);
  const theirs = await ok<{ meetings: Meeting[] }>('staff', 'GET', '/meetings/items');
  expect(theirs.meetings.some((m) => m.meetingId === withOff.meetingId)).toBe(false);
});

test('L-16: only whoever recorded it, or an admin, deletes a meeting', async () => {
  expect((await call('staff', 'DELETE', at(withChloe))).status).toBe(403);
  await ok('admin', 'DELETE', at(withChloe));
  made.splice(made.indexOf(withChloe), 1);
  expect([403, 404]).toContain((await call('admin', 'GET', at(withChloe))).status);
  expect((await mine('artistOn')).some((m) => m.meetingId === withChloe.meetingId)).toBe(false);
});

test.afterAll(async () => {
  for (const m of made) await call('admin', 'DELETE', at(m));
});
