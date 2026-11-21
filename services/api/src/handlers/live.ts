import type { DynamoDBStreamHandler } from 'aws-lambda';
import { nudgesFor } from '../live/model.ts';
import { publish } from '../realtime.ts';

/**
 * Live updates (rev 17): reads the main table's stream (keys only are used)
 * and nudges the realtime channels of whoever can see each change. Publishing
 * is best-effort: a missed nudge is caught up by the screen's next refresh.
 */
export const handler: DynamoDBStreamHandler = async (event) => {
  const keys = event.Records.flatMap((r) => {
    const pk = r.dynamodb?.Keys?.PK?.S;
    const sk = r.dynamodb?.Keys?.SK?.S;
    return pk && sk ? [{ pk, sk }] : [];
  });
  const nudges = nudgesFor(keys);
  await Promise.all(
    nudges.map((n) =>
      publish(n.channels, { live: n.topic, ...(n.artistId ? { artistId: n.artistId } : {}) }),
    ),
  );
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'live.nudged',
      records: event.Records.length,
      nudges: nudges.length,
    }),
  );
};
