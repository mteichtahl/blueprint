import { renderLayout, type Block, type LayoutOptions, type RenderedEmail } from './layout.ts';

/** Where links point and where the logo lives. */
export interface BrandContext {
  /** e.g. https://app.blueprintmusic.group (no trailing slash). */
  appOrigin: string;
  /** Defaults to `${appOrigin}/brand/bmg-logo-white-on-navy.png`. */
  logoUrl?: string;
}

const layout = (ctx: BrandContext): LayoutOptions => ({
  logoUrl: ctx.logoUrl ?? `${ctx.appOrigin.replace(/\/$/, '')}/brand/bmg-logo-white-on-navy.png`,
});
const link = (ctx: BrandContext, path: string) => `${ctx.appOrigin.replace(/\/$/, '')}${path}`;

/** "2026-12-03" → "Thu 3 Dec 2026". Plain dates are calendar dates, so no time zone shift. */
export function formatDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  // Built by hand: ICU's en-AU punctuation differs between Node builds.
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "13:30" → "1:30 pm". */
export function formatTime(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

export const REMINDER_LABEL: Record<string, string> = {
  '60m': '60 minutes before',
  '1d': '1 day before',
  '3d': '3 days before',
  '7d': '7 days before',
};

const FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  notes: 'Notes',
  due: 'Due date',
  dueTime: 'Due time',
  reminder: 'Reminder',
  done: 'Status',
};

export interface TodoSnapshot {
  title: string;
  due?: string | undefined;
  dueTime?: string | undefined;
  reminder?: string | undefined;
  done?: boolean | undefined;
}

function dueText(t: Pick<TodoSnapshot, 'due' | 'dueTime'>): string | undefined {
  if (!t.due) return undefined;
  return `${formatDate(t.due)}${t.dueTime ? `, ${formatTime(t.dueTime)}` : ''}`;
}

function todoFacts(t: TodoSnapshot): Block {
  const rows: [string, string][] = [['To-do', t.title]];
  const due = dueText(t);
  if (due) rows.push(['Due', due]);
  if (t.reminder && REMINDER_LABEL[t.reminder])
    rows.push(['Reminder', REMINDER_LABEL[t.reminder]!]);
  if (t.done !== undefined) rows.push(['Status', t.done ? 'Done' : 'Open']);
  return { kind: 'facts', rows };
}

// ── Invitations ───────────────────────────────────────────────────────────

/**
 * Getting started (invitations): how to open Blueprint on the web, install it
 * on a phone, and sign in for the first time, which is the same on both.
 */
export function gettingStartedBlocks(
  ctx: BrandContext,
  email: string,
  who: 'artist' | 'team' = 'artist',
): Block[] {
  const site = link(ctx, '/');
  return [
    { kind: 'h', text: 'Use Blueprint on the web' },
    {
      kind: 'p',
      text: `Open ${site} in any browser on your computer, tablet or phone. Bookmark it so it's easy to find.`,
    },
    { kind: 'h', text: 'Install the app on your phone' },
    {
      kind: 'p',
      text: 'Blueprint installs straight from the website, so there’s nothing to download from an app store. It then opens full screen from its own icon and keeps you signed in.',
    },
    {
      kind: 'list',
      items: [
        `iPhone or iPad: open ${site} in Safari, tap the Share button, then Add to Home Screen, then Add.`,
        `Android: open ${site} in Chrome, tap the ⋮ menu, then Install app (or Add to Home screen).`,
        'Computer (optional): in Chrome or Edge, click the install icon at the right of the address bar.',
      ],
    },
    { kind: 'h', text: 'Sign in for the first time (website or app)' },
    {
      kind: 'p',
      text: 'The steps are the same whichever you use first. You only use the temporary password once.',
    },
    {
      kind: 'steps',
      items: [
        `Open Blueprint (the website, or the app icon on your home screen) and enter your email: ${email}.`,
        'Enter the temporary password above.',
        'Choose your own password: you’ll use it from now on.',
        'Set up two-step verification: scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and enter the 6-digit code it shows.',
        'Optionally, create a passkey so next time you sign in with your fingerprint, face or device PIN.',
        ...(who === 'artist'
          ? ['Accept the terms and choose whether to use Blueprint’s AI assistance.']
          : []),
      ],
    },
    {
      kind: 'p',
      text: 'Signing in on another device later? Use your email, your own password and your authenticator code (or your passkey). The temporary password won’t work again.',
    },
  ];
}

