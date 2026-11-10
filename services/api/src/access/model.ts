import { z } from 'zod';

/**
 * Access & permissions (screens doc "Artists & access", canvas X-Artists
 * "What artists can see and do"): the org-wide switches for what artist
 * accounts may do, and the Blueprint team. Settings live at
 * `ORG#access / SETTINGS`; the team is the Cognito bmg-admin and bmg-staff
 * groups, with names and job titles at `USER#<sub> / PROFILE` and staff
 * assignments at `STAFF#<sub> / ASSIGNMENTS`.
 */

export const ACCESS_KEY = { PK: 'ORG#access', SK: 'SETTINGS' } as const;

/** The switches on the canvas. Everything else in that panel is fixed by design. */
export interface AccessRules {
  /** Artists can message other Blueprint artists directly (private to them). */
  artistDirectChats: boolean;
  /** Artists can start their own group chats with other artists (Blueprint is in them, like every group). */
  artistGroups: boolean;
  /** Artists can share their gigs (gig cards) in chats with other artists. */
  artistGigSharing: boolean;
}

/** Defaults from the canvas: direct chats on, artist groups off, gig sharing on. */
export const DEFAULT_RULES: AccessRules = {
  artistDirectChats: true,
  artistGroups: false,
  artistGigSharing: true,
};

export const SettingsBody = z
  .object({
    /** The version you edited, so two admins can't silently overwrite each other. */
    version: z.number().int().min(0),
    artistDirectChats: z.boolean(),
    artistGroups: z.boolean(),
    artistGigSharing: z.boolean(),
  })
  .strict();

export function rulesFrom(item: Record<string, unknown> | undefined): AccessRules {
  const pick = (k: keyof AccessRules) =>
    typeof item?.[k] === 'boolean' ? (item[k] as boolean) : DEFAULT_RULES[k];
  return {
    artistDirectChats: pick('artistDirectChats'),
    artistGroups: pick('artistGroups'),
    artistGigSharing: pick('artistGigSharing'),
  };
}

// ── Blueprint team ────────────────────────────────────────────────────────
export const TEAM_ROLES = ['bmg-admin', 'bmg-staff'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

const ArtistIds = z
  .array(z.string().regex(/^art_[a-z0-9]{10,32}$/))
  .max(200)
  .transform((ids) => [...new Set(ids)].sort());

export const TeamInvite = z
  .object({
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(TEAM_ROLES),
    jobTitle: z.string().trim().max(80).default(''),
    /** Staff only: the artists they work with. Admins see every artist. */
    artistIds: ArtistIds.default([]),
  })
  .strict();

export const TeamPatch = z
  .object({
    role: z.enum(TEAM_ROLES).optional(),
    artistIds: ArtistIds.optional(),
    jobTitle: z.string().trim().max(80).optional(),
    /** False turns their login off (and signs them out everywhere); true turns it back on. */
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export interface TeamMember {
  sub: string;
  email: string;
  displayName: string;
  jobTitle: string;
  role: TeamRole;
  enabled: boolean;
  /** Cognito's status: FORCE_CHANGE_PASSWORD means invited but not signed in yet. */
  status: string;
  artistIds: string[];
  createdAt: string | null;
}

/**
 * Changes an admin may not make, whatever they are allowed to do otherwise:
 * nothing that locks Blueprint out of its own app.
 */
export function teamChangeRefused(
  actorSub: string,
  target: Pick<TeamMember, 'sub' | 'role' | 'enabled'>,
  patch: z.infer<typeof TeamPatch>,
  enabledAdmins: number,
): string | null {
  const self = actorSub === target.sub;
  if (self && patch.enabled === false) return 'You can’t turn off your own login';
  if (self && patch.role && patch.role !== target.role) return 'You can’t change your own role';
  const losesAdmin =
    target.role === 'bmg-admin' &&
    target.enabled &&
    ((patch.role !== undefined && patch.role !== 'bmg-admin') || patch.enabled === false);
  if (losesAdmin && enabledAdmins <= 1) return 'Blueprint needs at least one admin';
  return null;
}
