/**
 * Notifications (design 7.4; screens: bell, Profile & preferences). Pure:
 * who hears about what, the wording, preferences and quiet hours, all
 * unit-tested. Nothing here carries message text or file contents: emails
 * and notifications say what happened and link to the app.
 */
import { renderLayout, type Block as EmailBlock } from '@bmg/email';
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
      /** Blueprint completed the review; whoever asked for it is told. */
      type: 'submission.completed';
      artistId: string;
      submissionId: string;
      title?: string;
      /** Who asked for the review (the submission's creator). */
      requesterSub?: string;
      completedBySub?: string;
      todos: number;
      /** Whether the review came with feedback. */
      feedback: boolean;
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
  | {
      /**
       * Blueprint shared a meeting with the artist, so the to-dos its actions
       * made are now theirs to see (rev 11 change). One notice for all of them.
       */
      type: 'todo.shared';
      artistId: string;
      count: number;
      /** The to-dos' titles (the first few), which the artist can now see. */
      titles: string[];
      bySub: string;
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
    }
  | {
      /**
       * Blueprint updated (or undid an update to) an artist's plan, from a
       * meeting (rev 11) or the plan editor (rev 12, rolled up over 10 minutes).
       * The artist and the plan owner hear about it, never the person who made it.
       */
      type: 'plan.updated';
      artistId: string;
      undo?: boolean;
      /** What changed, in plain words (plan titles and dates, never the meeting). */
      lines: string[];
      more: number;
      /** Who made the change (not told). Rev 12. */
      bySub?: string;
      /** Staff chose not to tell the artist (meeting updates); the owner still hears. */
      skipArtist?: boolean;
      /** The plan owner; with none, the Blueprint admins hear instead. Rev 12. */
      ownerSub?: string;
      artistName?: string;
    }
  | {
      /**
       * A plan changed owner (rev 12), with the handover summary already
       * written from the plan's data (never AI). The new owner gets the
       * summary; the previous owner a short notice.
       */
      type: 'plan.ownerChanged';
      artistId: string;
      artistName: string;
      fromSub?: string;
      toSub: string;
      toName: string;
      bySub: string;
      moved: number;
      summary: string[];
    };

