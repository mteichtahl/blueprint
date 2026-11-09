import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DataAccessSessions, type SessionRole } from '@bmg/crypto';

/**
 * Phase 2 gate (design §19): "a cross-tenant decrypt attempt is denied by KMS".
 * Runs real KMS calls against two permanent test artists in staging, on every
 * staging deploy (as a CloudFormation custom resource) and on demand
 * (`blueprint verify isolation`). Any check that doesn't get the expected answer
 * fails the deploy.
 */

export const GATE_ARTISTS = { a: 'art_isolationgatea', b: 'art_isolationgateb' } as const;

export type Outcome = 'allowed' | 'denied';

export interface CheckResult {
  name: string;
  expected: Outcome;
  actual: Outcome | 'error';
  detail?: string;
}

const DENIAL_ERRORS = new Set([
  'AccessDeniedException',
  'AccessDenied',
  'InvalidCiphertextException',
]);

/** Runs one call and classifies it. Errors that aren't a denial (throttling, network) are reported as errors. */
export async function attempt(
  call: () => Promise<unknown>,
): Promise<{ outcome: Outcome | 'error'; detail?: string }> {
  try {
    await call();
    return { outcome: 'allowed' };
  } catch (err) {
    const name = (err as Error).name;
    if (DENIAL_ERRORS.has(name)) return { outcome: 'denied', detail: name };
    return { outcome: 'error', detail: `${name}: ${(err as Error).message}` };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * IAM and key-policy changes made by the same deploy can take a few seconds to
 * apply, so set-up calls and checks expected to be *allowed* are retried for
 * up to a minute. Checks expected to be denied are never retried.
 */
export async function withRetry<T>(fn: () => Promise<T>, tries = 7, delayMs = 5_000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  throw last;
}

export function failed(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => r.actual !== r.expected);
}

interface GateDeps {
  dataAccessRoleArn: string;
  onboardFunctionName: string;
  region: string;
}

async function ensureGateKeys(deps: GateDeps): Promise<Record<'a' | 'b', string>> {
  const lambda = new LambdaClient({ region: deps.region });
  const keys = {} as Record<'a' | 'b', string>;
  for (const [slot, artistId] of Object.entries(GATE_ARTISTS) as Array<['a' | 'b', string]>) {
    keys[slot] = await withRetry(async () => {
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: deps.onboardFunctionName,
          Payload: Buffer.from(JSON.stringify({ artistId, recordWorkspace: false })),
        }),
      );
      const body = JSON.parse(Buffer.from(res.Payload ?? []).toString() || '{}');
      if (res.FunctionError || !body.keyArn) {
        throw new Error(
          `Could not prepare the gate key for ${artistId}: ${res.FunctionError ?? 'no key'}`,
        );
      }
      return body.keyArn as string;
    });
  }
  return keys;
}

