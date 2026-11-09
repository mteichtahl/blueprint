import { allConnections, isOrg } from '../connectors/store.ts';
import { syncConnection } from '../connectors/sync.ts';

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
  return { synced: conns.length - failed, failed };
}
