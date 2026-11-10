import { randomUUID } from 'node:crypto';
import {
  BedrockAgentClient,
  CreateDataSourceCommand,
  CreateKnowledgeBaseCommand,
  DeleteDataSourceCommand,
  DeleteKnowledgeBaseCommand,
  DeleteKnowledgeBaseDocumentsCommand,
  GetKnowledgeBaseCommand,
  IngestKnowledgeBaseDocumentsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateIndexCommand, DeleteIndexCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DataAccessSessions } from '@bmg/crypto';
import { fileSk, LIBRARY_PK, storedKey, type FileRecord } from '../files/model.ts';
import { db, env } from '../lib.ts';
import {
  BMG_KB_OWNER,
  docAttributes,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  indexName,
  ingestDecision,
  KB_SK,
  kbName,
  type KbRecord,
} from './kb.ts';
import { hiddenFromBlueprint } from '../files/access.ts';
import { loadFolders } from '../files/folder-store.ts';
import { folderManaged, folderMap, type FolderMap } from '../files/folders.ts';

/**
 * Creating, filling and deleting knowledge bases (design 10.3, 10.4).
 * Documents are read through the app's own KMS-enforced paths and pushed in:
 * artist files in a data-access session tagged with a Blueprint role (so KMS
 * refuses private items), library files under the platform key.
 */

const bedrock = new BedrockAgentClient({});
const vectors = new S3VectorsClient({});
const s3 = new S3Client({});
const sessions = new DataAccessSessions();
const table = () => env('MAIN_TABLE');
const recordKey = (owner: string) =>
  owner === BMG_KB_OWNER ? { PK: 'ORG#kb', SK: KB_SK } : { PK: `ARTIST#${owner}`, SK: KB_SK };

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', event, ...fields }));

export async function kbRecord(owner: string): Promise<KbRecord | undefined> {
  const res = await db.send(new GetCommand({ TableName: table(), Key: recordKey(owner) }));
  return res.Item as KbRecord | undefined;
}

