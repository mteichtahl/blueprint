/** Rev 14: chat between Blueprint staff (team chats). */
import { describe, expect, it } from 'vitest';
import {
  access,
  adminsAfterLeaving,
  AddStaff,
  canAddMembers,
  canAddStaff,
  canRemoveStaff,
  canSend,
  channelsFor,
  CONVERSATION_ID_PATTERN,
  isStaffConversationId,
  members,
  NewConversation,
  planConversation,
  UpdateConversation,
  staffPairId,
  wrapContext,
  type Conversation,
  type Viewer,
} from '../src/messages/model.ts';

const KYRA = '11111111-1111-4111-8111-111111111111';
const SAM = '22222222-2222-4222-8222-222222222222';
const JO = '33333333-3333-4333-8333-333333333333';
const A = 'art_aaaaaaaaaaaa';

const kyra: Viewer = { role: 'bmg-admin', sub: KYRA };
const sam: Viewer = { role: 'bmg-staff', sub: SAM, assignedArtistIds: [A] };
const jo: Viewer = { role: 'bmg-staff', sub: JO };
const joAdmin: Viewer = { role: 'bmg-admin', sub: JO };
const artist: Viewer = { role: 'artist', artistId: A, sub: '44444444-4444-4444-8444-444444444444' };

type Conv = Pick<
  Conversation,
  'type' | 'artistIds' | 'staffSubs' | 'admins' | 'staffSettings' | 'settings'
>;
const direct: Conv = { type: 'staff-direct', artistIds: [], staffSubs: [KYRA, SAM].sort() };
const group: Conv = {
  type: 'staff-group',
  artistIds: [],
  staffSubs: [KYRA, SAM],
  admins: [KYRA],
};

describe('team chats: who can see them', () => {
  it('lets members read and write', () => {
    expect(access(kyra, direct)).toBe('read-write');
    expect(access(sam, direct)).toBe('read-write');
    expect(access(sam, group)).toBe('read-write');
  });
  it('keeps them private from staff who are not in them', () => {
    expect(access(jo, direct)).toBe('none');
    expect(access(jo, group)).toBe('none');
  });
  it('keeps them private from admins who are not in them', () => {
    expect(access(joAdmin, direct)).toBe('none');
    expect(access(joAdmin, group)).toBe('none');
  });
  it('never lets an artist in, even with a matching-looking sub', () => {
    expect(access(artist, direct)).toBe('none');
    expect(access({ ...artist, sub: KYRA }, direct)).toBe('none');
  });
  it('refuses a viewer with no sub', () => {
    expect(access({ role: 'bmg-admin' }, direct)).toBe('none');
  });
  it('is not affected by artist assignments', () => {
    expect(access({ role: 'bmg-staff', sub: SAM, assignedArtistIds: [] }, group)).toBe(
      'read-write',
    );
  });
});

describe('team chats: inboxes, channels and ids', () => {
  it('gives each member their own inbox and channel, never the shared Blueprint one', () => {
    expect(members(group)).toEqual([`STAFF#${KYRA}`, `STAFF#${SAM}`]);
    expect(channelsFor(group)).toEqual([`/inbox/staff-${KYRA}`, `/inbox/staff-${SAM}`]);
    expect(channelsFor(group)).not.toContain('/inbox/bmg');
    expect(members(group)).not.toContain('BMG');
  });
  it('gives two people the same chat whoever starts it', () => {
    expect(staffPairId(KYRA, SAM)).toBe(staffPairId(SAM, KYRA));
    expect(CONVERSATION_ID_PATTERN.test(staffPairId(KYRA, SAM))).toBe(true);
    expect(CONVERSATION_ID_PATTERN.test('sg-abcdefghij12')).toBe(true);
    expect(CONVERSATION_ID_PATTERN.test(`sd-${KYRA}`)).toBe(false);
    expect(isStaffConversationId(staffPairId(KYRA, SAM))).toBe(true);
    expect(isStaffConversationId(`dm-${A}`)).toBe(false);
  });
  it('wraps team keys with their own purpose', () => {
    expect(wrapContext('sd-x', undefined, 'staff-direct')).toEqual({
      purpose: 'staff-conversation',
      conversationId: 'sd-x',
    });
    expect(wrapContext('dm-x')).toEqual({ purpose: 'conversation-key', conversationId: 'dm-x' });
  });
});

