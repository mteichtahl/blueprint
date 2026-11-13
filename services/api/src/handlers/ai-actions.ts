import { KMSClient, VerifyMacCommand } from '@aws-sdk/client-kms';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { actionsHash, ActionList, foldersPath, type Action } from '@bmg/prompts/actions';
import { z } from 'zod';
import type { Step } from '../ai/folder-actions.ts';
import { checkClaims, claimsBytes, decodeToken, jtiKey } from '../ai/model.ts';
import { audit, authContext, db, env, handle, HttpError, json, parseBody } from '../lib.ts';

/**
 * POST /ai/actions/confirm (design 10.2): the person tapped "Do it". The token
 * must be the one issued with this exact checklist, to this person, less than
 * 60 seconds ago, and unused. Each action is then carried out through the
 * normal API with the person's own token, so it is authorised exactly as if
 * they had done it by hand. The agent is never involved.
 */

const kms = new KMSClient({});
const ConfirmBody = z
  .object({
    actions: ActionList,
    actionToken: z.string().max(2000),
    /** Which of the proposed actions the person kept ticked (default: all). */
    selected: z.array(z.number().int().min(0).max(9)).max(10).optional(),
  })
  .strict();

/** The API calls each action makes, in order. */
export function stepsFor(action: Action, role: string): Step[] {
  switch (action.type) {
    case 'createTodo':
      return [
        {
          method: 'POST',
          path: `/artists/${action.artistId}/todos`,
          body: {
            title: action.title,
            ...(action.notes ? { notes: action.notes } : {}),
            ...(action.due ? { due: action.due } : {}),
            // Rev 15: an artist's to-do for their plan owner.
            ...(action.forPlanOwner && role === 'artist' ? { for: 'planOwner' } : {}),
          },
        },
      ];
    case 'sendMessage':
      return [
        {
          method: 'POST',
          path: '/conversations',
          // An artist's assistant messages Blueprint; Blueprint's messages the named
          // artist, or a team member in their direct team chat (rev 14). The API
          // refuses team chats for artists and anyone not on the team.
          body:
            action.staffSub && role !== 'artist'
              ? { kind: 'direct', staffSub: action.staffSub }
              : {
                  kind: 'direct',
                  ...(role !== 'artist' || action.artistId ? { artistId: action.artistId } : {}),
                },
        },
        {
          method: 'POST',
          path: '/conversations/{conversationId}/messages',
          body: { text: action.text },
        },
      ];
    case 'updateSubmissionPriority':
      return [
        {
          method: 'PATCH',
          path: `/artists/${action.artistId}/submissions/${encodeURIComponent(action.submissionId)}`,
          body: { priority: action.priority },
        },
      ];
    // Folder actions (rev 10): the folder routes, exactly as the screens call them.
    case 'createFolder':
      return [
        {
          method: 'POST',
          path: foldersPath(action.space),
          body: { name: action.name, parentId: action.parentId ?? null },
        },
      ];
    case 'renameFolder':
      return [
        {
          method: 'PATCH',
          path: `${foldersPath(action.space)}/${action.folderId}`,
          body: { name: action.name },
        },
      ];
    case 'moveItems':
      return [
        {
          method: 'POST',
          path: `${foldersPath(action.space)}/move`,
          body: { items: action.items, to: action.to },
        },
      ];
    case 'copyItems':
      return [
        {
          method: 'POST',
          path: `${foldersPath(action.space)}/copy`,
          body: { items: action.items, to: action.to },
        },
      ];
    case 'setAccess':
      return [
        {
          method: 'PUT',
          path: `${foldersPath(action.space)}/access`,
          body: { item: action.item, grants: action.grants },
        },
      ];
  }
}

export const handler = handle(async (event) => {
  const ctx = authContext(event);
  if (!ctx.mfaSatisfied) throw new HttpError(403, 'two-step verification required');
  const { actions, actionToken, selected } = parseBody(event, ConfirmBody);

  // The token covers the whole checklist; the person may untick some of it.
  const chosen = selected ? actions.filter((_, i) => selected.includes(i)) : actions;
  if (chosen.length === 0) throw new HttpError(400, 'Nothing was ticked');

  const decoded = decodeToken(actionToken);
  if (!decoded)
    throw new HttpError(400, 'This checklist is no longer valid. Ask the assistant again.');
  const reason = checkClaims(decoded.claims, {
    sub: ctx.sub,
    hash: actionsHash(actions),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (reason) {
    await audit(event, 'ai.actionsConfirmed', 'denied', { reason });
    throw new HttpError(403, reason);
  }
  const verified = await kms
    .send(
      new VerifyMacCommand({
        KeyId: env('ACTION_KEY_ID'),
        MacAlgorithm: 'HMAC_SHA_256',
        Message: claimsBytes(decoded.claims),
        Mac: decoded.mac,
      }),
    )
    .catch(() => ({ MacValid: false }));
  if (!verified.MacValid) {
    await audit(event, 'ai.actionsConfirmed', 'denied', { reason: 'bad token' });
    throw new HttpError(403, 'This checklist is no longer valid. Ask the assistant again.');
  }
  // Single use.
  try {
    await db.send(
      new PutCommand({
        TableName: env('MAIN_TABLE'),
        Item: {
          ...jtiKey(decoded.claims.jti),
          type: 'aiActionToken',
          ttl: decoded.claims.exp + 3600,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      throw new HttpError(409, 'This checklist was already done.');
    }
    throw err;
  }

  const auth = event.headers?.Authorization ?? event.headers?.authorization ?? '';
  const base = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const results: { summary: string; ok: boolean; error?: string }[] = [];
  for (const action of chosen) {
    let vars: Record<string, string> = {};
    let ok = true;
    let error: string | undefined;
    for (const step of stepsFor(action, ctx.role)) {
      const path = step.path.replace(/\{(\w+)\}/g, (_, k: string) =>
        encodeURIComponent(vars[k] ?? ''),
      );
      const res = await fetch(`${base}${path}`, {
        method: step.method,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(step.body),
        signal: AbortSignal.timeout(8000),
      });
      const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        ok = false;
        error = String(out.detail ?? out.title ?? 'Not allowed');
        break;
      }
      vars = {
        ...vars,
        ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, String(v)])),
      };
    }
    results.push({ summary: action.summary, ok, ...(error ? { error } : {}) });
  }
  await audit(event, 'ai.actionsConfirmed', 'success', {
    count: chosen.length,
    failed: results.filter((r) => !r.ok).length,
  });
  return json(200, { results });
});
