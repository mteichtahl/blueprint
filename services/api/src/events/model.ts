/**
 * Gigs & events (design 7.1 "Gigs & events"; screens: workspace Gigs tab,
 * artist My gigs / Plan a gig, BMG Events / Mixer Night). Pure: keys,
 * schemas and the small rules, unit-tested.
 *
 * - Gigs belong to an artist. Artists plan their own and choose whether to
 *   share each one with Blueprint; BMG can add gigs for an artist. An artist
 *   can ask Blueprint for help on a gig.
 * - Events are BMG-only (the Mixer Night and later workshops): tickets,
 *   a separate comps guest list, speakers, crew, run sheet and budget.
 */
import { z } from 'zod';

// ── Gigs ──────────────────────────────────────────────────────────────────
export const GIG_STATUSES = [
  'idea',
  'pitching',
  'confirmed',
  'booked',
  'played',
  'cancelled',
] as const;
/**
 * The deal on a gig. `tbc` is "not set yet" (the default); `other` comes with
 * the user's own description in `dealNote` (rev 7).
 */
export const GIG_DEALS = ['tbc', 'free', 'fee', 'door-split', 'ticketed', 'other'] as const;
export type GigDeal = (typeof GIG_DEALS)[number];

/** The deal note only belongs to "Other": it's kept for Other and dropped for the rest. */
export function dealNoteFor(deal: GigDeal, note: string | undefined): string | undefined {
  return deal === 'other' && note?.trim() ? note.trim() : undefined;
}
/** What an artist can ask Blueprint to help with on a gig (Plan a gig). */
export const HELP_TOPICS = ['pitch', 'budget', 'promo', 'setlist'] as const;

export interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
}

export interface Gig {
  gigId: string;
  artistId: string;
  title: string;
  date: string;
  /** 'HH:MM'. End before start means the gig runs past midnight. */
  startTime?: string;
  endTime?: string;
  /** Older gigs stored a single start time here; read as startTime. */
  time?: string;
  venue?: string;
  /** Set when the venue was picked from the venues list (the name is kept too). */
  venueId?: string;
  notes?: string;
  status: (typeof GIG_STATUSES)[number];
  deal: (typeof GIG_DEALS)[number];
  dealNote?: string;
  checklist: ChecklistItem[];
  plannedBy: 'artist' | 'bmg';
  /** Artist gigs are only visible to Blueprint once shared. */
  shared: boolean;
  /** Removed in rev 7 (set duration). Older gigs may still hold it; never returned. */
  setLength?: string;
  ticketUrl?: string;
  /** Tickets sold, takings and costs; absent until someone enters figures. */
  money?: Money;
  help?: {
    text: string;
    topics: (typeof HELP_TOPICS)[number][];
    askedAt: string;
    status: 'open' | 'done';
    doneAt?: string;
  };
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

// ── Money: tickets, takings, costs and profit (rev 7) ────────────────────
/** The cost rows every gig starts with; any can be deleted and more added. */
export const PRESET_COSTS = [
  'Venue',
  'Photography',
  'Videography',
  'Content',
  'Support band',
  'Backing band',
] as const;

const cents = z.number().int().min(0).max(100_000_000);
export const CostRow = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().trim().min(1, 'Name the cost').max(60),
  amountCents: cents.default(0),
});
export const Money = z
  .object({
    ticketsSold: z.number().int().min(0).max(1_000_000).default(0),
    takingsCents: cents.default(0),
    costs: z.array(CostRow).max(40).default([]),
  })
  .strict()
  .refine(
    (m) => new Set(m.costs.map((c) => c.id)).size === m.costs.length,
    'Each cost needs its own id',
  );
export type Money = z.infer<typeof Money>;

/** A gig with no figures yet shows the preset cost rows at $0. */
export const defaultMoney = (): Money => ({
  ticketsSold: 0,
  takingsCents: 0,
  costs: PRESET_COSTS.map((label, i) => ({ id: `p${i + 1}`, label, amountCents: 0 })),
});

/** Profit = total takings − total costs (negative is a loss). */
export function moneySummary(m: Pick<Money, 'ticketsSold' | 'takingsCents' | 'costs'>) {
  const costsCents = m.costs.reduce((n, c) => n + c.amountCents, 0);
  const profitCents = m.takingsCents - costsCents;
  return {
    costsCents,
    profitCents,
    perTicketCents: m.ticketsSold > 0 ? Math.round(m.takingsCents / m.ticketsSold) : null,
  };
}

export const gigSk = (id: string) => `GIG#${id}`;
/** GSI3: every shared gig across artists by date, for BMG's "Artist gigs". */
export const GIGS_GSI3PK = 'GIGS';
export const gigGsi3Sk = (g: Pick<Gig, 'date' | 'artistId' | 'gigId'>) =>
  `${g.date}#${g.artistId}#${g.gigId}`;

const IsoDate = z.iso.date('Use a date like 2026-12-11');
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 19:30');
const Text = (max: number) => z.string().trim().max(max);
const Checklist = z
  .array(
    z.object({
      id: z.string().min(1).max(40),
      title: z.string().trim().min(1).max(120),
      done: z.boolean().default(false),
    }),
  )
  .max(30);

