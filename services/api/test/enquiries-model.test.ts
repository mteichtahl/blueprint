import { describe, expect, it } from 'vitest';
import {
  applyAction,
  businessDaysWaiting,
  CLOSED_KEEP_SECONDS,
  CONVERTED_KEEP_SECONDS,
  counts,
  EnquiryBody,
  EnquiryPatch,
  isCountry,
  looksLikeABot,
  RuleError,
  summaryOf,
  type EnquiryAction,
  type EnquiryItem,
  type EnquiryStatus,
} from '../src/enquiries/model.ts';
import { nudgeFor } from '../src/live/model.ts';

/** Consultation requests (rev 21): the form's rules and the status rules. */

const form = {
  name: 'Mia Torres',
  email: 'Mia@Example.com ',
  country: 'au',
  aboutMe: 'Singer-songwriter in Brunswick.',
  howCanWeHelp: 'Planning my first EP.',
};

describe('the public form', () => {
  it('takes a filled-in form and tidies it', () => {
    const r = EnquiryBody.parse({ ...form, phone: '+61412345678' });
    expect(r).toMatchObject({ email: 'Mia@Example.com', country: 'AU', phone: '+61412345678' });
  });

  it('says what is missing, in words', () => {
    const r = EnquiryBody.safeParse({ ...form, name: ' ', email: 'nope', country: 'Australia' });
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toContain('Add your name.');
    expect(messages).toContain('Add an email we can reply to.');
    expect(messages).toContain('Choose your country.');
  });

  it('keeps the name to one line (it goes into email subjects)', () => {
    expect(EnquiryBody.safeParse({ ...form, name: 'Mia\r\nBcc: x@y.z' }).success).toBe(false);
  });

  it('keeps answers to 2,000 characters and needs both', () => {
    expect(EnquiryBody.safeParse({ ...form, aboutMe: 'x'.repeat(2001) }).success).toBe(false);
    expect(EnquiryBody.safeParse({ ...form, howCanWeHelp: '' }).success).toBe(false);
    expect(EnquiryBody.safeParse({ ...form, aboutMe: 'x'.repeat(2000) }).success).toBe(true);
  });

  it('wants the mobile as an international number, and lets it be left out', () => {
    expect(EnquiryBody.safeParse({ ...form, phone: '0412 345 678' }).success).toBe(false);
    expect(EnquiryBody.safeParse(form).success).toBe(true);
  });

  it('knows every country and territory, and nothing else', () => {
    for (const c of ['AU', 'NZ', 'GB', 'AQ', 'XK', 'EH']) expect(isCountry(c)).toBe(true);
    for (const c of ['ZZ', 'QQ', 'UK', 'EU', 'au']) expect(isCountry(c)).toBe(false);
  });

  it('spots bots: the hidden field filled in, or sent in under 3 seconds', () => {
    expect(looksLikeABot({ website: 'http://spam.example' })).toBe(true);
    expect(looksLikeABot({ elapsedMs: 900 })).toBe(true);
    expect(looksLikeABot({ elapsedMs: 45_000 })).toBe(false);
    expect(looksLikeABot({})).toBe(false);
  });

  it('lets Edit details change contact details only', () => {
    expect(EnquiryPatch.safeParse({}).success).toBe(false);
    expect(EnquiryPatch.parse({ phone: null })).toEqual({ phone: null });
    expect(EnquiryPatch.parse({ name: 'Mia T', aboutMe: 'changed' })).toEqual({ name: 'Mia T' });
  });
});

