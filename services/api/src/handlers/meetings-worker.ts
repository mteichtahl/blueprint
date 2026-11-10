import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DescribeEffectivePolicyCommand, OrganizationsClient } from '@aws-sdk/client-organizations';
import {
  DeleteTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
  type MediaFormat,
} from '@aws-sdk/client-transcribe';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { DataAccessSessions } from '@bmg/crypto';
import { render } from '@bmg/prompts';
import { AI_OPT_OUT_POLICY_TYPE, optedOutOf } from '@bmg/config/ai-opt-out';
import { aiStates, livePrompt } from '../ai/prompts.ts';
import {
  ANSWER_REPLY_SHAPE,
  answerFrom,
  jsonIn,
  MAX_ANSWERS,
  MAX_SUMMARIES,
  promptVars,
  SUMMARY_REPLY_SHAPE,
  summaryFrom,
  type AiJob,
} from '../meetings/ai.ts';
import {
  PLAN_REPLY_SHAPE,
  planForPrompt,
  PlanReply,
  reviewChanges,
} from '../meetings/plan-changes.ts';
import { loadPlan } from '../workspace/plan-store.ts';
import { storedKey, type FileRecord } from '../files/model.ts';
import { env } from '../lib.ts';
import {
  artistsInvolved,
  jobName,
  mediaFormat,
  meetingFromJob,
  segmentsFromTranscribe,
  speakerCount,
  transcriptionBlock,
  type Meeting,
  type MeetingSpace,
} from '../meetings/model.ts';
import {
  loadMeeting,
  loadMeetingFile,
  mutateContent,
  readContent,
  updateMeeting,
  writeContent,
} from '../meetings/store.ts';
import { artistName, refreshNote } from '../meetings/note.ts';

/**
 * The meetings worker (rev 11): turns a meeting's recording into a
 * transcript.
 *
 * 1. The recording passes the malware scan (`file.available`), or someone
 *    asks to try again (`meeting.transcribe`).
 * 2. Checks, failing closed: every artist involved has AI on, and the
 *    account's AWS AI services opt-out covers Transcribe.
 * 3. Copies the recording into the meetings work bucket (its own key, kept
 *    3 days at most) and starts an Amazon Transcribe job in Sydney:
 *    Australian English, voices separated, output encrypted with the work key.
 * 4. When the job finishes (`Transcribe Job State Change`), the transcript is
 *    turned into paragraphs by speaker, saved with the meeting under the
 *    space's own key, filed as the meeting note in the Library, and the work
 *    copies and the job are deleted.
 */

const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
const transcribe = new TranscribeClient({});
const events = new EventBridgeClient({});
// Organizations is a global service, served from us-east-1.
const orgs = new OrganizationsClient({ region: 'us-east-1' });
const sessions = new DataAccessSessions();
const bedrock = new BedrockRuntimeClient({});

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', event, ...fields }));

type WorkerEvent =
  | {
      source: 'bmg.audit';
      'detail-type': 'file.available' | 'file.rejected';
      detail: { fileId?: string; artistId?: string; library?: boolean; reason?: string };
    }
  | {
      source: 'bmg.meetings';
      'detail-type': 'meeting.transcribe' | 'meeting.ai';
      detail: { meetingId?: string; artistId?: string; requestId?: string };
    }
  | {
      source: 'aws.transcribe';
      'detail-type': 'Transcribe Job State Change';
      detail: { TranscriptionJobName?: string; TranscriptionJobStatus?: string };
    };

export async function handler(event: WorkerEvent): Promise<void> {
  if (event.source === 'aws.transcribe') {
    return finish(event.detail.TranscriptionJobName ?? '', event.detail.TranscriptionJobStatus);
  }
  if (event.source === 'bmg.meetings') {
    const { meetingId, artistId } = event.detail;
    if (!meetingId) return;
    const space: MeetingSpace = artistId ? { kind: 'artist', artistId } : { kind: 'library' };
    if (event['detail-type'] === 'meeting.ai') {
      return runAi(space, meetingId, event.detail.requestId ?? '');
    }
    return start(await loadMeeting(space, meetingId));
  }
  // A file settled: is it a meeting's recording?
  const { fileId, artistId } = event.detail;
  if (!fileId) return;
  const f = await loadMeetingFile(artistId ? { artistId } : {}, fileId);
  const meetingId = (f as (FileRecord & { meetingId?: string }) | undefined)?.meetingId;
  if (!f || !meetingId) return;
  const space: MeetingSpace = artistId ? { kind: 'artist', artistId } : { kind: 'library' };
  let m: Meeting;
  try {
    m = await loadMeeting(space, meetingId);
  } catch {
    return; // The meeting was deleted.
  }
  if (m.audioFileId !== fileId) return; // The note, or an older recording.
  if (event['detail-type'] === 'file.rejected') {
    await settle(m, 'failed', 'The recording didn’t pass the malware check, so it wasn’t kept.', {
      expect: 'uploading',
    });
    return;
  }
  return start(m);
}

