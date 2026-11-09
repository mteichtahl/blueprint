import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  artistKeyAlias,
  DataAccessSessions,
  decryptForArtist,
  encryptForArtist,
  type SessionRole,
} from '@bmg/crypto';
import { artistPk } from '../workspace/model.ts';
import { db, env } from '../lib.ts';
import {
  connSk,
  ORG_CONNECTORS_PK,
  statsPk,
  statsSk,
  WEB_DETAIL_SK,
  type ConnectionView,
  type ConnStatus,
  type Provider,
  type Settings,
  type Snapshot,
} from './catalog.ts';
import type { ClientCreds, Tokens, WebDetail } from './vendors.ts';

const kms = new KMSClient({});
const secrets = new SecretsManagerClient({});
const ssm = new SSMClient({});
const sessions = new DataAccessSessions();
const table = () => env('MAIN_TABLE');

/** `bmg` for Blueprint's own connectors, otherwise an artist id. */
export type Account = string;
export const isOrg = (a: Account) => a === 'bmg';
const pkOf = (a: Account) => (isOrg(a) ? ORG_CONNECTORS_PK : artistPk(a));

export interface ConnectionItem extends ConnectionView {
  account_: Account;
  /** Sealed Tokens (KMS or Encryption SDK ciphertext). */
  sealed: Uint8Array;
  connectedBy: string;
  /** Set when a needs-reauth notice was sent, so it is sent once. */
  reauthNotifiedAt?: string;
}

// ── Sealing: org tokens under the platform key, artist tokens under the artist's key ──
export async function seal(account: Account, connectorId: string, t: Tokens, role: SessionRole) {
  const plain = Buffer.from(JSON.stringify(t));
  if (isOrg(account)) {
    const res = await kms.send(
      new EncryptCommand({
        KeyId: env('PLATFORM_KEY_ARN'),
        Plaintext: plain,
        EncryptionContext: { purpose: 'connector', account: 'bmg', connector: connectorId },
      }),
    );
    return res.CiphertextBlob!;
  }
  return encryptForArtist(await artistCipher(account, role), plain);
}

export async function open(
  account: Account,
  connectorId: string,
  sealed: Uint8Array,
  role: SessionRole,
): Promise<Tokens> {
  if (isOrg(account)) {
    const res = await kms.send(
      new DecryptCommand({
        CiphertextBlob: sealed,
        EncryptionContext: { purpose: 'connector', account: 'bmg', connector: connectorId },
      }),
    );
    return JSON.parse(Buffer.from(res.Plaintext!).toString('utf8')) as Tokens;
  }
  const { plaintext } = await decryptForArtist(await artistCipher(account, role), sealed);
  return JSON.parse(Buffer.from(plaintext).toString('utf8')) as Tokens;
}

async function artistCipher(artistId: string, role: SessionRole) {
  const credentials = await sessions.credentials({
    roleArn: env('DATA_ACCESS_ROLE_ARN'),
    artistId,
    role,
  });
  const alias = artistKeyAlias(env('PROJECT'), env('BMG_ENV'), artistId);
  return {
    keyId: `arn:aws:kms:${env('AWS_REGION')}:${env('ACCOUNT_ID')}:${alias}`,
    artistId,
    credentials,
  };
}

// ── Connections ──────────────────────────────────────────────────────────
export async function loadConnection(account: Account, connectorId: string) {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: pkOf(account), SK: connSk(connectorId) } }),
  );
  return res.Item as ConnectionItem | undefined;
}

export async function listConnections(account: Account): Promise<ConnectionItem[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :c)',
      ExpressionAttributeValues: { ':pk': pkOf(account), ':c': 'CONN#' },
      Limit: 50,
    }),
  );
  return (res.Items ?? []) as ConnectionItem[];
}

export async function saveConnection(item: ConnectionItem) {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: pkOf(item.account_),
        SK: connSk(item.connectorId),
        type: 'connector',
        // Every connection is listed for the scheduled sync (GSI1 by kind).
        GSI1PK: 'CONNECTORS',
        GSI1SK: `${item.account_}#${item.connectorId}`,
        ...item,
      },
    }),
  );
}

export async function deleteConnection(account: Account, connectorId: string) {
  await db.send(
    new DeleteCommand({ TableName: table(), Key: { PK: pkOf(account), SK: connSk(connectorId) } }),
  );
}