describe('status rules', () => {
  const now = new Date('2026-11-23T01:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);
  const kyra = { sub: 'kyra', admin: true };
  const sam = { sub: 'sam', admin: false };
  const at = (status: EnquiryStatus, ownerSub?: string) => ({
    status,
    ...(ownerSub ? { ownerSub } : {}),
  });
  const refuse = (
    e: ReturnType<typeof at>,
    a: EnquiryAction,
    who: { sub: string; admin: boolean },
  ) => {
    try {
      applyAction(e, a, who, now, 'Sam');
    } catch (err) {
      expect(err).toBeInstanceOf(RuleError);
      return { status: (err as RuleError).status, message: (err as Error).message };
    }
    throw new Error('expected a refusal');
  };

  it('picking up an open request makes it in progress and yours', () => {
    const c = applyAction(at('open'), { kind: 'pick-up' }, sam, now);
    expect(c.set).toMatchObject({ status: 'in-progress', ownerSub: 'sam' });
    expect(c.activity).toEqual({ kind: 'pickedUp', bySub: 'sam' });
  });

  it('says who got there first', () => {
    expect(refuse(at('in-progress', 'sam'), { kind: 'pick-up' }, kyra)).toEqual({
      status: 409,
      message: 'Sam picked this up a moment ago.',
    });
  });

  it('only the person who has it hands it back', () => {
    const c = applyAction(at('in-progress', 'sam'), { kind: 'hand-back' }, sam, now);
    expect(c).toMatchObject({ set: { status: 'open' }, remove: ['ownerSub', 'pickedUpAt'] });
    expect(refuse(at('in-progress', 'sam'), { kind: 'hand-back' }, kyra).status).toBe(403);
  });

  it('only admins take over, and the previous person is recorded', () => {
    const c = applyAction(at('in-progress', 'sam'), { kind: 'take-over' }, kyra, now);
    expect(c.set.ownerSub).toBe('kyra');
    expect(c.activity).toEqual({ kind: 'takenOver', bySub: 'kyra', fromSub: 'sam' });
    expect(refuse(at('in-progress', 'kyra'), { kind: 'take-over' }, sam).status).toBe(403);
  });

  it('converting needs it picked up, by you, and keeps it two years', () => {
    const c = applyAction(
      at('in-progress', 'sam'),
      { kind: 'convert', artistId: 'art_abcdefghij' },
      sam,
      now,
    );
    expect(c.set).toMatchObject({
      status: 'converted',
      artistId: 'art_abcdefghij',
      ttl: nowS + CONVERTED_KEEP_SECONDS,
    });
    expect(refuse(at('open'), { kind: 'convert', artistId: 'art_abcdefghij' }, sam).status).toBe(
      409,
    );
    expect(
      refuse(at('in-progress', 'sam'), { kind: 'convert', artistId: 'art_abcdefghij' }, kyra)
        .status,
    ).toBe(403);
  });

  it('anyone closes an open request (spam); a picked-up one is the owner’s or an admin’s', () => {
    const spam = applyAction(at('open'), { kind: 'close', reason: 'spam' }, sam, now);
    expect(spam.set).toMatchObject({
      status: 'closed',
      closedReason: 'spam',
      ownerSub: 'sam',
      ttl: nowS + CLOSED_KEEP_SECONDS,
    });
    expect(
      applyAction(at('in-progress', 'sam'), { kind: 'close', reason: 'no-reply' }, kyra, now).set
        .status,
    ).toBe('closed');
    expect(
      refuse(at('in-progress', 'kyra'), { kind: 'close', reason: 'no-reply' }, sam).status,
    ).toBe(403);
    expect(refuse(at('converted', 'sam'), { kind: 'close', reason: 'other' }, sam).status).toBe(
      409,
    );
  });

  it('reopening brings it back in progress with you, and stops the clock', () => {
    const c = applyAction(at('closed', 'sam'), { kind: 'reopen' }, kyra, now);
    expect(c.set).toMatchObject({ status: 'in-progress', ownerSub: 'kyra' });
    expect(c.remove).toEqual(
      expect.arrayContaining(['ttl', 'closedReason', 'artistId', 'convertedAt']),
    );
    expect(refuse(at('open'), { kind: 'reopen' }, sam).status).toBe(409);
    expect(refuse(at('converted', 'kyra'), { kind: 'reopen' }, sam).status).toBe(403);
  });
});

describe('what the app sees', () => {
  const item = (over: Partial<EnquiryItem>): EnquiryItem => ({
    enquiryId: 'e1',
    status: 'open',
    country: 'NZ',
    receivedAt: '2026-11-20T00:00:00Z',
    updatedAt: '2026-11-20T00:00:00Z',
    version: 1,
    sealed: new Uint8Array(),
    ...over,
  });

  it('a summary names the country and never carries the sealed value', () => {
    const s = summaryOf(item({}), { name: 'Jo', email: 'jo@x.co' });
    expect(s).toMatchObject({ name: 'Jo', countryName: 'New Zealand', resends: 0 });
    expect(s).not.toHaveProperty('sealed');
  });

  it('counts open, mine and recent conversions without opening anything', () => {
    const now = new Date('2026-11-23T00:00:00Z');
    const c = counts(
      [
        item({ status: 'open', receivedAt: '2026-11-19T00:00:00Z' }),
        item({ status: 'open', receivedAt: '2026-11-22T00:00:00Z' }),
        item({ status: 'in-progress', ownerSub: 'me' }),
        item({ status: 'in-progress', ownerSub: 'sam' }),
        item({ status: 'converted', convertedAt: '2026-11-01T00:00:00Z' }),
        item({ status: 'converted', convertedAt: '2026-01-01T00:00:00Z' }),
      ],
      'me',
      now,
    );
    expect(c).toEqual({
      open: 2,
      inProgress: 2,
      mine: 1,
      convertedRecently: 1,
      oldestOpenAt: '2026-11-19T00:00:00Z',
    });
  });

  it('counts business days in Melbourne', () => {
    // Fri 20 Nov (Melbourne) → Mon 23 Nov is one business day.
    expect(businessDaysWaiting('2026-11-20T01:00:00Z', new Date('2026-11-23T01:00:00Z'))).toBe(1);
    expect(businessDaysWaiting('2026-11-16T01:00:00Z', new Date('2026-11-23T01:00:00Z'))).toBe(5);
  });

  it('nudges Blueprint, never artists, when a request changes', () => {
    expect(nudgeFor('ORG#enquiries', 'ENQ#e1')).toEqual({
      topic: 'enquiries',
      channels: ['/inbox/bmg'],
    });
  });
});