// ── AWS AI opt-out: checked before every job, cached briefly ──
let optOut: { at: number; ok: boolean } | undefined;
async function awsOptedOut(): Promise<boolean> {
  if (optOut && Date.now() - optOut.at < 10 * 60_000) return optOut.ok;
  let ok = false;
  try {
    const res = await orgs.send(
      new DescribeEffectivePolicyCommand({
        PolicyType: AI_OPT_OUT_POLICY_TYPE,
        TargetId: env('ACCOUNT_ID'),
      }),
    );
    ok = optedOutOf('transcribe', res.EffectivePolicy?.PolicyContent);
  } catch (err) {
    // Not in an organization, no policy, or no answer: transcription stays off.
    log('meetings.opt-out.unknown', { error: (err as Error).name });
  }
  optOut = { at: Date.now(), ok };
  return ok;
}

async function processed(m: Meeting, outcome: 'ready' | 'failed' | 'no-ai' | 'off') {
  await events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: env('EVENT_BUS'),
          Source: 'bmg.workspace',
          DetailType: 'meeting.processed',
          Detail: JSON.stringify({
            id: randomUUID(),
            meetingId: m.meetingId,
            ...(m.artistId ? { artistId: m.artistId } : {}),
            createdBy: m.createdBy,
            title: m.title,
            outcome,
          }),
        },
      ],
    }),
  );
}

async function settle(
  m: Meeting,
  status: 'failed' | 'no-ai' | 'off',
  reason: string,
  opts: { expect?: Meeting['status'] } = {},
) {
  const moved = await updateMeeting(
    m,
    { status, statusReason: reason },
    { ...(opts.expect ? { expect: { status: opts.expect } } : {}) },
  );
  if (moved) await processed(m, status);
  log('meetings.settled', { meetingId: m.meetingId, status });
}

/** Where the work copies go: one prefix per attempt. */
const workPrefix = (m: Meeting, attempt: number) => `jobs/${m.meetingId}/${attempt}`;

async function start(m: Meeting): Promise<void> {
  if (m.status !== 'uploading' || !m.audioFileId) return;
  const audio = await loadMeetingFile(m, m.audioFileId);
  // Still being scanned: file.available brings us back.
  if (!audio || audio.status !== 'available') return;

  const involved = artistsInvolved(m);
  const states = involved.length ? await aiStates(involved) : {};
  const block = transcriptionBlock({
    artistsOptedIn: involved.map((id) => states[id] === true),
    awsOptedOut: await awsOptedOut(),
  });
  if (block) return settle(m, block.status, block.reason, { expect: 'uploading' });

  // Claim the meeting first, so a repeated event can't start a second job.
  const attempt = (m.attempts ?? 0) + 1;
  const name = jobName(env('PROJECT'), env('BMG_ENV'), m, attempt);
  const claimed = await updateMeeting(
    m,
    { status: 'transcribing', attempts: attempt, transcribeJob: name },
    { expect: { status: 'uploading' }, remove: ['statusReason'] },
  );
  if (!claimed) return;

  const work = env('WORK_BUCKET');
  const mediaKey = `${workPrefix(m, attempt)}/audio`;
  try {
    // Every type a meeting accepts has a Transcribe format (isMeetingAudio).
    const format = mediaFormat(audio.contentType);
    if (!format) throw new Error('UnsupportedMediaFormat');
    await copyToWork(m, audio, mediaKey);
    await transcribe.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: name,
        LanguageCode: 'en-AU',
        Media: { MediaFileUri: `s3://${work}/${mediaKey}` },
        MediaFormat: format as MediaFormat,
        OutputBucketName: work,
        OutputKey: `${workPrefix(m, attempt)}/transcript.json`,
        OutputEncryptionKMSKeyId: env('WORK_KEY_ARN'),
        Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: speakerCount(m.attendees) },
        Tags: [{ Key: 'bmg:env', Value: env('BMG_ENV') }],
      }),
    );
    log('meetings.transcribing', { meetingId: m.meetingId, attempt });
  } catch (err) {
    log('meetings.start-failed', { meetingId: m.meetingId, error: (err as Error).name });
    await cleanUp(m, attempt);
    await settle(
      { ...m, status: 'transcribing' },
      'failed',
      'The recording couldn’t be sent for transcription. Try again in a few minutes.',
      { expect: 'transcribing' },
    );
  }
}