export async function runIsolationGate(deps: GateDeps): Promise<CheckResult[]> {
  const keys = await ensureGateKeys(deps);
  const sessions = new DataAccessSessions(new STSClient({ region: deps.region }));
  const kmsAs = async (artistId: string, role: SessionRole) =>
    new KMSClient({
      region: deps.region,
      credentials: await withRetry(() =>
        sessions.credentials({ roleArn: deps.dataAccessRoleArn, artistId, role }),
      ),
    });
  const A = GATE_ARTISTS.a;
  const B = GATE_ARTISTS.b;
  const ctxA = { artistId: A };
  const ctxB = { artistId: B };
  const ctxAPrivate = { artistId: A, visibility: 'private' };

  const artistA = await kmsAs(A, 'artist');
  const artistB = await kmsAs(B, 'artist');
  const staffA = await kmsAs(A, 'bmg-staff');
  const adminA = await kmsAs(A, 'bmg-admin');

  const results: CheckResult[] = [];
  const check = async (name: string, expected: Outcome, call: () => Promise<unknown>) => {
    const { outcome, detail } = await attempt(
      expected === 'allowed' ? () => withRetry(call) : call,
    );
    results.push({ name, expected, actual: outcome, ...(detail ? { detail } : {}) });
  };

  const sealedForA = await withRetry(() =>
    artistA.send(
      new GenerateDataKeyCommand({ KeyId: keys.a, KeySpec: 'AES_256', EncryptionContext: ctxA }),
    ),
  );
  const blobA = sealedForA.CiphertextBlob!;

  await check('artist A encrypts with own key', 'allowed', () =>
    artistA.send(
      new GenerateDataKeyCommand({ KeyId: keys.a, KeySpec: 'AES_256', EncryptionContext: ctxA }),
    ),
  );
  await check('artist A decrypts own data', 'allowed', () =>
    artistA.send(new DecryptCommand({ CiphertextBlob: blobA, EncryptionContext: ctxA })),
  );
  await check('BMG staff decrypt artist A data (scoped to A)', 'allowed', () =>
    staffA.send(new DecryptCommand({ CiphertextBlob: blobA, EncryptionContext: ctxA })),
  );
  await check('artist B decrypts artist A data', 'denied', () =>
    artistB.send(new DecryptCommand({ CiphertextBlob: blobA, EncryptionContext: ctxA })),
  );
  await check('artist B decrypts artist A data with a forged context', 'denied', () =>
    artistB.send(new DecryptCommand({ CiphertextBlob: blobA, EncryptionContext: ctxB })),
  );
  await check('artist B uses artist A key', 'denied', () =>
    artistB.send(
      new GenerateDataKeyCommand({ KeyId: keys.a, KeySpec: 'AES_256', EncryptionContext: ctxB }),
    ),
  );
  await check('artist A uses own key with artist B context', 'denied', () =>
    artistA.send(
      new GenerateDataKeyCommand({ KeyId: keys.a, KeySpec: 'AES_256', EncryptionContext: ctxB }),
    ),
  );
  await check('artist A uses artist B key', 'denied', () =>
    artistA.send(
      new GenerateDataKeyCommand({ KeyId: keys.b, KeySpec: 'AES_256', EncryptionContext: ctxA }),
    ),
  );

  const sealedPrivate = await withRetry(() =>
    artistA.send(
      new GenerateDataKeyCommand({
        KeyId: keys.a,
        KeySpec: 'AES_256',
        EncryptionContext: ctxAPrivate,
      }),
    ),
  );
  const blobPrivate = sealedPrivate.CiphertextBlob!;
  await check('artist A decrypts own private item', 'allowed', () =>
    artistA.send(
      new DecryptCommand({ CiphertextBlob: blobPrivate, EncryptionContext: ctxAPrivate }),
    ),
  );
  await check('BMG staff decrypt a private item', 'denied', () =>
    staffA.send(
      new DecryptCommand({ CiphertextBlob: blobPrivate, EncryptionContext: ctxAPrivate }),
    ),
  );
  await check('BMG admin decrypts a private item', 'denied', () =>
    adminA.send(
      new DecryptCommand({ CiphertextBlob: blobPrivate, EncryptionContext: ctxAPrivate }),
    ),
  );

  await check('untagged session on the data-access role', 'denied', () =>
    new STSClient({ region: deps.region }).send(
      new AssumeRoleCommand({ RoleArn: deps.dataAccessRoleArn, RoleSessionName: 'gate-untagged' }),
    ),
  );
  return results;
}

function depsFromEnv(): GateDeps {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    dataAccessRoleArn: need('DATA_ACCESS_ROLE_ARN'),
    onboardFunctionName: need('ONBOARD_FUNCTION_NAME'),
    region: need('AWS_REGION'),
  };
}

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
}

async function respond(
  event: CfnEvent,
  status: 'SUCCESS' | 'FAILED',
  reason: string,
): Promise<void> {
  const body = JSON.stringify({
    Status: status,
    Reason: reason.slice(0, 3500),
    PhysicalResourceId: event.PhysicalResourceId ?? 'isolation-gate',
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
 * Two entry points: a CloudFormation custom resource (fails the staging deploy
 * on any unexpected result) and a direct invoke (returns the report).
 */
export const handler = async (event: Partial<CfnEvent>) => {
  if (event.RequestType && event.ResponseURL) {
    const cfn = event as CfnEvent;
    if (cfn.RequestType === 'Delete') return respond(cfn, 'SUCCESS', 'nothing to clean up');
    try {
      const results = await runIsolationGate(depsFromEnv());
      const bad = failed(results);
      console.log(
        JSON.stringify({
          level: bad.length ? 'error' : 'info',
          event: 'keys.isolationGate',
          results,
        }),
      );
      return respond(
        cfn,
        bad.length ? 'FAILED' : 'SUCCESS',
        bad.length
          ? `Isolation gate failed: ${bad.map((r) => `${r.name} (expected ${r.expected}, got ${r.actual}${r.detail ? `: ${r.detail}` : ''})`).join('; ')}`
          : `Isolation gate passed (${results.length} checks)`,
      );
    } catch (err) {
      return respond(cfn, 'FAILED', `Isolation gate could not run: ${(err as Error).message}`);
    }
  }
  const results = await runIsolationGate(depsFromEnv());
  return { passed: failed(results).length === 0, results };
};