export function inviteEmail(
  ctx: BrandContext,
  i: { displayName: string; email: string; temporaryPassword: string; expiresInDays: number },
): RenderedEmail {
  return renderLayout(
    {
      subject: 'You’re invited to the Blueprint Music Group app',
      preheader: 'Your Blueprint workspace is ready. Here’s how to install the app and sign in.',
      eyebrow: 'Welcome to Blueprint',
      heading: `Hi ${i.displayName}, your workspace is ready`,
      blocks: [
        {
          kind: 'p',
          text: 'Blueprint Music Group has set up your account in the BMG app: chat with the team, share files, send work for review and follow your plan.',
        },
        { kind: 'facts', rows: [['Email', i.email]] },
        { kind: 'code', label: 'Temporary password', text: i.temporaryPassword },
        ...gettingStartedBlocks(ctx, i.email),
      ],
      cta: { label: 'Open Blueprint and sign in', url: link(ctx, '/') },
      footerNote: `This invitation expires in ${i.expiresInDays} days. If it runs out, ask Blueprint to send it again. If you weren’t expecting it, you can ignore this email.`,
    },
    layout(ctx),
  );
}

/** A Blueprint team member's invitation (Access & permissions → Add team member). */
export function teamInviteEmail(
  ctx: BrandContext,
  i: {
    displayName: string;
    email: string;
    temporaryPassword: string;
    roleLabel: string;
    invitedBy: string;
    expiresInDays: number;
  },
): RenderedEmail {
  return renderLayout(
    {
      subject: 'You’ve been added to the Blueprint team app',
      preheader: `${i.invitedBy} added you to the Blueprint Music Group app.`,
      eyebrow: 'Welcome to the team',
      heading: `Hi ${i.displayName}, you’re on the Blueprint team`,
      blocks: [
        {
          kind: 'p',
          text: `${i.invitedBy} has given you a login to the BMG app, where Blueprint works with its artists: workspaces, chat, reviews, events and the newsletter.`,
        },
        {
          kind: 'facts',
          rows: [
            ['Email', i.email],
            ['Access', i.roleLabel],
          ],
        },
        { kind: 'code', label: 'Temporary password', text: i.temporaryPassword },
        ...gettingStartedBlocks(ctx, i.email, 'team'),
      ],
      cta: { label: 'Open Blueprint and sign in', url: link(ctx, '/') },
      footerNote: `This invitation expires in ${i.expiresInDays} days. If you weren’t expecting it, you can ignore this email.`,
    },
    layout(ctx),
  );
}

// ── To-dos ────────────────────────────────────────────────────────────────

export function todoUpdatedEmail(
  ctx: BrandContext,
  u: {
    recipient: 'artist' | 'bmg';
    artistName?: string | undefined;
    changedBy: string;
    changedFields: string[];
    todo: TodoSnapshot;
  },
): RenderedEmail {
  const changed = u.changedFields.map((f) => FIELD_LABEL[f] ?? f);
  const onlyDone = u.changedFields.length === 1 && u.changedFields[0] === 'done';
  const heading =
    u.recipient === 'artist'
      ? onlyDone
        ? `${u.changedBy} marked a to-do ${u.todo.done ? 'done' : 'open'}`
        : `${u.changedBy} updated one of your to-dos`
      : `${u.artistName ?? 'An artist'} ${onlyDone ? (u.todo.done ? 'completed' : 'reopened') : 'updated'} a Blueprint to-do`;
  return renderLayout(
    {
      subject: `To-do updated: ${u.todo.title}`,
      preheader: `${changed.join(', ')} changed on “${u.todo.title}”.`,
      eyebrow: 'To-do updated',
      heading,
      blocks: [
        todoFacts(u.todo),
        { kind: 'p', text: 'What changed:' },
        { kind: 'list', items: changed },
      ],
      cta: { label: 'Open to-dos', url: link(ctx, '/?view=todo') },
    },
    layout(ctx),
  );
}

export function todoReminderEmail(ctx: BrandContext, todo: TodoSnapshot): RenderedEmail {
  const due = dueText(todo);
  return renderLayout(
    {
      subject: `Reminder: ${todo.title}${due ? ` is due ${due}` : ''}`,
      preheader: due ? `Due ${due}.` : 'A to-do from Blueprint is coming up.',
      eyebrow: 'Reminder',
      heading: due ? `“${todo.title}” is due soon` : `Reminder: “${todo.title}”`,
      blocks: [todoFacts({ ...todo, reminder: undefined, done: undefined })],
      cta: { label: 'Open to-dos', url: link(ctx, '/?view=todo') },
      footerNote: 'You set this reminder in the BMG app. Change or turn it off on the to-do.',
    },
    layout(ctx),
  );
}

