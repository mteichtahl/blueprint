import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { addSubscriber, mailchimp } from '../connectors/mailchimp.ts';
import { allConnections, isOrg } from '../connectors/store.ts';
import { syncConnection } from '../connectors/sync.ts';
import { db, env } from '../lib.ts';
import { NEWSLETTER_PK, type Signup } from '../newsletter.ts';

/**
 * Newsletter sign-ups made while Mailchimp wasn't connected (or was down):
 * added to the audience now, as pending, so Mailchimp asks them to confirm.
 */
export async function flushSignups(): Promise<number> {
  const mc = await mailchimp().catch(() => undefined);
  if (!mc) return 0;
  const res = await db.send(
    new QueryCommand({
      TableName: env('MAIN_TABLE'),
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: '#st = :waiting',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':pk': NEWSLETTER_PK, ':waiting': 'waiting' },
      Limit: 500,
    }),
  );
  let added = 0;
  for (const it of (res.Items ?? []) as (Signup & { PK: string; SK: string })[]) {
    try {
      const status = await addSubscriber(mc, {
        email: it.email,
        ...(it.firstName ? { firstName: it.firstName } : {}),
      });
      await db.send(
        new UpdateCommand({
          TableName: env('MAIN_TABLE'),
          Key: { PK: it.PK, SK: it.SK },
          UpdateExpression: 'SET #st = :added, mailchimpStatus = :ms, addedAt = :at',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: {
            ':added': 'added',
            ':ms': status,
            ':at': new Date().toISOString(),
          },
        }),
      );
      added++;
    } catch {
      // Left waiting; the next hourly run tries again.
    }
  }
  return added;
}

/**
 * Scheduled (hourly): pulls every connection into the day's snapshots, keeps
 * tokens fresh, updates Humanitix ticket counts and calendars. Runs in a
 * Blueprint data-access session; connector tokens are never `private`.
 */
export async function handler(): Promise<{ synced: number; failed: number }> {
  const conns = await allConnections();
  let failed = 0;
  // A few at a time keeps within vendor rate limits and the function timeout.
  for (let i = 0; i < conns.length; i += 4) {
    const batch = await Promise.all(
      conns.slice(i, i + 4).map((c) => syncConnection(c, 'bmg-admin')),
    );
    failed += batch.filter((r) => r.connection.status !== 'connected').length;
  }
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'connectors.synced',
      total: conns.length,
      artists: conns.filter((c) => !isOrg(c.account_)).length,
      failed,
    }),
  );
  const signups = await flushSignups().catch(() => 0);
  if (signups) console.log(JSON.stringify({ level: 'info', event: 'newsletter.flushed', signups }));
  return { synced: conns.length - failed, failed };
}