describe('team chats: starting one', () => {
  it('starts a direct chat between two staff', () => {
    const plan = planConversation(sam, { kind: 'direct', staffSub: KYRA });
    expect(plan).toMatchObject({
      ok: true,
      type: 'staff-direct',
      conversationId: staffPairId(SAM, KYRA),
      artistIds: [],
      staffSubs: [KYRA, SAM].sort(),
    });
  });
  it('lets a staff member message themselves', () => {
    const plan = planConversation(sam, { kind: 'direct', staffSub: SAM });
    expect(plan).toMatchObject({ ok: true, type: 'staff-direct', staffSubs: [SAM] });
  });
  it('refuses artists', () => {
    expect(planConversation(artist, { kind: 'direct', staffSub: KYRA }).ok).toBe(false);
    expect(planConversation(artist, { kind: 'group', title: 'x', staffSubs: [KYRA, SAM] }).ok).toBe(
      false,
    );
  });
  it('makes a team group when only staff are picked, with the creator as admin', () => {
    const plan = planConversation(sam, { kind: 'group', title: 'Mixer crew', staffSubs: [JO] });
    expect(plan).toMatchObject({
      ok: true,
      type: 'staff-group',
      artistIds: [],
      staffSubs: [SAM, JO],
      admins: [SAM],
      title: 'Mixer crew',
    });
  });
  it('needs someone else in a team group', () => {
    expect(planConversation(sam, { kind: 'group', title: 'x', staffSubs: [SAM] }).ok).toBe(false);
  });
  it('keeps a normal group when artists are picked too', () => {
    const plan = planConversation(kyra, {
      kind: 'group',
      title: 'x',
      artistIds: [A],
      staffSubs: [SAM],
    });
    expect(plan).toMatchObject({ ok: true, type: 'group', artistIds: [A] });
  });
  it('validates requests', () => {
    expect(NewConversation.safeParse({ kind: 'direct', staffSub: 'not-a-sub' }).success).toBe(
      false,
    );
    expect(NewConversation.safeParse({ kind: 'direct', staffSub: KYRA, artistId: A }).success).toBe(
      false,
    );
    expect(NewConversation.safeParse({ kind: 'group', title: 'x' }).success).toBe(false);
    expect(AddStaff.safeParse({ staffSubs: [] }).success).toBe(false);
    expect(UpdateConversation.safeParse({ admin: { sub: SAM, admin: true } }).success).toBe(true);
    expect(UpdateConversation.safeParse({ admin: { sub: 'x', admin: true } }).success).toBe(false);
    expect(
      UpdateConversation.safeParse({
        staffSettings: { onlyAdminsSend: true, onlyAdminsEditInfo: false },
      }).success,
    ).toBe(true);
  });
});

describe('team groups: members and admins', () => {
  it('lets members send unless only admins can', () => {
    expect(canSend(sam, group)).toBe(true);
    const locked = { ...group, staffSettings: { onlyAdminsSend: true, onlyAdminsEditInfo: false } };
    expect(canSend(sam, locked)).toBe(false);
    expect(canSend(kyra, locked)).toBe(true);
  });
  it('lets members add staff unless only admins can edit group info', () => {
    expect(canAddStaff(sam, group)).toBe(true);
    const locked = { ...group, staffSettings: { onlyAdminsSend: false, onlyAdminsEditInfo: true } };
    expect(canAddStaff(sam, locked)).toBe(false);
    expect(canAddStaff(kyra, locked)).toBe(true);
    expect(canAddStaff(jo, group)).toBe(false);
  });
  it('never adds artists to a team group', () => {
    expect(canAddMembers(kyra, group)).toBe(false);
  });
  it('lets anyone leave, and admins remove others', () => {
    expect(canRemoveStaff(sam, group, SAM)).toBe(true);
    expect(canRemoveStaff(sam, group, KYRA)).toBe(false);
    expect(canRemoveStaff(kyra, group, SAM)).toBe(true);
    expect(canRemoveStaff(jo, group, JO)).toBe(false);
  });
  it('hands admin to the longest-standing member when the last admin leaves', () => {
    expect(adminsAfterLeaving({ staffSubs: [KYRA, SAM, JO], admins: [KYRA] }, KYRA)).toEqual({
      staffSubs: [SAM, JO],
      admins: [SAM],
    });
    expect(adminsAfterLeaving({ staffSubs: [KYRA, SAM], admins: [KYRA, SAM] }, KYRA)).toEqual({
      staffSubs: [SAM],
      admins: [SAM],
    });
  });
});