/** The recording, read the way the app reads it, into the work bucket. */
async function copyToWork(m: Meeting, audio: FileRecord, key: string) {
  const source = m.artistId
    ? {
        client: new S3Client({
          credentials: await sessions.credentials({
            roleArn: env('DATA_ACCESS_ROLE_ARN'),
            artistId: m.artistId,
            role: m.createdByRole,
          }),
        }),
        bucket: env('ARTIST_BUCKET'),
        key: storedKey('artist', audio.fileId, m.artistId),
      }
    : { client: s3, bucket: env('LIBRARY_BUCKET'), key: storedKey('library', audio.fileId) };
  const obj = await source.client.send(
    new GetObjectCommand({ Bucket: source.bucket, Key: source.key }),
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: env('WORK_BUCKET'),
      Key: key,
      Body: obj.Body as Readable,
      ContentLength: obj.ContentLength,
      ContentType: audio.contentType,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: env('WORK_KEY_ARN'),
    }),
  );
}

async function cleanUp(m: Pick<Meeting, 'meetingId'>, attempt: number, job?: string) {
  const prefix = `jobs/${m.meetingId}/${attempt}`;
  for (const key of ['audio', 'transcript.json']) {
    await s3
      .send(new DeleteObjectCommand({ Bucket: env('WORK_BUCKET'), Key: `${prefix}/${key}` }))
      .catch(() => undefined);
  }
  if (job) {
    await transcribe
      .send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: job }))
      .catch(() => undefined);
  }
}

async function finish(job: string, status: string | undefined): Promise<void> {
  const ref = meetingFromJob(env('PROJECT'), env('BMG_ENV'), job);
  if (!ref) return; // Another environment's job, or not ours.
  let m: Meeting;
  try {
    m = await loadMeeting(ref.space, ref.meetingId);
  } catch {
    await cleanUp({ meetingId: ref.meetingId }, ref.attempt, job);
    return;
  }
  // Superseded by a later attempt, or already handled.
  if (m.transcribeJob !== job || m.status !== 'transcribing') return;

  if (status !== 'COMPLETED') {
    let reason = 'The recording couldn’t be transcribed.';
    try {
      const res = await transcribe.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: job }),
      );
      const why = res.TranscriptionJob?.FailureReason ?? '';
      log('meetings.job-failed', { meetingId: m.meetingId, why: why.slice(0, 200) });
      if (/no speech|silent|too short/i.test(why)) {
        reason = 'No speech was found in the recording.';
      } else if (/format|codec|corrupt|unsupported/i.test(why)) {
        reason = 'The recording’s format couldn’t be read. Try uploading it as MP3 or M4A.';
      }
    } catch {
      // Keep the general reason.
    }
    await cleanUp(m, ref.attempt, job);
    await settle(m, 'failed', reason, { expect: 'transcribing' });
    return;
  }

  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: env('WORK_BUCKET'),
      Key: `${workPrefix(m, ref.attempt)}/transcript.json`,
    }),
  );
  const segments = segmentsFromTranscribe(JSON.parse(await obj.Body!.transformToString()));
  // Notes and markers typed while recording are kept; the transcript is new.
  const content = { ...(await readContent(m, m.createdByRole)), segments, edited: false };
  const version = await writeContent(m, content, m.createdByRole, { status: 'ready' });
  await updateMeeting(m, {}, { remove: ['statusReason'] });
  const ready: Meeting = { ...m, status: 'ready', contentVersion: version };
  await refreshNote(ready, m.createdByRole, { content });
  await cleanUp(m, ref.attempt, job);
  await processed(ready, 'ready');
  log('meetings.ready', { meetingId: m.meetingId, segments: segments.length });
}

// ── Summaries, answers and plan suggestions (rev 11, spec 5.2 and 6) ──
async function converse(modelId: string, prompt: string, maxTokens: number): Promise<string> {
  const res = await bedrock.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      // No temperature: Claude 5.5 models reject sampling parameters.
      inferenceConfig: { maxTokens },
    }),
  );
  return res.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
}

