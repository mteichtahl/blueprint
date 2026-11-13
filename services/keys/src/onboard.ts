import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  GetKeyPolicyCommand,
  KMSClient,
  ListAliasesCommand,
  NotFoundException,
  PutKeyPolicyCommand,
} from '@aws-sdk/client-kms';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { artistKeyAlias, assertArtistId, assertStaffSub, staffKeyAlias } from '@bmg/crypto';
import { respond, type CfnEvent } from './gate.ts';
import { artistKeyPolicy, needsRefresh, staffKeyPolicy } from './policy.ts';

const kms = new KMSClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export interface OnboardInput {
  artistId: string;
  /** False only for the isolation gate's test artists, which must not appear in the roster. */
  recordWorkspace?: boolean;
}

export interface OnboardResult {
  artistId: string;
  keyArn: string;
  created: boolean;
}

/**
 * Creates the artist's own KMS key (design F1 step 1). Idempotent: if the
 * alias already exists the existing key is returned, so a retried
 * onboarding never creates a second key.
 */
export async function ensureArtistKey(rawArtistId: string): Promise<OnboardResult> {
  const artistId = assertArtistId(rawArtistId);
  const project = env('PROJECT');
  const bmgEnv = env('BMG_ENV');
  const alias = artistKeyAlias(project, bmgEnv, artistId);

  try {
    const existing = await kms.send(new DescribeKeyCommand({ KeyId: alias }));
    if (existing.KeyMetadata?.Arn) {
      return { artistId, keyArn: existing.KeyMetadata.Arn, created: false };
    }
  } catch (err) {
    if (!(err instanceof NotFoundException)) throw err;
  }

  const policy = artistKeyPolicy({
    accountId: env('ACCOUNT_ID'),
    artistId,
    keyAdminRoleArn: env('KEY_ADMIN_ROLE_ARN'),
    dataAccessRoleArn: env('DATA_ACCESS_ROLE_ARN'),
  });
  const created = await kms.send(
    new CreateKeyCommand({
      Description: `BMG ${bmgEnv}: data key for artist ${artistId}`,
      KeyUsage: 'ENCRYPT_DECRYPT',
      KeySpec: 'SYMMETRIC_DEFAULT',
      Policy: JSON.stringify(policy),
      // The policy deliberately stops this role from changing it later
      // (finding K1), which KMS's lockout check would refuse. The key is not
      // orphaned: the account root keeps policy administration.
      BypassPolicyLockoutSafetyCheck: true,
      Tags: [
        { TagKey: 'artistId', TagValue: artistId },
        { TagKey: 'bmg:env', TagValue: bmgEnv },
        { TagKey: 'bmg:project', TagValue: project },
        { TagKey: 'bmg:managed-by', TagValue: 'onboarding' },
      ],
    }),
  );
  const keyArn = created.KeyMetadata?.Arn;
  const keyId = created.KeyMetadata?.KeyId;
  if (!keyArn || !keyId) throw new Error('CreateKey returned no key');
  await kms.send(new EnableKeyRotationCommand({ KeyId: keyId, RotationPeriodInDays: 365 }));
  await kms.send(new CreateAliasCommand({ AliasName: alias, TargetKeyId: keyId }));
  return { artistId, keyArn, created: true };
}

export interface StaffKeyResult {
  staffSub: string;
  keyArn: string;
  created: boolean;
}

/**
 * Creates a Blueprint person's own KMS key for their copies of team chat keys
 * (decided 13 Nov 2026). Idempotent, like artist keys: an existing alias
 * returns the existing key. Invoked by the chat function when someone is first
 * in a team chat; this role can create keys but never use them.
 */
export async function ensureStaffKey(rawSub: string): Promise<StaffKeyResult> {
  const staffSub = assertStaffSub(rawSub);
  const project = env('PROJECT');
  const bmgEnv = env('BMG_ENV');
  const alias = staffKeyAlias(project, bmgEnv, staffSub);
  try {
    const existing = await kms.send(new DescribeKeyCommand({ KeyId: alias }));
    if (existing.KeyMetadata?.Arn) {
      return { staffSub, keyArn: existing.KeyMetadata.Arn, created: false };
    }
  } catch (err) {
    if (!(err instanceof NotFoundException)) throw err;
  }
  const policy = staffKeyPolicy({
    accountId: env('ACCOUNT_ID'),
    staffSub,
    keyAdminRoleArn: env('KEY_ADMIN_ROLE_ARN'),
    staffDataAccessRoleArn: env('STAFF_DATA_ACCESS_ROLE_ARN'),
  });
  const created = await kms.send(
    new CreateKeyCommand({
      Description: `BMG ${bmgEnv}: team chat key for Blueprint person ${staffSub}`,
      KeyUsage: 'ENCRYPT_DECRYPT',
      KeySpec: 'SYMMETRIC_DEFAULT',
      Policy: JSON.stringify(policy),
      // As for artist keys: this role gives up PutKeyPolicy; the root keeps it.
      BypassPolicyLockoutSafetyCheck: true,
      Tags: [
        { TagKey: 'staffSub', TagValue: staffSub },
        { TagKey: 'bmg:key-kind', TagValue: 'staff' },
        { TagKey: 'bmg:env', TagValue: bmgEnv },
        { TagKey: 'bmg:project', TagValue: project },
        { TagKey: 'bmg:managed-by', TagValue: 'onboarding' },
      ],
    }),
  );
  const keyArn = created.KeyMetadata?.Arn;
  const keyId = created.KeyMetadata?.KeyId;
  if (!keyArn || !keyId) throw new Error('CreateKey returned no key');
  await kms.send(new EnableKeyRotationCommand({ KeyId: keyId, RotationPeriodInDays: 365 }));
  try {
    await kms.send(new CreateAliasCommand({ AliasName: alias, TargetKeyId: keyId }));
  } catch (err) {
    // Two first chats at once: the other call made the alias; use its key.
    if ((err as Error).name !== 'AlreadyExistsException') throw err;
    const won = await kms.send(new DescribeKeyCommand({ KeyId: alias }));
    return { staffSub, keyArn: won.KeyMetadata!.Arn!, created: false };
  }
  console.log(JSON.stringify({ level: 'info', event: 'keys.staffKeyCreated', staffSub }));
  return { staffSub, keyArn, created: true };
}