/** All connections, for the scheduled sync. */
export async function allConnections(): Promise<ConnectionItem[]> {
  const out: ConnectionItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :k',
        ExpressionAttributeValues: { ':k': 'CONNECTORS' },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    out.push(...((res.Items ?? []) as ConnectionItem[]));
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** Strips storage fields and the sealed tokens before a connection leaves the API. */
export function view(c: ConnectionItem): ConnectionView {
  return {
    connectorId: c.connectorId,
    status: c.status,
    ...(c.account ? { account: c.account } : {}),
    ...(c.accounts ? { accounts: c.accounts } : {}),
    ...(c.settings ? { settings: c.settings } : {}),
    ...(c.choices ? { choices: c.choices } : {}),
    connectedAt: c.connectedAt,
    ...(c.lastSyncAt ? { lastSyncAt: c.lastSyncAt } : {}),
    ...(c.lastError ? { lastError: c.lastError } : {}),
    ...(c.expiresAt ? { expiresAt: c.expiresAt } : {}),
  };
}

export function withStatus(
  c: ConnectionItem,
  status: ConnStatus,
  extra: Partial<ConnectionItem> = {},
): ConnectionItem {
  const next = { ...c, status, ...extra };
  if (status === 'connected') delete next.lastError;
  return next;
}

export function mergeSettings(c: ConnectionItem, s: Settings): ConnectionItem {
  return { ...c, settings: { ...(c.settings ?? {}), ...(s as Record<string, string>) } };
}

// ── OAuth state (10 minutes, one use) ─────────────────────────────────────
export interface OAuthState {
  account: Account;
  connectorId: string;
  sub: string;
  verifier?: string;
}

export async function putState(state: string, s: OAuthState, ttlSeconds: number) {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: {
        PK: `OAUTH#${state}`,
        SK: 'STATE',
        ...s,
        ttl: Math.floor(Date.now() / 1000) + ttlSeconds,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

/** Reads and deletes in one step, so a state works once. */
export async function takeState(state: string): Promise<OAuthState | undefined> {
  const res = await db.send(
    new DeleteCommand({
      TableName: table(),
      Key: { PK: `OAUTH#${state}`, SK: 'STATE' },
      ReturnValues: 'ALL_OLD',
    }),
  );
  const item = res.Attributes;
  if (!item || Number(item.ttl) < Math.floor(Date.now() / 1000)) return undefined;
  return item as unknown as OAuthState;
}

// ── App credentials and the redirect address ─────────────────────────────
const credsCache = new Map<Provider, ClientCreds | null>();
export async function clientCreds(provider: Provider): Promise<ClientCreds | undefined> {
  if (credsCache.has(provider)) return credsCache.get(provider) ?? undefined;
  try {
    const res = await secrets.send(
      new GetSecretValueCommand({ SecretId: `${env('CONNECTOR_SECRET_PREFIX')}/${provider}` }),
    );
    const v = JSON.parse(res.SecretString ?? '{}') as Partial<ClientCreds>;
    const creds = v.clientId && v.clientSecret ? (v as ClientCreds) : null;
    credsCache.set(provider, creds);
    return creds ?? undefined;
  } catch {
    credsCache.set(provider, null);
    return undefined;
  }
}

let appUrl: string | undefined;
export async function redirectUri(): Promise<string> {
  if (!appUrl) {
    const res = await ssm.send(new GetParameterCommand({ Name: env('APP_URL_PARAM') }));
    appUrl = (res.Parameter?.Value ?? '').replace(/\/$/, '');
  }
  return `${appUrl}/connectors/callback`;
}

// ── Snapshots ────────────────────────────────────────────────────────────
const SNAPSHOT_TTL_DAYS = 800;

export async function writeSnapshots(account: Account, snaps: Snapshot[]) {
  const ttl = Math.floor(Date.now() / 1000) + SNAPSHOT_TTL_DAYS * 86400;
  for (let i = 0; i < snaps.length; i += 25) {
    await db.send(
      new BatchWriteCommand({
        RequestItems: {
          [table()]: snaps.slice(i, i + 25).map((s) => ({
            PutRequest: {
              Item: {
                PK: statsPk(account),
                SK: statsSk(s.date, s.source),
                type: 'stat',
                ...s,
                ttl,
              },
            },
          })),
        },
      }),
    );
  }
}

export async function readSnapshots(account: Account, from: string): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await db.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': statsPk(account), ':a': from, ':b': '9999' },
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    for (const item of res.Items ?? []) {
      const rest: Record<string, unknown> = { ...item };
      for (const k of ['PK', 'SK', 'type', 'ttl']) delete rest[k];
      out.push(rest as unknown as Snapshot);
    }
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

export async function writeWebDetail(detail: WebDetail, at: string) {
  await db.send(
    new PutCommand({
      TableName: table(),
      Item: { PK: statsPk('bmg'), SK: WEB_DETAIL_SK, ...detail, at },
    }),
  );
}

export async function readWebDetail(): Promise<(WebDetail & { at: string }) | undefined> {
  const res = await db.send(
    new GetCommand({ TableName: table(), Key: { PK: statsPk('bmg'), SK: WEB_DETAIL_SK } }),
  );
  return res.Item as (WebDetail & { at: string }) | undefined;
}