export interface Draft {
  /** In-app and email category; preferences can turn email off per category later. */
  kind:
    | 'review'
    | 'feedback'
    | 'message'
    | 'file'
    | 'gig'
    | 'connector'
    | 'todo'
    | 'meeting'
    | 'plan'
    /** An artist's plan, for its Blueprint owner (rev 12). */
    | 'artistPlan';
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

export interface Planned {
  to: Recipient[];
  draft: Draft;
}

/** Picks recipients and words the notification. The actor is never notified. */
export function plan(e: DomainEvent, everyone: Recipient[]): Planned | undefined {
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
    case 'submission.completed': {
      // Whoever asked for the review; an older submission without one tells the artist.
      const asker = everyone.filter((r) => r.sub === e.requesterSub && r.sub !== e.completedBySub);
      const name = e.title ? `“${e.title}”` : 'Your submission';
      return {
        to: asker.length ? asker : artistsOf([e.artistId]),
        draft: {
          kind: 'feedback',
          title: 'Your review is complete',
          body: `${name} has been reviewed by Blueprint${
            e.feedback
              ? e.todos
                ? `. Read the feedback and your ${e.todos} new to-do${e.todos === 1 ? '' : 's'}.`
                : '. Read the feedback.'
              : '.'
          }`,
          link: 'submit',
        },
      };
    }
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
    case 'todo.shared': {
      const shown = e.titles.slice(0, 3).map((t) => `“${t}”`);
      const more = e.count - shown.length;
      return {
        to: artistsOf([e.artistId]).filter((r) => r.sub !== e.bySub),
        draft: {
          kind: 'todo',
          title: `Blueprint added ${e.count === 1 ? 'a to-do' : `${e.count} to-dos`} for you`,
          body: `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
          link: 'todos',
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
    case 'plan.updated':
    case 'plan.ownerChanged':
      // Worded per person; see planGroups. This is the first group (the artist, or the new owner).
      return planGroups(e, everyone)[0];
  }
}

/**
 * Every recipient group, each with its own wording (rev 12: a plan update
 * reads differently for the artist and for the plan owner).
 */
export function planGroups(e: DomainEvent, everyone: Recipient[]): Planned[] {
  const isPlanEvent = e.type === 'plan.updated' || e.type === 'plan.ownerChanged';
  if (!isPlanEvent) {
    const one = plan(e, everyone);
    return one ? [one] : [];
  }
  const artistsOf = (ids: string[]) =>
    everyone.filter((r) => r.role === 'artist' && r.artistId && ids.includes(r.artistId));
  switch (e.type) {
    case 'plan.updated': {
      const list = e.lines.map((l) => `• ${l}`).join('\n');
      const body = `${list}${e.more ? `\n+ ${e.more} more change${e.more === 1 ? '' : 's'}` : ''}`;
      const notActor = (r: Recipient) => r.sub !== e.bySub;
      // The plan owner (rev 12); a plan with no owner (or one who left) goes to the admins.
      const owner = everyone.find((r) => r.sub === e.ownerSub && isBmg(r));
      const bmg = (owner ? [owner] : everyone.filter((r) => r.role === 'bmg-admin')).filter(
        notActor,
      );
      const name = e.artistName ?? 'An artist';
      return [
        {
          to: e.skipArtist ? [] : artistsOf([e.artistId]).filter(notActor),
          draft: {
            kind: 'plan',
            title: e.undo ? 'Blueprint undid a plan update' : 'Blueprint updated your plan',
            body,
            link: 'plan',
          },
        },
        {
          to: bmg,
          draft: {
            kind: 'artistPlan',
            title: e.undo
              ? `A plan update to ${name}'s plan was undone`
              : `${name}'s plan was updated`,
            body,
            link: `plan:${e.artistId}`,
          },
        },
      ];
    }

    case 'plan.ownerChanged': {
      const to = everyone.find((r) => r.sub === e.toSub && isBmg(r));
      const from = e.fromSub ? everyone.find((r) => r.sub === e.fromSub && isBmg(r)) : undefined;
      const link = `plan:${e.artistId}`;
      return [
        // The summary is a briefing, so the new owner gets it even when they took the plan on themselves.
        {
          to: to ? [to] : [],
          draft: {
            kind: 'artistPlan',
            title: `You now own ${e.artistName}'s plan`,
            body: e.summary.join('\n'),
            link,
          },
        },
        {
          to: from && from.sub !== e.toSub && from.sub !== e.bySub ? [from] : [],
          draft: {
            kind: 'artistPlan',
            title: `${e.toName} now owns ${e.artistName}'s plan`,
            body:
              e.moved > 0
                ? `${e.moved} open to-do${e.moved === 1 ? '' : 's'} moved to ${e.toName}.`
                : `${e.toName} looks after the plan from now on.`,
            link,
          },
        },
      ];
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
  plan: 'Your plan',
  artistPlan: 'Artist plan',
};

/**
 * A notification body as email blocks: "• " lines become lists, other lines
 * paragraphs (plan changes and handover summaries are mostly lists).
 */
export function bodyBlocks(body: string): EmailBlock[] {
  const blocks: EmailBlock[] = [];
  for (const line of body.split('\n')) {
    const item = /^•\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (item) {
      if (last?.kind === 'list') last.items.push(item[1]!);
      else blocks.push({ kind: 'list', items: [item[1]!] });
    } else if (line.trim()) {
      blocks.push({ kind: 'p', text: line.trim() });
    }
  }
  return blocks.length ? blocks : [{ kind: 'p', text: body }];
}

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
      blocks: bodyBlocks(d.body),
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
