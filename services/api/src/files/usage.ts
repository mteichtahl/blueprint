/**
 * Where a document is used (rev 8): its submissions, the brand kit, the
 * asset library and the chats it was posted in. Each viewer sees the places
 * they can open; the rest are only counted.
 */
import { BatchGetCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Principal } from '@bmg/authz';
import { BRAND_SK } from '../brand/model.ts';
import { access, CONV_META, convPk, type Conversation } from '../messages/model.ts';
import { artistPk } from '../workspace/model.ts';
import { db, env } from '../lib.ts';
import { blocksDelete, fileUsePk, type FileRecord, type FileUse } from './model.ts';

const table = () => env('MAIN_TABLE');

const SUBMISSION_STATUS: Record<string, string> = {
  open: 'Waiting for review',
  reviewed: 'Reviewed',
};

async function submissions(f: FileRecord): Promise<FileUse[]> {
  if (f.scope !== 'artist' || !f.artistId) return [];
  const out: FileUse[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':pk': artistPk(f.artistId), ':s': 'SUB#' },
        ProjectionExpression: 'submissionId, title, #st, fileIds',
        ExpressionAttributeNames: { '#st': 'status' },
        ExclusiveStartKey,
      }),
    );
    for (const s of res.Items ?? []) {
      if (!((s.fileIds as string[] | undefined) ?? []).includes(f.fileId)) continue;
      const status = String(s.status);
      out.push({
        kind: 'submission',
        id: String(s.submissionId),
        title: String(s.title ?? 'Submission'),
        detail: SUBMISSION_STATUS[status] ?? status,
        blocks: blocksDelete('submission', status),
      });
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function brandKit(f: FileRecord): Promise<FileUse[]> {
  if (f.scope !== 'artist' || !f.artistId) return [];
  const res = await db.send(
    new GetCommand({
      TableName: table(),
      Key: { PK: artistPk(f.artistId), SK: BRAND_SK },
      ProjectionExpression: 'logos, imagery',
    }),
  );
  const kit = res.Item as
    { logos?: { fileId: string; label: string }[]; imagery?: { fileIds?: string[] } } | undefined;
  const out: FileUse[] = [];
  const logo = kit?.logos?.find((l) => l.fileId === f.fileId);
  if (logo) {
    out.push({
      kind: 'brand-kit',
      id: f.fileId,
      title: 'Brand kit',
      detail: `Logo: ${logo.label}`,
      blocks: true,
    });
  } else if (kit?.imagery?.fileIds?.includes(f.fileId)) {
    out.push({
      kind: 'brand-kit',
      id: f.fileId,
      title: 'Brand kit',
      detail: 'Imagery',
      blocks: true,
    });
  }
  return out;
}

function asset(f: FileRecord): FileUse[] {
  if (!f.asset) return [];
  return [
    {
      kind: 'asset',
      id: f.fileId,
      title: 'Asset library',
      detail: f.asset.title,
      blocks: true,
    },
  ];
}

/** Chats the file card was posted in, that still exist. */
async function chats(f: FileRecord): Promise<{ conv: Conversation; use: FileUse }[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
      ExpressionAttributeValues: {
        ':pk': fileUsePk(f.scope, f.fileId, f.artistId),
        ':c': 'CHAT#',
      },
      Limit: 100,
    }),
  );
  const ids = [...new Set((res.Items ?? []).map((i) => String(i.conversationId)))];
  if (ids.length === 0) return [];
  const got = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [table()]: {
          Keys: ids.map((id) => ({ PK: convPk(id), SK: CONV_META })),
          ProjectionExpression: 'conversationId, #t, artistIds, title, deletedAt',
          ExpressionAttributeNames: { '#t': 'type' },
        },
      },
    }),
  );
  return (got.Responses?.[table()] ?? [])
    .map((c) => c as Conversation)
    .filter((c) => !c.deletedAt)
    .map((conv) => ({
      conv,
      use: {
        kind: 'chat' as const,
        id: conv.conversationId,
        title:
          conv.title ??
          (conv.type === 'artist-to-artist'
            ? 'Chat between artists'
            : conv.type === 'bmg-artist'
              ? 'Chat with Blueprint'
              : 'Chat'),
        blocks: false,
      },
    }));
}

/**
 * Every place the document is used. `visible` is what this person may see
 * (they can open the chat; artist-to-artist chats are never shown to
 * Blueprint), `hidden` counts the rest, and `all` is everything (for the
 * delete check, which applies whoever asks).
 */
export async function usesOf(principal: Principal, f: FileRecord) {
  const [subs, kit, convs] = await Promise.all([submissions(f), brandKit(f), chats(f)]);
  const seen = convs.filter(({ conv }) => access(principal, conv) !== 'none');
  const workspace = [...subs, ...kit, ...asset(f)];
  // Another artist the file was sent to (in a chat) never sees inside this
  // artist's workspace.
  const outsider =
    principal.role === 'artist' && f.scope === 'artist' && principal.artistId !== f.artistId;
  const all = [...workspace, ...convs.map((c) => c.use)];
  const visible = [...(outsider ? [] : workspace), ...seen.map((c) => c.use)];
  return { all, visible, hidden: all.length - visible.length };
}
