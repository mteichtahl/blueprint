import { describe, expect, it } from 'vitest';
import {
  BRAND,
  cognitoEmail,
  escapeHtml,
  feedbackGivenEmail,
  formatDate,
  formatTime,
  inviteEmail,
  renderLayout,
  safeUrl,
  submissionUpdatedEmail,
  todoReminderEmail,
  todoUpdatedEmail,
} from '../src/index.ts';

const ctx = { appOrigin: 'https://app.blueprintmusic.group' };

describe('escaping', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
  it('never puts a script into the HTML', () => {
    const e = renderLayout(
      {
        subject: '<script>',
        preheader: '<img onerror=x>',
        heading: '<script>alert(1)</script>',
        blocks: [{ kind: 'p', text: '<b>hi</b>' }],
        cta: { label: '<i>go</i>', url: 'javascript:alert(1)' },
      },
      { logoUrl: 'https://x/logo.png' },
    );
    expect(e.html).not.toContain('<script>');
    expect(e.html).not.toContain('<b>hi</b>');
    expect(e.html).not.toContain('javascript:');
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('only allows http(s) links', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#');
    expect(safeUrl('https://a.b/c')).toBe('https://a.b/c');
  });
});

const all = {
  invite: inviteEmail(ctx, {
    displayName: 'Chloe',
    email: 'chloe@example.com',
    temporaryPassword: 'Ab3$xyz123456',
    expiresInDays: 7,
  }),
  todoUpdated: todoUpdatedEmail(ctx, {
    recipient: 'artist',
    changedBy: 'Blueprint',
    changedFields: ['due', 'reminder'],
    todo: { title: 'Finish lyrics', due: '2026-12-03', dueTime: '13:30', reminder: '1d' },
  }),
  todoReminder: todoReminderEmail(ctx, { title: 'Finish lyrics', due: '2026-12-03' }),
  submissionUpdated: submissionUpdatedEmail(ctx, { priority: 'high', neededBy: '2026-12-01' }),
  feedbackGiven: feedbackGivenEmail(ctx, { todos: 3 }),
};

describe('templates', () => {
  for (const [name, e] of Object.entries(all)) {
    it(`${name} carries the brand and a call to action`, () => {
      expect(e.html).toContain(BRAND.navy);
      expect(e.html).toContain(BRAND.offWhite);
      expect(e.html).toContain(BRAND.coralDeep);
      expect(e.html).toContain('Lexend Exa');
      expect(e.html).toContain('Archivo Narrow');
      expect(e.html).toContain(
        'src="https://app.blueprintmusic.group/brand/bmg-logo-white-on-navy.png"',
      );
      expect(e.html).toContain('alt="Blueprint Music Group"');
      expect(e.html).toMatch(/href="https:\/\/app\.blueprintmusic\.group\/[^"]*"/);
      expect(e.text).toContain('Blueprint Music Group');
      expect(e.subject.length).toBeGreaterThan(5);
    });
  }
  it('shows what changed and when it is due', () => {
    expect(all.todoUpdated.text).toContain('Due date');
    expect(all.todoUpdated.text).toContain('Thu 3 Dec 2026, 1:30 pm');
    expect(all.todoUpdated.text).toContain('1 day before');
  });
  it('includes the temporary password in the invite', () => {
    expect(all.invite.html).toContain('Ab3$xyz123456');
  });
  it('keeps Cognito placeholders intact', () => {
    const e = cognitoEmail(ctx, 'admin-create-user', { code: '{####}', username: '{username}' });
    expect(e.html).toContain('{####}');
    expect(e.html).toContain('{username}');
    expect(cognitoEmail(ctx, 'forgot-password', { code: '{####}' }).html).toContain('{####}');
  });
  it('formats dates and times', () => {
    expect(formatDate('2026-12-03')).toBe('Thu 3 Dec 2026');
    expect(formatTime('09:05')).toBe('9:05 am');
    expect(formatTime('00:00')).toBe('12:00 am');
  });
});
