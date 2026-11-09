import type { EventBridgeEvent } from 'aws-lambda';
import { projectAiState } from '../ai/state.ts';

/**
 * Keeps each artist's current AI choice in step with the consent ledger, from
 * `consent.aiChanged` (design 10.4). The assistant, its tools and the roster
 * read it; the knowledge-base purge listens to the same event.
 */
export async function handler(
  event: EventBridgeEvent<
    'consent.aiChanged',
    { artistId: string; aiOptIn: boolean; decidedAt: string }
  >,
) {
  const { artistId, aiOptIn, decidedAt } = event.detail;
  if (typeof aiOptIn !== 'boolean' || typeof decidedAt !== 'string') return;
  await projectAiState(artistId, aiOptIn, decidedAt);
}
