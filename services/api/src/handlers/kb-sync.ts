import type { EventBridgeEvent } from 'aws-lambda';
import { BMG_KB_OWNER } from '../ai/kb.ts';
import { kbRecord, loadFile, removeFile, syncFile } from '../ai/kb-ops.ts';
import { aiStates } from '../ai/prompts.ts';

/**
 * Keeps a knowledge base in step with its owner's files (design 10.3): a file
 * that becomes available, is shared, unshared, made private or deleted is
 * added, refreshed or removed within moments. Nothing happens for artists
 * without AI (they have no knowledge base).
 */
type FileEvent = { fileId: string; artistId?: string; library?: boolean };

export async function handler(event: EventBridgeEvent<string, FileEvent>) {
  const { fileId, artistId, library } = event.detail;
  if (!fileId) return;
  const owner = library ? BMG_KB_OWNER : artistId;
  if (!owner) return;
  if (owner !== BMG_KB_OWNER && !(await aiStates([owner]))[owner]) return;
  const rec = await kbRecord(owner);
  if (!rec) return;
  if (event['detail-type'] === 'file.delete') return removeFile(fileId, rec);
  const f = await loadFile(owner, fileId);
  if (!f) return removeFile(fileId, rec);
  await syncFile(f, rec);
}
