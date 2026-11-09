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
  /**
   * BMG's own org content: shared library, events, newsroom draft. `normal`
   * items are for every artist; `bmg-only` items can still be shared with
   * named artists (per-file sharing in the document library).
   */
  | {
      kind: 'org-shared';
      visibility: Exclude<Visibility, 'private'>;
      sharedWithArtistIds?: readonly string[];
    }
  /** Billing, settings, connectors, user management. */
  | { kind: 'org-admin' }
  /**
   * AI prompts (design 10.6): BMG staff can read them and save drafts; only an
   * admin (fresh step-up) publishes or rolls back.
   */
  | { kind: 'ai-prompt' }
  | {
      kind: 'conversation';
      /** artist-to-artist chats stay private to their members (design 6.3). */
      type: 'bmg-artist' | 'group' | 'broadcast' | 'artist-to-artist';
      participantSubs: readonly string[];
    }
  /**
   * The shared contacts and venues list (rev 7). Everyone signed in can read
   * it and add to it; artists can change only the entries they added.
   * `createdBySub` is absent when the entry is being created.
   */
  | { kind: 'address-book'; createdBySub?: string }
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

    case 'ai-prompt':
      if (principal.role === 'artist') return deny('AI prompts are managed by Blueprint');
      return action === 'admin' && principal.role !== 'bmg-admin'
        ? deny('only admins publish prompts')
        : allow('BMG reads and drafts prompts');

    case 'org-shared':
      if (principal.role === 'bmg-admin' || principal.role === 'bmg-staff') {
        return allow('BMG staff see shared org content');
      }
      if (action !== 'read') return deny('artists cannot change org content');
      if (
        !!principal.artistId &&
        (resource.sharedWithArtistIds ?? []).includes(principal.artistId)
      ) {
        return allow('shared with this artist');
      }
      if (resource.visibility === 'bmg-only') return deny('BMG-only item');
      return allow('artists can read shared org content');

    case 'conversation': {
      const member = resource.participantSubs.includes(principal.sub);
      if (resource.type === 'artist-to-artist') {
        return member ? allow('chat member') : deny('artist-to-artist chats are private');
      }
      if (member) return allow('chat member');
      if (principal.role === 'bmg-admin') return allow('BMG admin sees BMG chats');
      return deny('not in this conversation');
    }

    case 'address-book':
      if (principal.role === 'bmg-admin' || principal.role === 'bmg-staff') {
        return allow('BMG manages contacts and venues');
      }
      if (action === 'read') return allow('artists can pick from contacts and venues');
      if (action === 'admin') return deny('only Blueprint manages contacts and venues');
      if (resource.createdBySub === undefined) return allow('artists can add contacts and venues');
      return resource.createdBySub === principal.sub
        ? allow('artist added this entry')
        : deny('artists can only change entries they added');

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