/** A new gig starts with the checklist from the design (hold date, pitch, budget, promo). */
export const DEFAULT_CHECKLIST = [
  'Hold the date with the venue',
  'Send pitch email',
  'Break-even budget',
  'Promo posts (3)',
];

/**
 * Start and end times (rev 7). An end earlier than the start is the next
 * morning (a late gig); the same time twice is a mistake.
 */
export function checkTimes(start: string | null | undefined, end: string | null | undefined) {
  if (end && !start) return 'Add a start time too';
  if (start && end && start === end) return 'The end time must be after the start time';
  return undefined;
}
export const crossesMidnight = (start?: string, end?: string) => !!start && !!end && end < start;
/** Minutes from start to end, rolling past midnight. */
export function durationMinutes(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return (m(end) - m(start) + 24 * 60) % (24 * 60) || undefined;
}

export const GigCreate = z.object({
  title: z.string().trim().min(1, 'Name the gig').max(120),
  date: IsoDate,
  startTime: Time.optional(),
  endTime: Time.optional(),
  venue: Text(160).optional(),
  venueId: z
    .string()
    .regex(/^[a-z0-9]{10,40}$/)
    .optional(),
  notes: Text(2000).optional(),
  status: z.enum(GIG_STATUSES).default('idea'),
  deal: z.enum(GIG_DEALS).default('tbc'),
  /** Free text describing an "Other" deal. */
  dealNote: Text(300).optional(),
  ticketUrl: z
    .url({ protocol: /^https$/ })
    .max(500)
    .optional(),
  shared: z.boolean().default(true),
});

export const GigPatch = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    date: IsoDate.optional(),
    startTime: Time.nullable().optional(),
    endTime: Time.nullable().optional(),
    venue: Text(160).optional(),
    /** null: the venue was typed in, not picked from the list. */
    venueId: z
      .string()
      .regex(/^[a-z0-9]{10,40}$/)
      .nullable()
      .optional(),
    notes: Text(2000).optional(),
    status: z.enum(GIG_STATUSES).optional(),
    deal: z.enum(GIG_DEALS).optional(),
    dealNote: Text(300).optional(),
    ticketUrl: z
      .url({ protocol: /^https$/ })
      .max(500)
      .optional(),
    shared: z.boolean().optional(),
    checklist: Checklist.optional(),
    money: Money.optional(),
    /** Ask Blueprint for help (artist): what with, and a note. Opens a request. */
    askHelp: z
      .object({
        topics: z.array(z.enum(HELP_TOPICS)).max(HELP_TOPICS.length).default([]),
        text: z.string().trim().max(1000).default(''),
      })
      .refine((h) => h.topics.length > 0 || h.text.length > 0, 'Say what you need help with')
      .optional(),
    /** Close the help request (BMG or artist). */
    helpDone: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/** What each side may change. Returns a reason when refused. */
export function gigPatchAllowed(
  role: 'artist' | 'bmg-admin' | 'bmg-staff',
  gig: Pick<Gig, 'plannedBy' | 'help'>,
  patch: z.infer<typeof GigPatch>,
): string | undefined {
  if (patch.askHelp !== undefined && role !== 'artist') return 'Only the artist asks for help';
  if (patch.shared === false && gig.plannedBy === 'bmg') return 'Gigs Blueprint added stay shared';
  if (patch.shared !== undefined && role !== 'artist')
    return 'Only the artist decides what to share';
  if (patch.helpDone && gig.help?.status !== 'open') return 'There is no open help request';
  return undefined;
}

export type GigFilter = 'upcoming' | 'past' | 'help';
export function gigMatches(
  g: Pick<Gig, 'date' | 'status' | 'help'>,
  filter: GigFilter,
  today: string,
) {
  if (filter === 'help') return g.help?.status === 'open';
  const past = g.date < today || g.status === 'played' || g.status === 'cancelled';
  return filter === 'past' ? past : !past;
}

// ── Events (BMG only) ────────────────────────────────────────────────────
export const EVENTS_PK = 'ORG#events';
export const eventSk = (id: string) => `EVENT#${id}`;
export const eventPk = (id: string) => `EVENT#${id}`;
export const EVENT_PARTS = ['guests', 'speakers', 'crew', 'run', 'budget'] as const;
export type EventPart = (typeof EVENT_PARTS)[number];
export const partSk = (part: EventPart, id: string) => `${part.toUpperCase()}#${id}`;

