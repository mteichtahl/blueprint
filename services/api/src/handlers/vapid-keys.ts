import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import webpush from 'web-push';

const secrets = new SecretsManagerClient({});

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
}

async function respond(event: CfnEvent, status: 'SUCCESS' | 'FAILED', reason: string) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason.slice(0, 1000),
    PhysicalResourceId: event.PhysicalResourceId ?? 'vapid-keys',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  });
  const res = await fetch(event.ResponseURL, {
    method: 'PUT',
    headers: { 'content-type': '', 'content-length': String(Buffer.byteLength(body)) },
    body,
  });
  if (!res.ok) throw new Error(`CloudFormation response failed: ${res.status}`);
}

/**
 * Makes sure the environment's VAPID key pair exists (web push, design 7.4).
 * Keys are generated once, inside AWS, and only ever stored in Secrets
 * Manager; existing keys are never replaced (that would break every device's
 * subscription). Nothing is logged.
 */
export async function handler(event: CfnEvent) {
  if (event.RequestType === 'Delete') return respond(event, 'SUCCESS', 'kept');
  try {
    const id = process.env.VAPID_SECRET_ID!;
    const current = await secrets.send(new GetSecretValueCommand({ SecretId: id }));
    // A new secret holds a random placeholder, not JSON.
    let value: { publicKey?: string } = {};
    try {
      value = JSON.parse(current.SecretString ?? '{}');
    } catch {
      value = {};
    }
    if (!value.publicKey) {
      const keys = webpush.generateVAPIDKeys();
      await secrets.send(
        new PutSecretValueCommand({
          SecretId: id,
          SecretString: JSON.stringify({ ...keys, subject: process.env.VAPID_SUBJECT }),
        }),
      );
    }
    return respond(event, 'SUCCESS', 'VAPID keys ready');
  } catch (err) {
    return respond(event, 'FAILED', `Could not prepare VAPID keys: ${(err as Error).name}`);
  }
}