async function waitActive(knowledgeBaseId: string) {
  for (let i = 0; i < 30; i++) {
    const kb = await bedrock.send(new GetKnowledgeBaseCommand({ knowledgeBaseId }));
    const status = kb.knowledgeBase?.status;
    if (status === 'ACTIVE') return;
    if (status === 'FAILED') throw new Error('Knowledge base creation failed');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Knowledge base did not become active in time');
}

/** Creates the owner's vector index, knowledge base and data source (idempotent). */
export async function createKb(owner: string): Promise<KbRecord> {
  const existing = await kbRecord(owner);
  if (existing) return existing;
  const name = kbName(env('PROJECT'), env('BMG_ENV'), owner);
  const index = indexName(owner);
  const tags = { artistId: owner, 'bmg:env': env('BMG_ENV') };
  try {
    await vectors.send(
      new CreateIndexCommand({
        vectorBucketName: env('VECTOR_BUCKET'),
        indexName: index,
        dataType: 'float32',
        dimension: EMBEDDING_DIMENSIONS,
        distanceMetric: 'cosine',
        metadataConfiguration: {
          nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
        },
        tags,
      }),
    );
  } catch (err) {
    if ((err as Error).name !== 'ConflictException') throw err;
  }
  const region = env('AWS_REGION');
  const kb = await bedrock.send(
    new CreateKnowledgeBaseCommand({
      // Retries the same day reuse the token, so a half-finished create isn't repeated.
      clientToken: `${name}-${new Date().toISOString().slice(0, 10)}`.padEnd(33, '0'),
      name,
      description: `BMG ${env('BMG_ENV')}: knowledge base for ${owner}`,
      roleArn: env('KB_SERVICE_ROLE_ARN'),
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${region}::foundation-model/${EMBEDDING_MODEL}`,
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: `arn:aws:s3vectors:${region}:${env('ACCOUNT_ID')}:bucket/${env('VECTOR_BUCKET')}/index/${index}`,
        },
      },
      tags,
    }),
  );
  const knowledgeBaseId = kb.knowledgeBase!.knowledgeBaseId!;
  await waitActive(knowledgeBaseId);
  const ds = await bedrock.send(
    new CreateDataSourceCommand({
      knowledgeBaseId,
      name: 'pushed-documents',
      description: 'Documents pushed in by the BMG app',
      dataSourceConfiguration: { type: 'CUSTOM' },
      dataDeletionPolicy: 'DELETE',
    }),
  );
  const record: KbRecord = {
    owner,
    knowledgeBaseId,
    dataSourceId: ds.dataSource!.dataSourceId!,
    indexName: index,
    createdAt: new Date().toISOString(),
  };
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        ...recordKey(owner),
        type: 'knowledgeBase',
        ...record,
        ...(owner === BMG_KB_OWNER ? {} : { GSI1PK: 'KBS', GSI1SK: owner }),
      },
    }),
  );
  log('kb.created', { owner, knowledgeBaseId });
  return record;
}

/** Deletes the owner's knowledge base, its data and the vector index (design 10.4). */
export async function purgeKb(owner: string): Promise<void> {
  const rec = await kbRecord(owner);
  if (!rec) return;
  const ignore404 = (err: unknown) => {
    if (
      (err as Error).name !== 'ResourceNotFoundException' &&
      (err as Error).name !== 'NotFoundException'
    )
      throw err;
  };
  await bedrock
    .send(
      new DeleteDataSourceCommand({
        knowledgeBaseId: rec.knowledgeBaseId,
        dataSourceId: rec.dataSourceId,
      }),
    )
    .catch(ignore404);
  await bedrock
    .send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId: rec.knowledgeBaseId }))
    .catch(ignore404);
  await vectors
    .send(
      new DeleteIndexCommand({ vectorBucketName: env('VECTOR_BUCKET'), indexName: rec.indexName }),
    )
    .catch(ignore404);
  await db.send(new DeleteCommand({ TableName: table(), Key: recordKey(owner) }));
  log('kb.purged', { owner });
}

async function readFile(f: FileRecord): Promise<Uint8Array> {
  if (f.scope === 'library') {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: env('LIBRARY_BUCKET'), Key: storedKey('library', f.fileId) }),
    );
    return obj.Body!.transformToByteArray();
  }
  // A Blueprint-role session: KMS itself refuses private items (design 9.1).
  const credentials = await sessions.credentials({
    roleArn: env('DATA_ACCESS_ROLE_ARN'),
    artistId: f.artistId!,
    role: 'bmg-admin',
  });
  const obj = await new S3Client({ credentials }).send(
    new GetObjectCommand({
      Bucket: env('ARTIST_BUCKET'),
      Key: storedKey('artist', f.fileId, f.artistId),
    }),
  );
  return obj.Body!.transformToByteArray();
}

/** Folders are read once a minute per artist while syncing. */
const folderMemo = new Map<string, { at: number; map: Promise<FolderMap> }>();
async function hiddenByFolders(f: FileRecord): Promise<boolean> {
  if (f.scope !== 'artist' || !folderManaged(f)) return false;
  const pk = `ARTIST#${f.artistId}`;
  let m = folderMemo.get(pk);
  if (!m || Date.now() - m.at > 60_000) {
    m = { at: Date.now(), map: loadFolders(pk).then(folderMap) };
    folderMemo.set(pk, m);
  }
  return hiddenFromBlueprint(f, await m.map);
}

/** Adds, refreshes or removes one file in its owner's knowledge base. */
export async function syncFile(
  f: FileRecord,
  rec: KbRecord,
): Promise<'ingested' | 'removed' | 'skipped'> {
  // An artist can take Blueprint's access to a folder away (rev 10): those
  // files are kept out of the knowledge base, like private ones.
  const decision = ingestDecision((await hiddenByFolders(f)) ? { ...f, visibility: 'private' } : f);
  const id = { dataSourceType: 'CUSTOM' as const, custom: { id: f.fileId } };
  if (!decision.ingest) {
    await bedrock
      .send(
        new DeleteKnowledgeBaseDocumentsCommand({
          knowledgeBaseId: rec.knowledgeBaseId,
          dataSourceId: rec.dataSourceId,
          documentIdentifiers: [id],
        }),
      )
      .catch(() => undefined);
    log('kb.file.skipped', { fileId: f.fileId, reason: decision.reason });
    return decision.reason === 'private' || decision.reason === 'not available'
      ? 'removed'
      : 'skipped';
  }
  const data = await readFile(f);
  await bedrock.send(
    new IngestKnowledgeBaseDocumentsCommand({
      knowledgeBaseId: rec.knowledgeBaseId,
      dataSourceId: rec.dataSourceId,
      clientToken: randomUUID(),
      documents: [
        {
          metadata: { type: 'IN_LINE_ATTRIBUTE', inlineAttributes: docAttributes(f) },
          content: {
            dataSourceType: 'CUSTOM',
            custom: {
              customDocumentIdentifier: { id: f.fileId },
              sourceType: 'IN_LINE',
              inlineContent: { type: 'BYTE', byteContent: { mimeType: f.contentType, data } },
            },
          },
        },
      ],
    }),
  );
  log('kb.file.ingested', { fileId: f.fileId });
  return 'ingested';
}

/** Removes a deleted file from its owner's knowledge base. */
export async function removeFile(fileId: string, rec: KbRecord) {
  await bedrock
    .send(
      new DeleteKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: rec.knowledgeBaseId,
        dataSourceId: rec.dataSourceId,
        documentIdentifiers: [{ dataSourceType: 'CUSTOM', custom: { id: fileId } }],
      }),
    )
    .catch(() => undefined);
}

export async function loadFile(owner: string, fileId: string): Promise<FileRecord | undefined> {
  const pk = owner === BMG_KB_OWNER ? LIBRARY_PK : `ARTIST#${owner}`;
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: pk, SK: fileSk(fileId) } }),
  );
  return res.Item as FileRecord | undefined;
}

/** Every file the owner has, for the first fill after opting in. */
export async function allFiles(owner: string): Promise<FileRecord[]> {
  const pk = owner === BMG_KB_OWNER ? LIBRARY_PK : `ARTIST#${owner}`;
  const out: FileRecord[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :f)',
        ExpressionAttributeValues: { ':pk': pk, ':f': 'FILE#' },
        ExclusiveStartKey: start,
      }),
    );
    out.push(...((res.Items ?? []) as FileRecord[]));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** Owners that currently have a knowledge base (not counting BMG's). */
export async function kbOwners(): Promise<string[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :k',
      ExpressionAttributeValues: { ':k': 'KBS' },
    }),
  );
  return (res.Items ?? []).map((i) => String(i.owner));
}
