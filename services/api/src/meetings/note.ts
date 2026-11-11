import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { db, env } from '../lib.ts';
import { artistPk, newId, PROFILE_SK } from '../workspace/model.ts';
import { summaryMarkdown } from './ai.ts';
import { meetingFileName, noteMarkdown, type Meeting, type MeetingContent } from './model.ts';
import { fileDocument, loadMeetingFile, readContent, updateMeeting } from './store.ts';

export async function artistName(artistId: string | undefined): Promise<string | undefined> {
  if (!artistId) return undefined;
  const res = await db.send(
    new GetCommand({
      TableName: env('MAIN_TABLE'),
      Key: { PK: artistPk(artistId), SK: PROFILE_SK },
      ProjectionExpression: 'displayName',
    }),
  );
  return (res.Item?.displayName as string | undefined) ?? undefined;
}

/** The latest summary, as Markdown for the top of the note. */
function latestSummary(content: MeetingContent): string | undefined {
  const s = content.summaries?.at(-1);
  return s ? summaryMarkdown(s, content) : undefined;
}

/**
 * Writes the meeting note to the Library: the first time as a new document
 * next to the audio, afterwards as its next version (so earlier ones stay in
 * its version history). It goes through the malware scan like any upload.
 */
export async function refreshNote(
  m: Meeting,
  role: 'bmg-admin' | 'bmg-staff',
  opts: { content?: MeetingContent; note?: string } = {},
): Promise<string> {
  const content = opts.content ?? (await readContent(m, role));
  const audio = m.audioFileId ? await loadMeetingFile(m, m.audioFileId) : undefined;
  const folderId = m.folderId ?? audio?.folderId;
  const body = noteMarkdown(m, content, {
    artistName: await artistName(m.artistId),
    summary: latestSummary(content),
  });
  const fileId = await fileDocument(
    m,
    {
      name: meetingFileName(m, 'notes'),
      body,
      contentType: 'text/markdown',
      ...(folderId ? { folderId } : {}),
      ...(m.noteFileId ? { fileId: m.noteFileId } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    },
    () => newId(),
  );
  if (fileId !== m.noteFileId) await updateMeeting(m, { noteFileId: fileId });
  return fileId;
}