// ── Review ────────────────────────────────────────────────────────────────

const PRIORITY: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export function submissionUpdatedEmail(
  ctx: BrandContext,
  s: { title?: string | undefined; priority: string; neededBy: string },
): RenderedEmail {
  return renderLayout(
    {
      subject: 'Blueprint changed the timing on your submission',
      preheader: `Priority ${PRIORITY[s.priority] ?? s.priority}, needed by ${formatDate(s.neededBy)}.`,
      eyebrow: 'Submission updated',
      heading: 'Blueprint updated your submission',
      blocks: [
        {
          kind: 'facts',
          rows: [
            ...(s.title ? ([['Submission', s.title]] as [string, string][]) : []),
            ['Priority', PRIORITY[s.priority] ?? s.priority],
            ['Needed by', formatDate(s.neededBy)],
          ],
        },
      ],
      cta: { label: 'Open submissions', url: link(ctx, '/?view=review') },
    },
    layout(ctx),
  );
}

export function feedbackGivenEmail(
  ctx: BrandContext,
  f: { title?: string | undefined; todos: number },
): RenderedEmail {
  const points =
    f.todos === 0
      ? 'There are no new action points.'
      : `${f.todos} action point${f.todos === 1 ? ' has' : 's have'} been added to your to-do list.`;
  return renderLayout(
    {
      subject: f.title ? `Feedback is ready: ${f.title}` : 'Your feedback from Blueprint is ready',
      preheader: points,
      eyebrow: 'Feedback ready',
      heading: 'Blueprint has reviewed your submission',
      blocks: [
        ...(f.title ? [{ kind: 'facts', rows: [['Submission', f.title]] } as Block] : []),
        { kind: 'p', text: points },
      ],
      cta: { label: 'Read the feedback', url: link(ctx, '/?view=review') },
    },
    layout(ctx),
  );
}

// ── Cognito messages (placeholders must survive verbatim) ─────────────────

export type CognitoMessageKind =
  'admin-create-user' | 'verification-code' | 'forgot-password' | 'attribute-verification';

/**
 * Branded versions of Cognito's own emails. `code` and `username` are the
 * Cognito placeholders ({####}, {username}), passed through unescaped-safe
 * (they contain no HTML special characters).
 */
export function cognitoEmail(
  ctx: BrandContext,
  kind: CognitoMessageKind,
  p: { code: string; username?: string },
): RenderedEmail {
  switch (kind) {
    case 'admin-create-user':
      return renderLayout(
        {
          subject: 'Your Blueprint Music Group sign-in',
          preheader: 'Blueprint Music Group has set up your account.',
          eyebrow: 'Welcome to Blueprint',
          heading: 'Your account is ready',
          blocks: [
            { kind: 'facts', rows: [['Email', p.username ?? '']] },
            { kind: 'code', label: 'Temporary password', text: p.code },
            {
              kind: 'p',
              text: 'The first time you sign in you’ll choose your own password and set up an authenticator app or a passkey.',
            },
          ],
          cta: { label: 'Sign in to Blueprint', url: link(ctx, '/') },
          footerNote: 'The temporary password expires in 7 days.',
        },
        layout(ctx),
      );
    case 'forgot-password':
      return renderLayout(
        {
          subject: 'Reset your Blueprint password',
          preheader: 'Use this code to reset your password.',
          eyebrow: 'Password reset',
          heading: 'Reset your password',
          blocks: [
            { kind: 'p', text: 'Enter this code to choose a new password:' },
            { kind: 'code', text: p.code },
          ],
          footerNote: 'If you didn’t ask to reset your password, you can ignore this email.',
        },
        layout(ctx),
      );
    case 'verification-code':
    case 'attribute-verification':
      return renderLayout(
        {
          subject: 'Your Blueprint verification code',
          preheader: 'Use this code to verify your email.',
          eyebrow: 'Verify your email',
          heading: 'Your verification code',
          blocks: [
            { kind: 'p', text: 'Enter this code in the BMG app to verify your email address:' },
            { kind: 'code', text: p.code },
          ],
          footerNote: 'If you didn’t ask for this, you can ignore this email.',
        },
        layout(ctx),
      );
  }
}
