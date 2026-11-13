import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { db, env } from '../lib.ts';
import { settingsKey, type ArtistTodosSettings } from './owner-todos.ts';

/** Rev 15: a Blueprint person's to-dos-from-artists settings (their own, or an admin's change). */
export async function saveArtistTodos(sub: string, s: ArtistTodosSettings) {
  await db.send(
    new UpdateCommand({
      TableName: env('MAIN_TABLE'),
      Key: settingsKey(sub),
      UpdateExpression:
        'SET #type = :type, enabled = :e, maxOpenPerArtist = :m, perArtist = :p, updatedAt = :at',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: {
        ':type': 'artist-todos-settings',
        ':e': s.enabled,
        ':m': s.maxOpenPerArtist,
        ':p': s.perArtist,
        ':at': new Date().toISOString(),
      },
    }),
  );
}