const today = () => new Date().toISOString().slice(0, 10);

async function runAi(space: MeetingSpace, meetingId: string, requestId: string): Promise<void> {
  let m: Meeting;
  try {
    m = await loadMeeting(space, meetingId);
  } catch {
    return;
  }
  const job = m.aiJob;
  if (!job || job.requestId !== requestId || job.status !== 'working') return;
  const role = m.createdByRole;
  const fail = async (error: string) => {
    const failed: AiJob = { ...job, status: 'failed', error };
    await updateMeeting(m, { aiJob: failed });
    log('meetings.ai-failed', { meetingId, task: job.task });
  };

  // AI choices are checked again here: someone may have turned AI off since.
  const involved = artistsInvolved(m);
  const states = involved.length ? await aiStates(involved) : {};
  if (involved.some((id) => !states[id])) {
    return fail('An artist in this meeting has turned off AI assistance.');
  }

  try {
    const content = await readContent(m, role);
    const vars = promptVars(m, content, {
      artistName: await artistName(m.artistId),
      today: today(),
    });
    const meta = { createdAt: new Date().toISOString(), createdBy: job.requestedBy };

    if (job.task === 'quick' || job.task === 'full') {
      const prompt = `${render(await livePrompt(`meetings.summary.${job.task}`), vars)}\n\n${SUMMARY_REPLY_SHAPE[job.task]}`;
      const summary = summaryFrom(
        jsonIn(await converse(env('SUMMARY_MODEL'), prompt, 4000)),
        content,
        {
          ...meta,
          id: requestId,
          kind: job.task,
        },
      );
      if (!summary) return fail('The summary didn’t come back right. Try again.');
      const saved = await mutateContent(
        space,
        meetingId,
        role,
        (c) => ({ ...c, summaries: [...(c.summaries ?? []), summary].slice(-MAX_SUMMARIES) }),
        {},
        ['aiJob'],
      );
      // The latest summary goes to the top of the meeting note in the Library.
      await refreshNote(saved.meeting, role, { content: saved.content, note: 'New summary' }).catch(
        (err) => log('meetings.note-failed', { meetingId, error: (err as Error).name }),
      );
    } else if (job.task === 'ask') {
      const question = content.pending?.requestId === requestId ? content.pending.question : '';
      if (!question) return fail('The question went missing. Ask it again.');
      const prompt = `${render(await livePrompt('meetings.ask'), { ...vars, question })}\n\n${ANSWER_REPLY_SHAPE}`;
      const answer = answerFrom(
        jsonIn(await converse(env('SUMMARY_MODEL'), prompt, 1500)),
        content,
        {
          ...meta,
          id: requestId,
          question,
        },
      );
      if (!answer) return fail('The answer didn’t come back right. Try again.');
      await mutateContent(
        space,
        meetingId,
        role,
        (c) => {
          const next = { ...c, answers: [...(c.answers ?? []), answer].slice(-MAX_ANSWERS) };
          delete next.pending;
          return next;
        },
        {},
        ['aiJob'],
      );
    } else {
      if (!m.artistId) return fail('Only a meeting about an artist can change a plan.');
      const plan = await loadPlan(m.artistId);
      if (!plan) return fail('This artist doesn’t have a plan yet.');
      const prompt = `${render(await livePrompt('meetings.plan_update'), { ...vars, plan: planForPrompt(plan) })}\n\n${PLAN_REPLY_SHAPE}`;
      const reply = PlanReply.safeParse(
        jsonIn(await converse(env('ASSISTANT_MODEL'), prompt, 8000)),
      );
      if (!reply.success) return fail('The suggestions didn’t come back right. Try again.');
      const suggestions = reviewChanges(plan, reply.data.changes);
      await mutateContent(
        space,
        meetingId,
        role,
        (c) => ({
          ...c,
          suggestions: {
            setId: requestId,
            ...meta,
            basePlanVersion: plan.version,
            suggestions,
            ...(suggestions.length ? {} : { none: true }),
          },
        }),
        {},
        ['aiJob'],
      );
    }
    log('meetings.ai-done', { meetingId, task: job.task });
  } catch (err) {
    log('meetings.ai-error', { meetingId, task: job.task, error: (err as Error).name });
    await fail('That didn’t work this time. Try again in a minute.');
  }
}
