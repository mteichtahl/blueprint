/**
 * Notifications (design 7.4; screens: bell, Profile & preferences). Pure:
 * who hears about what, the wording, preferences and quiet hours, all
 * unit-tested. Nothing here carries message text or file contents: emails
 * and notifications say what happened and link to the app.
 */
import { renderLayout } from '@bmg/email';
import { createHash } from 'node:crypto';
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
      conversationType: 'bmg-artist' | 'group' | 'broadcast' | 'announcement' | 'artist-to-artist';
      artistIds: string[];
      senderSub: string;
      senderName: string;
      title?: string;
      /** Inbox members (`BMG`, `ARTIST#id`) who muted the chat. */
      mutedMembers?: string[];
      system?: boolean;
    }
  | {
      type: 'gig.helpRequested';
      artistId: string;
      gigId: string;
      title: string;
      topics?: string[];
      artistName?: string;
    }
  | {
      /** A comment on a to-do's thread (rev 7): the other side hears about it. */
      type: 'todo.commented';
      artistId: string;
      todoId: string;
      title: string;
      authorSub: string;
      authorName: string;
      byRole: 'artist' | 'bmg-admin' | 'bmg-staff';
      bmgOnly?: boolean;
    }
  | { type: 'connector.reminder'; artistId: string }
  | { type: 'connector.needsReauth'; connectorId: string; label: string; artistId?: string }
  | {
      type: 'file.rejected';
      fileId: string;
      artistId?: string;
      uploadedBy: string;
      name: string;
      reason: string;
    }
  | {
      /** A meeting's transcript is in, or it couldn't be made (rev 11). Only the recorder hears. */
      type: 'meeting.processed';
      meetingId: string;
      artistId?: string;
      createdBy: string;
      title: string;
      outcome: 'ready' | 'failed' | 'no-ai' | 'off';
    };

export interface Draft {
  /** In-app and email category; preferences can turn email off per category later. */
  kind: 'review' | 'feedback' | 'message' | 'file' | 'gig' | 'connector' | 'todo' | 'meeting';
  title: string;
  body: string;
  /** App view to open, e.g. `review`, `submit`, `chat:<id>`, `messages`. */
  link: string;
  /** Messages are throttled per conversation for email. */
  throttleKey?: string;
}

const HELP_LABEL: Record<string, string> = {
  pitch: 'the pitch email',
  budget: 'the budget',
  promo: 'promo',
  setlist: 'the set list',
};

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
      const muted = new Set(e.mutedMembers ?? []);
      const toArtists = artistsOf(e.artistIds).filter(
        (r) => r.sub !== e.senderSub && !muted.has(`ARTIST#${r.artistId}`),
      );
      const broadcast = e.conversationType === 'broadcast';
      const to = broadcast
        ? everyone.filter((r) => r.role === 'artist')
        : e.conversationType === 'artist-to-artist' || e.conversationType === 'announcement'
          ? toArtists
          : muted.has('BMG')
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
          title: broadcast
            ? 'New message to all artists'
            : e.conversationType === 'announcement'
              ? `Announcement from ${e.senderName}`
              : `New message from ${e.senderName}`,
          body: e.title ? `In ${e.title}.` : 'Open the app to read it.',
          link: `chat:${e.conversationId}`,
          throttleKey: e.conversationId,
        },
      };
    }
    case 'gig.helpRequested':
      return {
        to: everyone.filter((r) => isBmg(r) && bmgFor(r, [e.artistId])),
        draft: {
          kind: 'gig',
          title: `${e.artistName ?? 'An artist'} asked for help with a gig`,
          body: e.topics?.length
            ? `“${e.title}”: help with ${e.topics.map((t) => HELP_LABEL[t] ?? t).join(', ')}.`
            : `“${e.title}” needs a hand.`,
          link: 'gigs',
        },
      };
    case 'todo.commented': {
      // Artist ↔ Blueprint threads: the artist hears from Blueprint, and
      // Blueprint (staff on this artist) from the artist and each other.
      // BMG-only to-dos never reach the artist.
      const bmg = everyone.filter((r) => isBmg(r) && bmgFor(r, [e.artistId]));
      const to =
        e.byRole === 'artist' ? bmg : [...(e.bmgOnly ? [] : artistsOf([e.artistId])), ...bmg];
      return {
        to: to.filter((r) => r.sub !== e.authorSub),
        draft: {
          kind: 'todo',
          title: `${e.authorName} commented on a to-do`,
          body: `“${e.title}”`,
          link: 'todos',
          throttleKey: `todo-${e.todoId}`,
        },
      };
    }
    case 'connector.reminder':
      return {
        to: artistsOf([e.artistId]),
        draft: {
          kind: 'connector',
          title: 'Connect your accounts',
          body: 'Blueprint asked you to connect your socials, so your stats show up in the app.',
          link: 'connectors',
        },
      };
    case 'connector.needsReauth':
      return {
        to: e.artistId ? artistsOf([e.artistId]) : everyone.filter((r) => r.role === 'bmg-admin'),
        draft: {
          kind: 'connector',
          title: `${e.label} needs you to sign in again`,
          body: 'Its numbers have stopped updating until you reconnect it.',
          link: 'connectors',
        },
      };
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
    case 'meeting.processed': {
      const words = {
        ready: ['Transcript ready', 'The transcript is in. Open the meeting for a summary.'],
        failed: ['Transcript not made', 'The recording couldn’t be transcribed. It’s still saved.'],
        'no-ai': [
          'Recording saved',
          'An artist in this meeting has AI turned off, so it wasn’t transcribed.',
        ],
        off: ['Recording saved', 'Transcription is switched off for now. The recording is kept.'],
      } as const;
      const [title, body] = words[e.outcome];
      return {
        to: everyone.filter((r) => r.sub === e.createdBy && isBmg(r)),
        draft: {
          kind: 'meeting',
          title: `${title}: ${e.title}`,
          body,
          link: `meeting:${e.artistId ?? 'library'}/${e.meetingId}`,
        },
      };
    }
  }
}

// ── Preferences (Profile & preferences) ───────────────────────────────────
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 22:00');

export const Preferences = z.object({
  email: z.boolean().default(true),
  /** Web push to the devices this person turned it on for (installable app). */
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
  gig: 'Gig help',
  connector: 'Connectors',
  todo: 'To-do',
  meeting: 'Meeting notes',
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

// ── Web push ─────────────────────────────────────────────────────────────
/** A browser push subscription (PushSubscription.toJSON()). */
export const PushSubscriptionBody = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine((u) => u.startsWith('https://'), 'Push endpoints must use HTTPS'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>;

/** One row per device: the endpoint is hashed into the key, never used as one. */
export const pushSk = (endpoint: string) =>
  `PUSH#${createHash('sha256').update(endpoint).digest('hex').slice(0, 40)}`;

/** What a push carries: the notification's title, body and link only. */
export function pushPayload(d: Draft): string {
  return JSON.stringify({
    title: d.title,
    body: d.body,
    link: d.link,
    tag: d.throttleKey ?? d.kind,
  });
}
