/**
 * Reading folders (rev 10). A space holds few enough folders to read in one
 * go, so access is worked out in memory by following parent links: moves are
 * a single write and never leave stale paths behind (docs/decisions.md).
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { db, env } from '../lib.ts';
import type { FileRecord } from './model.ts';
import type { FolderRecord } from './folders.ts';

export type StoredFolder = FolderRecord & { PK: string; SK: string };
export type StoredFile = FileRecord & { PK: string; SK: string };

async function queryAll<T>(pk: string, prefix: string): Promise<T[]> {
  const out: T[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: env('MAIN_TABLE'),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': pk, ':p': prefix },
        ExclusiveStartKey: start,
      }),
    );
    out.push(...((res.Items ?? []) as T[]));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** Every folder in a space. */
export const loadFolders = (pk: string) => queryAll<StoredFolder>(pk, 'FOLDER#');

/** Every file in a space (all pages). */
export const loadAllFiles = (pk: string) => queryAll<StoredFile>(pk, 'FILE#');