/** Records the artist and their key in the main table (first workspace record). */
async function recordArtist(result: OnboardResult): Promise<void> {
  try {
    await db.send(
      new PutCommand({
        TableName: env('MAIN_TABLE'),
        Item: {
          PK: `ARTIST#${result.artistId}`,
          SK: 'META',
          type: 'artist',
          artistId: result.artistId,
          keyArn: result.keyArn,
          status: 'onboarding',
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

/**
 * Brings keys made before the Phase 6 review up to the current policy, which
 * no longer lets this role rewrite key policies (finding K1). Runs on every
 * deploy and only touches keys that still have the old policy, so after the
 * first run it changes nothing (and couldn't: the permission is gone).
 */
export async function refreshKeyPolicies(): Promise<{ checked: number; refreshed: number }> {
  const prefix = `alias/${env('PROJECT')}/${env('BMG_ENV')}/artist/`;
  const keyAdminRoleArn = env('KEY_ADMIN_ROLE_ARN');
  let checked = 0;
  let refreshed = 0;
  let Marker: string | undefined;
  do {
    const page = await kms.send(new ListAliasesCommand({ Marker, Limit: 100 }));
    for (const a of page.Aliases ?? []) {
      if (!a.AliasName?.startsWith(prefix) || !a.TargetKeyId) continue;
      const artistId = assertArtistId(a.AliasName.slice(prefix.length));
      checked++;
      const current = await kms.send(
        new GetKeyPolicyCommand({ KeyId: a.TargetKeyId, PolicyName: 'default' }),
      );
      if (!current.Policy || !needsRefresh(current.Policy, keyAdminRoleArn)) continue;
      const policy = artistKeyPolicy({
        accountId: env('ACCOUNT_ID'),
        artistId,
        keyAdminRoleArn,
        dataAccessRoleArn: env('DATA_ACCESS_ROLE_ARN'),
      });
      await kms.send(
        new PutKeyPolicyCommand({
          KeyId: a.TargetKeyId,
          PolicyName: 'default',
          Policy: JSON.stringify(policy),
          // As in CreateKey: this role gives up PutKeyPolicy; the root keeps it.
          BypassPolicyLockoutSafetyCheck: true,
        }),
      );
      refreshed++;
    }
    Marker = page.Truncated ? page.NextMarker : undefined;
  } while (Marker);
  console.log(
    JSON.stringify({ level: 'info', event: 'keys.policiesRefreshed', checked, refreshed }),
  );
  return { checked, refreshed };
}

/**
 * Step Functions task: `{ artistId }` → `{ artistId, keyArn, created }`.
 * Chat function (team chats): `{ staffSub }` → `{ staffSub, keyArn, created }`.
 */
export const handler = async (
  event: OnboardInput | { staffSub: string } | Partial<CfnEvent>,
): Promise<OnboardResult | StaffKeyResult | void> => {
  if ('staffSub' in event && event.staffSub) return ensureStaffKey(event.staffSub);
  // CloudFormation custom resource: refresh existing key policies on deploy.
  if ('RequestType' in event && event.RequestType && event.ResponseURL) {
    const cfn = event as CfnEvent;
    if (cfn.RequestType === 'Delete') return respond(cfn, 'SUCCESS', 'nothing to clean up');
    try {
      const r = await refreshKeyPolicies();
      return respond(cfn, 'SUCCESS', `checked ${r.checked}, refreshed ${r.refreshed}`);
    } catch (err) {
      return respond(cfn, 'FAILED', `key policy refresh failed: ${(err as Error).message}`);
    }
  }
  return onboard(event as OnboardInput);
};

async function onboard(event: OnboardInput): Promise<OnboardResult> {
  const result = await ensureArtistKey(event.artistId);
  if (event.recordWorkspace !== false) await recordArtist(result);
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'keys.artistOnboarded',
      artistId: result.artistId,
      created: result.created,
    }),
  );
  return result;
}
