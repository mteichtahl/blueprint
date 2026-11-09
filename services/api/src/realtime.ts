import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

/** SHA-256 for SigV4, from Node's own crypto. */
type SourceData = string | ArrayBuffer | ArrayBufferView;
const bytes = (d: SourceData) =>
  typeof d === 'string'
    ? d
    : d instanceof ArrayBuffer
      ? new Uint8Array(d)
      : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);

class Sha256 {
  private h: Hash | Hmac;
  constructor(secret?: SourceData) {
    this.h = secret ? createHmac('sha256', bytes(secret)) : createHash('sha256');
  }
  update(data: SourceData) {
    this.h.update(bytes(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.h.digest());
  }
  reset() {}
}

let signer: SignatureV4 | undefined;

/**
 * Publishes to AppSync Events over HTTPS with IAM (design 7.4: realtime
 * nudges). Payloads carry ids only; clients fetch content through the API,
 * which applies the access rules. Failures are logged, never fatal: the
 * message is already saved and the next refresh shows it.
 */
export async function publish(channels: string[], payload: Record<string, unknown>): Promise<void> {
  const host = process.env.EVENTS_HTTP_DOMAIN;
  if (!host || channels.length === 0) return;
  signer ??= new SignatureV4({
    service: 'appsync',
    region: process.env.AWS_REGION ?? 'ap-southeast-2',
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  await Promise.all(
    channels.map(async (channel) => {
      const body = JSON.stringify({ channel, events: [JSON.stringify(payload)] });
      try {
        const req = await signer!.sign({
          method: 'POST',
          protocol: 'https:',
          hostname: host,
          path: '/event',
          headers: { host, 'content-type': 'application/json' },
          body,
        });
        const res = await fetch(`https://${host}/event`, {
          method: 'POST',
          headers: req.headers as Record<string, string>,
          body,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'realtime.publishFailed',
            error: (err as Error).message,
          }),
        );
      }
    }),
  );
}
