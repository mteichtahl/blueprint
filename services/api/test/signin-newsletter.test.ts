import { describe, expect, it } from 'vitest';
import {
  hashCode,
  locked,
  matchCode,
  MAX_RECOVERY_FAILURES,
  newCode,
  newSet,
  normalise,
} from '../src/recovery.ts';
import { addSubscriber, memberId, quarterHour, setFetch } from '../src/connectors/mailchimp.ts';
import { issueHtml, MailchimpBody } from '../src/newsroom/model.ts';

/**
 * Sign-in and newsletter gaps: recovery codes, the public newsletter
 * sign-up and recovery endpoints, and sending the newsletter through
 * Mailchimp.
 */

// ── Recovery codes (pure) ─────────────────────────────────────────────────

describe('recovery codes', () => {
  it('are ten letters and digits people can read off paper', () => {
    for (let i = 0; i < 50; i++) {
      expect(newCode()).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
    }
    const { shown, record } = newSet(new Date('2026-11-12T00:00:00Z'));
    expect(new Set(shown).size).toBe(10);
    expect(record.codes).toHaveLength(10);
    // Only hashes are kept.
    expect(record.codes.join()).not.toContain(shown[0]!.replace('-', ''));
  });

  it('match however they’re typed, only once, and only unused ones', () => {
    const codes = ['ABCDE-FGHJK', 'MNPQR-STUVW'];
    const stored: (string | null)[] = codes.map(hashCode);
    expect(normalise(' abcde fghjk ')).toBe('ABCDEFGHJK');
    expect(matchCode('abcde fghjk', stored)).toBe(0);
    expect(matchCode('MNPQRSTUVW', stored)).toBe(1);
    expect(matchCode('ABCDE-FGHJX', stored)).toBe(-1);
    // Letters that aren't in the alphabet (O, I) never match.
    expect(matchCode('OBCDE-FGHJK', stored)).toBe(-1);
    stored[0] = null;
    expect(matchCode('ABCDE-FGHJK', stored)).toBe(-1);
  });

  it('lock an account for the hour after too many wrong codes', () => {
    const now = 10_000;
    expect(locked({ failures: MAX_RECOVERY_FAILURES, failWindowStart: now - 60 }, now)).toBe(true);
    expect(locked({ failures: MAX_RECOVERY_FAILURES, failWindowStart: now - 3601 }, now)).toBe(
      false,
    );
    expect(locked({ failures: 2, failWindowStart: now }, now)).toBe(false);
  });
});

// ── Mailchimp and the issue HTML (pure) ─────────────────────────────────────

describe('Mailchimp', () => {
  it('adds a subscriber as pending (double opt-in), keeping anyone already there', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    setFetch((async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: init.body as string });
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
    }) as unknown as typeof fetch);
    const mc = { apiHost: 'https://us21.api.mailchimp.com', token: 't', listId: 'L1' };
    expect(await addSubscriber(mc, { email: 'Jo@Example.com', firstName: 'Jo' })).toBe('pending');
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `https://us21.api.mailchimp.com/3.0/lists/L1/members/${memberId('jo@example.com')}`,
    });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      email_address: 'Jo@Example.com',
      status_if_new: 'pending',
      merge_fields: { FNAME: 'Jo' },
    });
  });

  it('keeps only Mailchimp’s short title from an error', async () => {
    setFetch(
      (async () =>
        new Response(JSON.stringify({ title: 'Invalid Resource', detail: 'jo@example.com is…' }), {
          status: 400,
        })) as unknown as typeof fetch,
    );
    const mc = { apiHost: 'https://us21.api.mailchimp.com', token: 't', listId: 'L1' };
    await expect(addSubscriber(mc, { email: 'jo@example.com' })).rejects.toThrow(
      'Mailchimp said: Invalid Resource',
    );
  });

  it('schedules on the quarter hour', () => {
    expect(quarterHour('2026-11-20T09:07:31Z')).toBe('2026-11-20T09:00:00.000Z');
    expect(quarterHour('2026-11-20T09:08:00Z')).toBe('2026-11-20T09:15:00.000Z');
    expect(quarterHour('2026-11-20T09:53:00Z')).toBe('2026-11-20T10:00:00.000Z');
  });

  it('sends only real requests: up to 5 test addresses, or send, schedule, unschedule', () => {
    expect(MailchimpBody.safeParse({ action: 'test', emails: ['a@b.co'] }).success).toBe(true);
    expect(
      MailchimpBody.safeParse({ action: 'test', emails: Array(6).fill('a@b.co') }).success,
    ).toBe(false);
    expect(MailchimpBody.safeParse({ action: 'schedule', at: 'tomorrow' }).success).toBe(false);
    expect(MailchimpBody.safeParse({ action: 'send', extra: 1 }).success).toBe(false);
  });

  it('builds the issue’s email HTML with everything escaped', () => {
    const html = issueHtml({
      title: 'Week <b>47</b>',
      week: 47,
      weekOf: '2026-11-16',
      sections: {
        blueprint: [{ id: 'b', heading: 'Mixer', text: 'Tickets & more', link: 'https://x.co/t' }],
        artists: [{ id: 'a', text: 'Chloe’s single "Glass"' }],
        industry: [
          {
            id: 'i',
            title: 'Grants',
            summary: 'Open now',
            url: 'https://y.co/a?b=1&c=2',
            source: 'Y',
          },
        ],
      },
    });
    expect(html).toContain('<h1>Week &lt;b&gt;47&lt;/b&gt;</h1>');
    expect(html).toContain('16 November 2026');
    expect(html).toContain('Tickets &amp; more');
    expect(html).toContain('<a href="https://x.co/t">Find out more</a>');
    expect(html).toContain('&quot;Glass&quot;');
    expect(html).toContain('href="https://y.co/a?b=1&amp;c=2"');
  });
});