export const EventBody = z.object({
  name: z.string().trim().min(1, 'Name the event').max(120),
  date: IsoDate,
  /** 'HH:MM'; required for new events (EventCreate). Older events may lack them. */
  startTime: Time.optional(),
  endTime: Time.optional(),
  venue: Text(200).default(''),
  /** Set when the venue was picked from the venues list. */
  venueId: z
    .string()
    .regex(/^[a-z0-9]{10,40}$/)
    .optional(),
  capacity: z.number().int().min(0).max(100000).default(0),
  ticketTarget: z.number().int().min(0).max(100000).default(0),
  ticketPriceCents: z.number().int().min(0).max(10_000_000).default(0),
  /** Until the Humanitix connector is on, ticket sales are typed in. */
  ticketsSold: z.number().int().min(0).max(100000).default(0),
  /** Total event takings (rev 7); profit = takings − what the budget rows spent. */
  takingsCents: z.number().int().min(0).max(100_000_000).default(0),
  compsTarget: z.number().int().min(0).max(10000).default(0),
  surveyAfter: z.boolean().default(true),
  /** Set when the Humanitix connector links this event. */
  humanitixEventId: Text(100).optional(),
});
/**
 * A patch schema: every field optional and defaults dropped, so a patch only
 * ever carries what the caller sent (`.partial()` would fill in defaults).
 */
export function patchOf(schema: { shape: Record<string, z.ZodType> }) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([k, f]): [string, z.ZodType] => [
      k,
      (f instanceof z.ZodDefault ? (f.unwrap() as z.ZodType) : f).optional(),
    ]),
  );
  return z
    .object(shape)
    .strict()
    .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');
}

export const EventPatch = patchOf(EventBody);

/** Events must have a start and an end time (rev 7). */
const RequiredTime = (what: string) =>
  z
    .string({
      error: (iss) => (iss.input === undefined ? `Add the ${what}` : 'Use a time like 19:30'),
    })
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 19:30');
export const EventCreate = EventBody.extend({
  startTime: RequiredTime('start time'),
  endTime: RequiredTime('end time'),
}).refine((e) => !checkTimes(e.startTime, e.endTime), {
  message: 'The end time must be after the start time',
});

const money = z.number().int().min(0).max(100_000_000);
/** Each part of an event, validated on create; patches accept the same fields, all optional. */
export const PART_SCHEMAS = {
  guests: z.object({
    name: z.string().trim().min(1).max(120),
    type: Text(80).default(''),
    email: z.email().optional(),
    status: z.enum(['invited', 'accepted', 'declined']).default('invited'),
    fromOutreach: z.boolean().default(false),
  }),
  speakers: z.object({
    name: z.string().trim().min(1).max(120),
    role: Text(120).default(''),
    status: z.enum(['waiting', 'confirmed', 'declined']).default('waiting'),
  }),
  crew: z.object({
    role: z.string().trim().min(1).max(120),
    needed: z.number().int().min(0).max(100).default(1),
    filled: z.number().int().min(0).max(100).default(0),
    names: Text(300).default(''),
  }),
  run: z.object({
    time: Time,
    item: z.string().trim().min(1).max(200),
    who: Text(120).default(''),
  }),
  budget: z.object({
    item: z.string().trim().min(1).max(120),
    budgetCents: money.default(0),
    spentCents: money.default(0),
    inKind: z.boolean().default(false),
  }),
} as const;

export interface EventSummary {
  ticketsSold: number;
  ticketTarget: number;
  compsAccepted: number;
  compsTarget: number;
  inRoom: number;
  capacity: number;
  budgetCents: number;
  spentCents: number;
  ticketIncomeCents: number;
  /** Total takings entered for the event (rev 7). */
  takingsCents: number;
  /** Takings − spent (the budget rows' actual costs). Negative is a loss. */
  profitCents: number;
  crewFilled: number;
  crewNeeded: number;
  speakersConfirmed: number;
  speakers: number;
}

/** The four headline cards (tickets, comps, in the room, budget) plus crew and speakers. */
export function summarise(
  e: z.infer<typeof EventBody>,
  parts: {
    guests: { status: string }[];
    speakers: { status: string }[];
    crew: { needed: number; filled: number }[];
    budget: { budgetCents: number; spentCents: number }[];
  },
): EventSummary {
  const compsAccepted = parts.guests.filter((g) => g.status === 'accepted').length;
  return {
    ticketsSold: e.ticketsSold,
    ticketTarget: e.ticketTarget,
    compsAccepted,
    compsTarget: e.compsTarget,
    inRoom: e.ticketsSold + compsAccepted,
    capacity: e.capacity,
    budgetCents: parts.budget.reduce((n, b) => n + b.budgetCents, 0),
    spentCents: parts.budget.reduce((n, b) => n + b.spentCents, 0),
    ticketIncomeCents: e.ticketsSold * e.ticketPriceCents,
    takingsCents: e.takingsCents,
    profitCents: e.takingsCents - parts.budget.reduce((n, b) => n + b.spentCents, 0),
    crewFilled: parts.crew.reduce((n, c) => n + Math.min(c.filled, c.needed), 0),
    crewNeeded: parts.crew.reduce((n, c) => n + c.needed, 0),
    speakersConfirmed: parts.speakers.filter((s) => s.status === 'confirmed').length,
    speakers: parts.speakers.length,
  };
}

/** Run sheet rows sort by time. */
export const byTime = (a: { time: string }, b: { time: string }) => a.time.localeCompare(b.time);
