import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Shared document client, created once per Lambda container. */
export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export function mainTable(): string {
  const name = process.env.MAIN_TABLE;
  if (!name) throw new Error('MAIN_TABLE is not set');
  return name;
}

/** Structured log line without personal data (no emails, names or tokens). */
export function logEvent(event: string, fields: Record<string, string | number | boolean> = {}) {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}
