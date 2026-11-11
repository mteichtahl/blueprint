import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Principal } from '@bmg/authz';
import { db, env, HttpError } from '../lib.ts';
import { artistPk, newId, PLAN_SK, type Plan } from './model.ts';
import {
  changedBy,
  MAX_CHANGE_LINES,
  planChanges,
  planLogSk,
  type PlanChange,
  type PlanChangeKind,
} from './plan-history.ts';

/**
 * Saving a plan with its history entry in one transaction (rev 8), shared by
 * the plan editor and meeting plan updates (rev 11). The save only lands if
 * the plan is still on the version the change started from.
 */

const table = () => env('MAIN_TABLE');

/** A plan save lost the race (the plan's version check failed inside the transaction). */
export function planConflict(err: unknown): boolean {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  return (
    e.name === 'ConditionalCheckFailedException' ||
    (e.name === 'TransactionCanceledException' &&
      (e.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed'))
  );
}

/** One plan history entry, ready to write next to the plan. */
export async function changeEntry(
  principal: Pick<Principal, 'sub' | 'role'>,
  artistId: string,
  c: { version: number; at: string; kind: PlanChangeKind; changes: string[] },
) {
  const profile = await db.send(
    // The person's profile (USER#<sub>, see me.ts) holds their job title.
    new GetCommand({ TableName: table(), Key: { PK: `USER#${principal.sub}`, SK: 'PROFILE' } }),
  );
  const entry: PlanChange = {
    changeId: newId(),
    artistId,
    ...c,
    changes: c.changes.slice(0, MAX_CHANGE_LINES),
    bySub: principal.sub,
    byRole: principal.role,
    byName: changedBy(profile.Item?.jobTitle),
  };
  return {
    PK: artistPk(artistId),
    SK: planLogSk(c.at, entry.changeId),
    type: 'planChange',
    ...entry,
  };
}

export async function loadPlan(artistId: string): Promise<Plan | undefined> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: artistPk(artistId), SK: PLAN_SK } }),
  );
  return res.Item as Plan | undefined;
}

/**
 * Writes `content` as the plan's next version, with a history entry saying
 * what changed. `lead` lines go first in the entry (e.g. which meeting it came
 * from). 409 if someone saved in between.
 */
export async function savePlan(input: {
  principal: Pick<Principal, 'sub' | 'role'>;
  artistId: string;
  current: Plan | undefined;
  content: Pick<Plan, 'outcome' | 'measures' | 'phases'>;
  kind: PlanChangeKind;
  lead?: string[];
}): Promise<{ version: number; at: string; changes: string[] }> {
  const { principal, artistId, current } = input;
  const from = current?.version ?? 0;
  const at = new Date().toISOString();
  const next = { ...input.content, version: from + 1, updatedAt: at };
  const changes = planChanges(current, next);
  const log = changes.length
    ? await changeEntry(principal, artistId, {
        version: next.version,
        at,
        kind: current ? input.kind : 'created',
        changes: [...(input.lead ?? []), ...changes],
      })
    : undefined;
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: {
                PK: artistPk(artistId),
                SK: PLAN_SK,
                type: 'plan',
                artistId,
                ...next,
                updatedBy: principal.sub,
              },
              ConditionExpression: from === 0 ? 'attribute_not_exists(PK)' : 'version = :v',
              ...(from === 0 ? {} : { ExpressionAttributeValues: { ':v': from } }),
            },
          },
          ...(log ? [{ Put: { TableName: table(), Item: log } }] : []),
        ],
      }),
    );
  } catch (err) {
    if (planConflict(err)) {
      throw new HttpError(409, 'Someone else changed this plan. Reload and try again.');
    }
    throw err;
  }
  return { version: next.version, at, changes };
}
