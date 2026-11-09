/**
 * Notifications (design 7.4; screens: bell, Profile & preferences). Pure:
 * who hears about what, the wording, preferences and quiet hours, all
 * unit-tested. Nothing here carries message text or file contents: emails
 * and notifications say what happened and link to the app.
 */
import { renderLayout } from '@bmg/email';
import { z } from 'zod';

export interface Recipient {
  sub: string;
  email?: string;
  role: 'artist' | 'bmg-admin' | 'bmg-staff';
  artistId?: string;
  /** Staff only. */
  assignedArtistIds?: string[];
}

/** Domain events from the bus (source `bmg.workspace`) that notify someone. */
export type DomainEvent =
  | {
      type: 'submission.created';
      artistId: string;
      submissionId: string;
      title?: string;
      artistName?: string;
    }
  | {
      type: 'submission.updated';
      artistId: string;
      submissionId: string;
      title?: string;
      priority: string;
      neededBy: string;
    }
  | {
      type: 'submission.feedbackGiven';
      artistId: string;
      submissionId: string;
      title?: string;
      todos: number;
    }
  | {
      type: 'message.created';
      conversationId: string;
      conversationType: 'bmg-artist' | 'group' | 'broadcast' | 'artist-to-artist';
      artistIds: string[];
      senderSub: string;
      senderName: string;
      title?: string;
    }
  | {
      type: 'file.rejected';
      fileId: string;
      artistId?: string;
      uploadedBy: string;
      name: string;
      reason: string;
    };

export interface Draft {
  /** In-app and email category; preferences can turn email off per category later. */
  kind: 'review' | 'feedback' | 'message' | 'file';
  title: string;
  body: string;
  /** App view to open, e.g. `review`, `submit`, `chat:<id>`, `messages`. */
  link: string;
  /** Messages are throttled per conversation for email. */
  throttleKey?: string;
}

const isBmg = (r: Recipient) => r.role === 'bmg-admin' || r.role === 'bmg-staff';
const bmgFor = (r: Recipient, artistIds: string[]) =>
  r.role === 'bmg-admin' ||
  (r.role === 'bmg-staff' &&
    artistIds.length > 0 &&
    artistIds.every((id) => (r.assignedArtistIds ?? []).includes(id)));

/** Picks recipients and words the notification. The actor is never notified. */
export function plan(
  e: DomainEvent,
  everyone: Recipient[],
): { to: Recipient[]; draft: Draft } | undefined {
  const artistsOf = (ids: string[]) =>
    everyone.filter((r) => r.role === 'artist' && r.artistId && ids.includes(r.artistId));
  switch (e.type) {
    case 'submission.created':
      return {
        to: everyone.filter((r) => isBmg(r) && bmgFor(r, [e.artistId])),
        draft: {
          kind: 'review',
          title: `${e.artistName ?? 'An artist'} sent something for review`,
          body: e.title
            ? `“${e.title}” is in the review queue.`
            : 'A new submission is in the review queue.',
          link: 'review',
        },
      };
    case 'submission.updated':
      return {
        to: artistsOf([e.artistId]),
        draft: {
          kind: 'review',
          title: 'Blueprint changed your submission',
          body: `${e.title ? `“${e.title}”` : 'Your submission'} is now ${e.priority} priority, needed by ${e.neededBy}.`,
          link: 'submit',
        },
      };
    case 'submission.feedbackGiven':
      return {
        to: artistsOf([e.artistId]),
        draft: {
          kind: 'feedback',
          title: 'Feedback is ready',
          body: `${e.title ? `“${e.title}”` : 'Your submission'} has feedback${e.todos ? `, with ${e.todos} new to-do${e.todos === 1 ? '' : 's'}` : ''}.`,
          link: 'submit',
        },
      };
    case 'message.created': {
      const toArtists = artistsOf(e.artistIds).filter((r) => r.sub !== e.senderSub);
      const broadcast = e.conversationType === 'broadcast';
      const to = broadcast
        ? everyone.filter((r) => r.role === 'artist')
        : e.conversationType === 'artist-to-artist'
          ? toArtists
          : [
              ...toArtists,
              ...everyone.filter(
                (r) => isBmg(r) && r.sub !== e.senderSub && bmgFor(r, e.artistIds),
              ),
            ];
      return {
        to: to.filter((r) => r.sub !== e.senderSub),
        draft: {
          kind: 'message',
          title: broadcast ? 'New message to all artists' : `New message from ${e.senderName}`,
          body: e.title ? `In ${e.title}.` : 'Open the app to read it.',
          link: `chat:${e.conversationId}`,
          throttleKey: e.conversationId,
        },
      };
    }
    case 'file.rejected':
      return {
        to: everyone.filter((r) => r.sub === e.uploadedBy || r.role === 'bmg-admin'),
        draft: {
          kind: 'file',
          title: 'An upload was not kept',
          body: `“${e.name}”: ${e.reason}.`,
          link: 'library',
        },
      };
  }
}

// ── Preferences (Profile & preferences) ───────────────────────────────────
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 22:00');

export const Preferences = z.object({
  email: z.boolean().default(true),
  /** Web push arrives with the installable app (next release); stored now. */
  push: z.boolean().default(false),
  quietHours: z
    .object({ start: Time, end: Time })
    .nullable()
    .default({ start: '22:00', end: '07:00' }),
});
export type Preferences = z.infer<typeof Preferences>;
export const DEFAULT_PREFERENCES: Preferences = Preferences.parse({});

/** Melbourne wall-clock "HH:MM" for a moment in time. */
export function melbourneTime(at: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** Quiet hours hold back email (and push); the in-app notification is still there. */
export function inQuietHours(prefs: Preferences, at: Date): boolean {
  const q = prefs.quietHours;
  if (!q || q.start === q.end) return false;
  const now = melbourneTime(at);
  return q.start < q.end ? now >= q.start && now < q.end : now >= q.start || now < q.end;
}

export const notificationPk = (sub: string) => `NOTIF#${sub}`;
export const PREFS_SK = 'PREFS';
export const userPk = (sub: string) => `USER#${sub}`;
/** In-app notifications are kept for 90 days. */
export const NOTIFICATION_TTL_SECONDS = 90 * 24 * 3600;
/** At most one message email per conversation per person every 30 minutes. */
export const MESSAGE_EMAIL_THROTTLE_SECONDS = 30 * 60;

const EYEBROW: Record<Draft['kind'], string> = {
  review: 'Review',
  feedback: 'Feedback',
  message: 'New message',
  file: 'Upload',
};

/** The notification as a BMG-branded email (the shared layout in `@bmg/email`). */
export function emailText(
  d: Draft,
  appUrl: string,
): { subject: string; text: string; html: string } {
  const origin = appUrl.replace(/\/$/, '');
  return renderLayout(
    {
      subject: d.title,
      preheader: d.body,
      eyebrow: EYEBROW[d.kind],
      heading: d.title,
      blocks: [{ kind: 'p', text: d.body }],
      ...(origin ? { cta: { label: 'Open Blueprint', url: origin } } : {}),
      footerNote: 'You can change which emails you get in Profile & preferences.',
    },
    { logoUrl: `${origin}/brand/bmg-logo-white-on-navy.png` },
  );
}
