import type { EventBridgeEvent } from 'aws-lambda';
import { isArtistId } from '@bmg/crypto';
import { runDeletion } from '../offboarding/worker.ts';

/**
 * Deleting an artist (rev 22): `artist.deleteRequested` from the API (a new
 * deletion, or Retry on a paused one) runs the deletion to the end.
 */
export async function handler(event: EventBridgeEvent<string, { artistId?: string }>) {
  const artistId = event.detail?.artistId;
  if (!isArtistId(artistId)) return;
  await runDeletion(artistId);
}
