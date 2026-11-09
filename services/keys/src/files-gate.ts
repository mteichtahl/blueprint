import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import {
  artistKeyAlias,
  DataAccessSessions,
  encryptionContext,
  type SessionRole,
} from '@bmg/crypto';
import {
  attempt,
  failed,
  GATE_ARTISTS,
  respond,
  withRetry,
  type CfnEvent,
  type CheckResult,
  type Outcome,
} from './gate.ts';

/**
 * Staging gate for files (Phase 3): real S3 writes and reads in the
 * artist-data bucket, through data-access sessions, for the two gate artists
 * the isolation gate created. Proves that S3 asks KMS under the session's own
 * tags, so the artist boundary and "private" hold for stored files too.
 */
interface FilesGateDeps {
  dataAccessRoleArn: string;
  bucket: string;
  project: string;
  env: string;
  region: string;
  account: string;
}

export async function runFilesGate(deps: FilesGateDeps): Promise<CheckResult[]> {
  const sessions = new DataAccessSessions(new STSClient({ region: deps.region }));
  const s3As = async (artistId: string, role: SessionRole) =>
    new S3Client({
      region: deps.region,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: await withRetry(() =>
        sessions.credentials({ roleArn: deps.dataAccessRoleArn, artistId, role }),
      ),
    });
  const A = GATE_ARTISTS.a;
  const B = GATE_ARTISTS.b;
  const keyArn = (id: string) =>
    `arn:aws:kms:${deps.region}:${deps.account}:${artistKeyAlias(deps.project, deps.env, id)}`;
  const ctx = (id: string, visibility: 'normal' | 'private' = 'normal') =>
    Buffer.from(JSON.stringify(encryptionContext(id, visibility))).toString('base64');
  const objectKey = (id: string, name: string) => `artists/${id}/gate/${name}`;
  const put = (client: S3Client, key: string, kmsKey: string, context: string) =>
    client.send(
      new PutObjectCommand({
        Bucket: deps.bucket,
        Key: key,
        Body: 'gate',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: kmsKey,
        SSEKMSEncryptionContext: context,
        BucketKeyEnabled: false,
      }),
    );
  const get = (client: S3Client, key: string) =>
    client
      .send(new GetObjectCommand({ Bucket: deps.bucket, Key: key }))
      .then((r) => r.Body?.transformToString());

  const artistA = await s3As(A, 'artist');
  const artistB = await s3As(B, 'artist');
  const staffA = await s3As(A, 'bmg-staff');
  const adminA = await s3As(A, 'bmg-admin');

  const results: CheckResult[] = [];
  const check = async (name: string, expected: Outcome, call: () => Promise<unknown>) => {
    const { outcome, detail } = await attempt(
      expected === 'allowed' ? () => withRetry(call) : call,
    );
    results.push({ name, expected, actual: outcome, ...(detail ? { detail } : {}) });
  };

  await check('artist A stores a file with own key', 'allowed', () =>
    put(artistA, objectKey(A, 'normal'), keyArn(A), ctx(A)),
  );
  await check('artist A reads own file', 'allowed', () => get(artistA, objectKey(A, 'normal')));
  await check('BMG staff read artist A file (scoped to A)', 'allowed', () =>
    get(staffA, objectKey(A, 'normal')),
  );
  await check('artist B reads artist A file', 'denied', () => get(artistB, objectKey(A, 'normal')));
  await check('artist A writes into artist B files', 'denied', () =>
    put(artistA, objectKey(B, 'intruder'), keyArn(B), ctx(B)),
  );
  await check('artist A stores with artist B key', 'denied', () =>
    put(artistA, objectKey(A, 'wrong-key'), keyArn(B), ctx(A)),
  );
  await check('artist A stores with artist B context', 'denied', () =>
    put(artistA, objectKey(A, 'wrong-context'), keyArn(A), ctx(B)),
  );
  await check('artist A stores without encryption', 'denied', () =>
    artistA.send(
      new PutObjectCommand({ Bucket: deps.bucket, Key: objectKey(A, 'plain'), Body: 'x' }),
    ),
  );
  await check('artist A stores a private file', 'allowed', () =>
    put(artistA, objectKey(A, 'private'), keyArn(A), ctx(A, 'private')),
  );
  await check('artist A reads own private file', 'allowed', () =>
    get(artistA, objectKey(A, 'private')),
  );
  await check('BMG staff read a private file', 'denied', () =>
    get(staffA, objectKey(A, 'private')),
  );
  await check('BMG admin reads a private file', 'denied', () =>
    get(adminA, objectKey(A, 'private')),
  );
  return results;
}

function depsFromEnv(): FilesGateDeps {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    dataAccessRoleArn: need('DATA_ACCESS_ROLE_ARN'),
    bucket: need('ARTIST_BUCKET'),
    project: need('PROJECT'),
    env: need('BMG_ENV'),
    region: need('AWS_REGION'),
    account: need('ACCOUNT_ID'),
  };
}

/** CloudFormation custom resource (fails the staging deploy) or direct invoke (returns the report). */
export const handler = async (event: Partial<CfnEvent>) => {
  if (event.RequestType && event.ResponseURL) {
    const cfn = event as CfnEvent;
    if (cfn.RequestType === 'Delete') return respond(cfn, 'SUCCESS', 'nothing to clean up');
    try {
      const results = await runFilesGate(depsFromEnv());
      const bad = failed(results);
      console.log(
        JSON.stringify({ level: bad.length ? 'error' : 'info', event: 'files.gate', results }),
      );
      return respond(
        cfn,
        bad.length ? 'FAILED' : 'SUCCESS',
        bad.length
          ? `Files gate failed: ${bad.map((r) => `${r.name} (expected ${r.expected}, got ${r.actual}${r.detail ? `: ${r.detail}` : ''})`).join('; ')}`
          : `Files gate passed (${results.length} checks)`,
      );
    } catch (err) {
      return respond(cfn, 'FAILED', `Files gate could not run: ${(err as Error).message}`);
    }
  }
  const results = await runFilesGate(depsFromEnv());
  return { passed: failed(results).length === 0, results };
};
