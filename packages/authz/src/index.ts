/**
 * Shared authorisation checks (design 6.3). Every API handler calls
 * `authorize` before touching data. It is pure and synchronous: the caller
 * passes in the verified principal (from the authorizer context, never the
 * request body) and the resource as stored.
 *
 * KMS enforces the same artist boundary underneath (design 9.1), so a bug here
 * is caught at the key; this layer gives the clear, auditable decision.
 */

export type Role = 'bmg-admin' | 'bmg-staff' | 'artist';

export interface Principal {
  sub: string;
  role: Role;
  /** Artists only: their own artist id, from the token. */
  artistId?: string;
  /** Staff only: the artists they are assigned to (from the main table). */
  assignedArtistIds?: readonly string[];
  /** True when MFA is known to be satisfied: Cognito MFA, or the app step-up for social sign-in (design 6.2). */
  mfaSatisfied: boolean;
  /** Seconds since the user last authenticated or stepped up; admin actions need ≤ 300 (design 6.3). */
  secondsSinceAuth: number;
}

export type Visibility = 'normal' | 'bmg-only' | 'private';

export type Resource =
  /** Anything inside one artist's workspace: plan, to-dos, files, gigs, stats, brand kit, knowledge base. */
  | {
      kind: 'artist-data';
      artistId: string;
      visibility: Visibility;
      /** Artist ids a BMG item has been explicitly shared with (shared library). */
      sharedWithArtistIds?: readonly string[];
    }
  /** BMG's own org content: shared library, events, newsroom draft. */
  | { kind: 'org-shared'; visibility: Exclude<Visibility, 'private'> }
  /** Billing, settings, connectors, prompts, user management. */
  | { kind: 'org-admin' }
  | {
      kind: 'conversation';
      /** artist-to-artist chats stay private to their members (design 6.3). */
      type: 'bmg-artist' | 'group' | 'broadcast' | 'artist-to-artist';
      participantSubs: readonly string[];
    }
  /** The public newsletter sign-up. */
  | { kind: 'public' };

export type Action = 'read' | 'write' | 'admin';

export interface Decision {
  allow: boolean;
  reason: string;
}

const allow = (reason: string): Decision => ({ allow: true, reason });
const deny = (reason: string): Decision => ({ allow: false, reason });

/** Fresh step-up window for admin actions: invite, role change, export, offboard (design 6.3). */
export const ADMIN_STEP_UP_SECONDS = 300;

export function authorize(
  principal: Principal | undefined,
  action: Action,
  resource: Resource,
): Decision {
  if (resource.kind === 'public') return allow('public resource');
  if (!principal) return deny('not signed in');
  if (!principal.mfaSatisfied) return deny('two-step verification required');

  if (action === 'admin') {
    if (principal.role !== 'bmg-admin') return deny('admin actions are for BMG admins');
    if (principal.secondsSinceAuth > ADMIN_STEP_UP_SECONDS) {
      return deny('admin actions need a fresh step-up');
    }
  }

  switch (resource.kind) {
    case 'org-admin':
      return principal.role === 'bmg-admin'
        ? allow('admin manages settings')
        : deny('settings and billing are admin-only');

    case 'org-shared':
      if (principal.role === 'bmg-admin' || principal.role === 'bmg-staff') {
        return allow('BMG staff see shared org content');
      }
      if (resource.visibility === 'bmg-only') return deny('BMG-only item');
      return action === 'read'
        ? allow('artists can read shared org content')
        : deny('artists cannot change org content');

    case 'conversation': {
      const member = resource.participantSubs.includes(principal.sub);
      if (resource.type === 'artist-to-artist') {
        return member ? allow('chat member') : deny('artist-to-artist chats are private');
      }
      if (member) return allow('chat member');
      if (principal.role === 'bmg-admin') return allow('BMG admin sees BMG chats');
      return deny('not in this conversation');
    }

    case 'artist-data':
      return artistData(principal, action, resource);
  }
}

function artistData(
  principal: Principal,
  action: Action,
  resource: Extract<Resource, { kind: 'artist-data' }>,
): Decision {
  if (principal.role === 'artist') {
    const own = principal.artistId === resource.artistId;
    if (own) {
      if (resource.visibility === 'bmg-only') return deny('BMG-only item');
      return action === 'admin' ? deny('admin action') : allow('own workspace');
    }
    const sharedToMe =
      !!principal.artistId && (resource.sharedWithArtistIds ?? []).includes(principal.artistId);
    if (sharedToMe && action === 'read' && resource.visibility === 'normal') {
      return allow('shared with this artist');
    }
    return deny("another artist's workspace");
  }

  // BMG roles never see items an artist marked private (also refused by KMS).
  if (resource.visibility === 'private') return deny('marked private by the artist');

  if (principal.role === 'bmg-admin') return allow('BMG admin sees all artists');

  const assigned = (principal.assignedArtistIds ?? []).includes(resource.artistId);
  if (!assigned) return deny('staff not assigned to this artist');
  return action === 'admin' ? deny('admin action') : allow('assigned staff');
}
