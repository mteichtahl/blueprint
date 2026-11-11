import { createHash } from 'node:crypto';
import type { Person } from '../files/people.ts';
import type { Todo } from './model.ts';
import type { PlanChange } from './plan-history.ts';

/**
 * Plan owner (rev 12): every artist plan has one Blueprint owner. Pure rules,
 * unit-tested; the workspace handler loads the people and to-dos.
 */

/** What the app shows for an owner: name and job title. */
export interface OwnerView {
  sub: string;
  displayName: string;
  jobTitle: string;
}

type Who = Pick<Person, 'role' | 'assignedArtistIds'>;

/**
 * Who can own an artist's plan: a Blueprint admin, or staff assigned to that
 * artist (staff can't see artists they aren't assigned to). Artists can't.
 */
export function canOwnPlan(p: Who | undefined, artistId: string): boolean {
  if (!p) return false;
  if (p.role === 'bmg-admin') return true;
  return p.role === 'bmg-staff' && (p.assignedArtistIds ?? []).includes(artistId);
}

export const ownerView = (p: Person): OwnerView => ({
  sub: p.sub,
  displayName: p.displayName,
  jobTitle: p.jobTitle,
});

/** Everyone who could own this artist's plan, by name. */
export function ownerCandidates(people: readonly Person[], artistId: string): OwnerView[] {
  return people
    .filter((p) => canOwnPlan(p, artistId))
    .map(ownerView)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * The plan's owner as shown, and whether it needs one: no owner yet (plans
 * from before rev 12), or the owner left or was unassigned from the artist.
 */
export function ownerStatus(
  ownerSub: string | undefined,
  people: readonly Person[],
  artistId: string,
): { owner: OwnerView | null; ownerNeeded: boolean } {
  const p = ownerSub ? people.find((x) => x.sub === ownerSub) : undefined;
  if (!p) return { owner: null, ownerNeeded: true };
  return { owner: ownerView(p), ownerNeeded: !canOwnPlan(p, artistId) };
}

/**
 * The to-dos that move to a new owner: open ones looked after by the previous
 * owner, or by nobody yet (to-dos from before rev 12). Done to-dos stay with
 * whoever finished them.
 */
export function movesWithOwner(
  todo: Pick<Todo, 'done' | 'bmgOwnerSub'>,
  previousOwnerSub: string | undefined,
): boolean {
  if (todo.done) return false;
  return !todo.bmgOwnerSub || todo.bmgOwnerSub === previousOwnerSub;
}

/**
 * The history line for an owner change, e.g. "Changed the plan owner from
 * Kyra to Sam". Artists read the history, so it doesn't count the to-dos
 * that moved (some may be BMG-only); the owners' notices do.
 */
export function ownerChangeLine(from: string | undefined, to: string): string {
  return from ? `Changed the plan owner from ${from} to ${to}` : `Set the plan owner to ${to}`;
}

/** Plan, history entry and to-dos go in one transaction (DynamoDB allows 100 items). */
export const MAX_TODOS_IN_MOVE = 98;

/**
 * Plan update notifications are rolled up per person (rev 12): the first
 * save starts a 10-minute window, and one notification lists everything
 * that person changed in it.
 */
export const PLAN_DIGEST_MINUTES = 10;

/** One pending roll-up per artist and editor; Scheduler names are limited to 64 characters. */
export const planDigestScheduleName = (artistId: string, bySub: string) =>
  `plan-${createHash('sha256').update(`${artistId}:${bySub}`).digest('hex').slice(0, 40)}`;

/** The roll-up's lines: this editor's saves in the window, oldest first, without meeting updates (already told). */
export function digestLines(
  entries: readonly Pick<PlanChange, 'at' | 'bySub' | 'kind' | 'changes'>[],
  bySub: string,
  max = 10,
): { lines: string[]; more: number } {
  const all = [...entries]
    .filter((e) => e.bySub === bySub && e.kind !== 'meeting' && e.kind !== 'undone')
    .sort((a, b) => a.at.localeCompare(b.at))
    .flatMap((e) => e.changes);
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}
