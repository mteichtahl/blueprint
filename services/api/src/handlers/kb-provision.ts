import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeEvent } from 'aws-lambda';
import { BMG_KB_OWNER, reconcilePlan } from '../ai/kb.ts';
import { allFiles, createKb, kbOwners, purgeKb, syncFile } from '../ai/kb-ops.ts';
import { aiStates } from '../ai/prompts.ts';
import { projectAiState } from '../ai/state.ts';
import { db, env } from '../lib.ts';
import { ROSTER_GSI1PK } from '../workspace/model.ts';

/**
 * Keeps knowledge bases in step with AI consent (design 10.3, 10.4):
 * - `consent.aiChanged`: opting in creates the artist's knowledge base and
 *   fills it from their files; opting out deletes it, its data and its vector
 *   index (target: well under an hour).
 * - Daily reconciliation compares consent with what exists, fixes any drift,
 *   and reports drift and the knowledge-base count as metrics (alarms).
 */

const cw = new CloudWatchClient({});

async function fill(owner: string) {
  const rec = await createKb(owner);
  let ingested = 0;
  for (const f of await allFiles(owner)) {
    try {
      if ((await syncFile(f, rec)) === 'ingested') ingested++;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'kb.fill.file',
          fileId: f.fileId,
          error: (err as Error).name,
        }),
      );
    }
  }
  console.log(JSON.stringify({ level: 'info', event: 'kb.filled', owner, ingested }));
}

async function metric(name: string, value: number) {
  await cw.send(
    new PutMetricDataCommand({
      Namespace: 'BMG/AI',
      MetricData: [
        {
          MetricName: name,
          Value: value,
          Unit: 'Count',
          Dimensions: [{ Name: 'Environment', Value: env('BMG_ENV') }],
        },
      ],
    }),
  );
}

async function reconcile() {
  const roster = await db.send(
    new QueryCommand({
      TableName: env('MAIN_TABLE'),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :r',
      ExpressionAttributeValues: { ':r': ROSTER_GSI1PK },
    }),
  );
  const artists = (roster.Items ?? []).map((a) => String(a.artistId));
  const states = await aiStates(artists);
  const optedIn = new Set(artists.filter((a) => states[a]));
  const have = new Set(await kbOwners());
  const plan = reconcilePlan(optedIn, have);
  // Opt-outs first: privacy before features.
  for (const owner of plan.purge) await purgeKb(owner);
  for (const owner of plan.create) await fill(owner);
  await createKb(BMG_KB_OWNER);
  await metric('ConsentDrift', plan.purge.length + plan.create.length);
  await metric('KnowledgeBases', optedIn.size + 1);
  console.log(JSON.stringify({ level: 'info', event: 'kb.reconciled', ...plan }));
}

export async function handler(
  event:
    | EventBridgeEvent<
        'consent.aiChanged',
        { artistId: string; aiOptIn: boolean; decidedAt: string }
      >
    | EventBridgeEvent<'Scheduled Event', unknown>,
) {
  if (event['detail-type'] === 'consent.aiChanged') {
    const d = (
      event as EventBridgeEvent<
        'consent.aiChanged',
        { artistId: string; aiOptIn: boolean; decidedAt: string }
      >
    ).detail;
    if (!/^art_[a-z0-9]{12}$/.test(d.artistId)) return;
    // Record the choice first (the assistant reads it), then act on the latest choice only.
    await projectAiState(d.artistId, d.aiOptIn, d.decidedAt);
    const now = (await aiStates([d.artistId]))[d.artistId] ?? false;
    if (now) await fill(d.artistId);
    else await purgeKb(d.artistId);
    return;
  }
  await reconcile();
}
