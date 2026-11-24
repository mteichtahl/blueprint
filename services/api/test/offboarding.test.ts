import { describe, expect, it } from 'vitest';
import {
  archivedObjectKey,
  chatAction,
  countItems,
  DeleteBody,
  fileIdOf,
  isLiveObject,
  mentionFor,
  nameMatches,
  nextStep,
  publicDeletion,
  retainUntil,
  STEPS,
  upcomingGigs,
  without,
  type DeletionRecord,
} from '../src/offboarding/model.ts';
import { adminRefusal } from '../src/offboarding/routes.ts';

const A = 'art_abcdefghij123456';
const B = 'art_zyxwvutsrq654321';

describe('deleting an artist: the request', () => {
  it('needs a reason and takes the defaults for the boxes', () => {
    const body = DeleteBody.parse({ confirmName: 'Chloe Poli', reason: 'left' });
    expect(body.emailArtist).toBe(false);
    expect(body.acknowledgeUpcoming).toBe(false);
    expect(DeleteBody.safeParse({ confirmName: 'x', reason: 'bored' }).success).toBe(false);
    expect(DeleteBody.safeParse({ confirmName: 'x', reason: 'left', force: true }).success).toBe(
      false,
    );
  });

  it('matches the typed name ignoring case and spaces, but not a different name', () => {
    expect(nameMatches('  chloe   POLI ', 'Chloe Poli')).toBe(true);
    expect(nameMatches('Chloe', 'Chloe Poli')).toBe(false);
    expect(nameMatches('', '')).toBe(false);
  });
});

describe('the steps', () => {
  it('run in order and stop at done', () => {
    expect(STEPS[0]).toBe('ai');
    expect(nextStep('ai')).toBe('archive');
    expect(nextStep('login')).toBe('done');
    expect(nextStep('done')).toBe('done');
  });
});

describe('counts and blockers', () => {
  it('counts items by kind', () => {
    const c = countItems(
      [
        'PROFILE',
        'PLAN',
        'FILE#a',
        'FILE#b',
        'TODO#1',
        'TODOC#1#x',
        'GIG#g',
        'SUB#s',
        'MEETING#m',
        'KB',
      ],
      3,
    );
    expect(c).toMatchObject({
      files: 2,
      plan: 1,
      todos: 1,
      gigs: 1,
      submissions: 1,
      meetings: 1,
      chats: 3,
    });
  });

  it('finds gigs on in the next 7 days, not cancelled ones or ideas', () => {
    const now = new Date('2026-11-24T00:00:00Z');
    const gigs = upcomingGigs(
      [
        { gigId: '1', title: 'Corner Hotel', date: '2026-11-28', status: 'confirmed' },
        { gigId: '2', title: 'Old', date: '2026-11-01', status: 'confirmed' },
        { gigId: '3', title: 'Far', date: '2026-12-20', status: 'confirmed' },
        { gigId: '4', title: 'Off', date: '2026-11-25', status: 'cancelled' },
        { gigId: '5', title: 'Maybe', date: '2026-11-26', status: 'idea' },
      ],
      now,
    );
    expect(gigs.map((g) => g.gigId)).toEqual(['1']);
  });
});

describe('the archive', () => {
  it('lives in the artist’s own prefix and leaves earlier archives alone', () => {
    expect(isLiveObject(A, `artists/${A}/files/abcdefghij`)).toBe(true);
    expect(isLiveObject(A, `artists/${A}/archive/x/files/abcdefghij`)).toBe(false);
    expect(isLiveObject(A, `artists/${B}/files/abcdefghij`)).toBe(false);
    expect(archivedObjectKey(A, 'd1', `artists/${A}/files/abcdefghij.v2`)).toBe(
      `artists/${A}/archive/d1/files/files/abcdefghij.v2`,
    );
  });

  it('knows which file an object belongs to, so private copies stay private', () => {
    expect(fileIdOf(A, `artists/${A}/files/abcdefghij.v2`)).toBe('abcdefghij');
    expect(fileIdOf(A, `artists/${A}/files/abcdefghij.thumb.webp`)).toBe('abcdefghij');
    expect(fileIdOf(A, `artists/${A}/meetings/x`)).toBeUndefined();
  });

  it('is kept 7 years', () => {
    expect(retainUntil(new Date('2026-11-24T00:00:00Z'))).toBe('2033-11-24');
  });
});

