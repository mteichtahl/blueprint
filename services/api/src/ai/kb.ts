import type { Principal } from '@bmg/authz';
import type { FileRecord } from '../files/model.ts';

/**
 * Knowledge bases (design 10.3): one per opted-in artist plus one for BMG.
 * Pure helpers, so the rules are unit-tested.
 *
 * Documents are pushed in by our own code (a CUSTOM data source), read through
 * the same KMS-enforced paths the app uses. Bedrock never reads the file
 * buckets, so it needs no access to any artist key.
 */

/** `ARTIST#<id> / KB`: the artist's knowledge base, data source and vector index. */
export const KB_SK = 'KB';
export const BMG_KB_OWNER = 'bmg';

export interface KbRecord {
  owner: string;
  knowledgeBaseId: string;
  dataSourceId: string;
  indexName: string;
  createdAt: string;
}

/** Names Bedrock and S3 Vectors accept, unique per environment. */
export const kbName = (project: string, env: string, owner: string) =>
  `${project}-${env}-${owner.replace(/_/g, '-')}`;
export const indexName = (owner: string) => `kb-${owner.replace(/_/g, '-')}`;

/** Embedding model in Sydney (Titan Text Embeddings V2, 1024 dimensions). */
export const EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
export const EMBEDDING_DIMENSIONS = 1024;

/** File types Bedrock can parse, and the largest we send inline. */
const INGESTABLE = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

export type IngestDecision = { ingest: true } | { ingest: false; reason: string };

/**
 * Whether a file belongs in its owner's knowledge base. Private items never go
 * in (the KMS policy wouldn't let a non-artist session read them anyway), so
 * no knowledge base can ever return them to Blueprint.
 */
export function ingestDecision(
  f: Pick<FileRecord, 'status' | 'visibility' | 'contentType' | 'size'>,
): IngestDecision {
  if (f.status !== 'available') return { ingest: false, reason: 'not available' };
  if (f.visibility === 'private') return { ingest: false, reason: 'private' };
  if (!INGESTABLE.has(f.contentType)) return { ingest: false, reason: 'not a document' };
  if (f.size > MAX_INLINE_BYTES) return { ingest: false, reason: 'too large' };
  return { ingest: true };
}

/** Metadata stored with every chunk; retrieval filters use `visibility`. */
export function docAttributes(f: Pick<FileRecord, 'fileId' | 'name' | 'visibility'>) {
  return [
    { key: 'sourceId', value: { type: 'STRING' as const, stringValue: f.fileId } },
    { key: 'fileName', value: { type: 'STRING' as const, stringValue: f.name.slice(0, 200) } },
    {
      key: 'visibility',
      value: { type: 'STRING' as const, stringValue: f.visibility ?? 'normal' },
    },
  ];
}

/**
 * The retrieval filter, always set by server code and never by the model.
 * An artist's own assistant never sees Blueprint-only items in their workspace.
 */
export function retrievalFilter(role: Principal['role']) {
  return role === 'artist' ? { notEquals: { key: 'visibility', value: 'bmg-only' } } : undefined;
}

/** What reconciliation must do to make knowledge bases match consent (design 10.4). */
export function reconcilePlan(optedIn: Set<string>, haveKb: Set<string>) {
  return {
    create: [...optedIn].filter((a) => !haveKb.has(a)).sort(),
    purge: [...haveKb].filter((a) => !optedIn.has(a)).sort(),
  };
}
