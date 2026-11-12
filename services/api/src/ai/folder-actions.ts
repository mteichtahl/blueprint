import { foldersPath, type Action } from '@bmg/prompts/actions';

/** One API call an action makes (see `stepsFor` in handlers/ai-actions.ts). */
export type Step = { method: string; path: string; body: unknown };

/**
 * P6 for the assistant: what a move or an access change would do, worked out
 * by the API's own preview (no change made), so the checklist can say who
 * gains and who loses access before "Do it".
 */
export function previewStep(action: Action): Step | undefined {
  if (action.type === 'moveItems') {
    return {
      method: 'POST',
      path: `${foldersPath(action.space)}/move`,
      body: { items: action.items, to: action.to, preview: true },
    };
  }
  if (action.type === 'setAccess') {
    return {
      method: 'PUT',
      path: `${foldersPath(action.space)}/access`,
      body: { item: action.item, grants: action.grants, preview: true },
    };
  }
  return undefined;
}

/** "Sam Lee gains access to 3 items · Chloe Poli loses access to 1" (or nothing changes). */
export function effectText(summary: {
  changes?: { name: string; gains: number; loses: number }[];
}): string {
  const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
  const lines = (summary.changes ?? []).flatMap((c) => [
    ...(c.gains ? [`${c.name} gains access to ${items(c.gains)}`] : []),
    ...(c.loses ? [`${c.name} loses access to ${items(c.loses)}`] : []),
  ]);
  return lines.length ? lines.join(' · ') : 'Nobody gains or loses access';
}