describe('chats', () => {
  it('archives and removes their chat with Blueprint', () => {
    expect(chatAction(A, `dm-${A}`, 'bmg-artist')).toBe('archive-remove');
  });
  it('closes a private chat with another artist, read-only for them', () => {
    expect(chatAction(A, `aa-${A}-${B}`, 'artist-to-artist')).toBe('archive-close');
  });
  it('takes them out of groups and announcements', () => {
    expect(chatAction(A, 'grp-abcdefghij', 'group')).toBe('leave');
    expect(chatAction(A, 'ann-abcdefghij', 'announcement')).toBe('leave');
  });
  it('leaves the all-artists broadcast and other people’s chats alone', () => {
    expect(chatAction(A, 'broadcast', 'broadcast')).toBe('skip');
    expect(chatAction(A, `dm-${B}`, 'bmg-artist')).toBe('skip');
  });
  it('removes an id from a list once', () => {
    expect(without([A, B], A)).toEqual({ list: [B], changed: true });
    expect(without([B], A)).toEqual({ list: [B], changed: false });
    expect(without(undefined, A)).toEqual({ list: [], changed: false });
  });
});

describe('mentions in Blueprint’s library', () => {
  it('flags documents named after them, or shared with them', () => {
    expect(mentionFor({ fileId: 'f1', name: 'Chloe Poli EPK.pdf' }, A, ['Chloe Poli'])?.why).toBe(
      'name',
    );
    expect(
      mentionFor({ fileId: 'f2', name: 'Rider.pdf', sharedWithArtistIds: [A] }, A, ['Chloe'])?.why,
    ).toBe('shared');
    expect(mentionFor({ fileId: 'f3', name: 'Rider.pdf' }, A, ['Chloe Poli'])).toBeUndefined();
  });
  it('ignores names too short to mean anything', () => {
    expect(mentionFor({ fileId: 'f4', name: 'Jo plan.pdf' }, A, ['Jo'])).toBeUndefined();
  });
});

describe('what admins see', () => {
  it('never includes the email or the archive bucket', () => {
    const rec: DeletionRecord = {
      artistId: A,
      deletionId: '20261124-abcd1234',
      displayName: 'Chloe Poli',
      names: ['Chloe Poli'],
      reason: 'left',
      emailArtist: false,
      email: 'chloe@example.com',
      by: 'sub',
      byName: 'Kyra',
      startedAt: '2026-11-24T00:00:00Z',
      status: 'running',
      step: 'archive',
      stepsDone: ['ai'],
      counts: {
        files: 1,
        chats: 1,
        plan: 1,
        todos: 0,
        gigs: 0,
        submissions: 0,
        meetings: 0,
        other: 0,
      },
      archive: { bucket: 'b', prefix: 'p/', objects: 1, bytes: 10, items: 4 },
      mentions: [],
    };
    const shown = publicDeletion(rec);
    expect(JSON.stringify(shown)).not.toContain('chloe@example.com');
    expect(shown.archive).not.toHaveProperty('bucket');
    expect(shown).toMatchObject({
      stepNumber: 2,
      stepCount: STEPS.length,
      reasonLabel: 'Left Blueprint',
    });
  });
});

describe('who may delete (fix: admins were always refused)', () => {
  const admin = (secondsSinceAuth: number) => ({
    sub: 's',
    role: 'bmg-admin' as const,
    mfaSatisfied: true,
    secondsSinceAuth,
  });
  it('lets an admin look at any time, and act only after a recent sign-in', () => {
    expect(adminRefusal(admin(3600), false)).toBeNull();
    expect(adminRefusal(admin(60), true)).toBeNull();
    // The step-up wording is what makes the app offer "Sign in again".
    expect(adminRefusal(admin(3600), true)).toMatch(/fresh step-up/);
  });
  it('refuses staff and artists either way', () => {
    const staff = { ...admin(10), role: 'bmg-staff' as const };
    expect(adminRefusal(staff, false)).toMatch(/Only a Blueprint admin/);
    expect(adminRefusal(staff, true)).toMatch(/Only a Blueprint admin/);
  });
});
