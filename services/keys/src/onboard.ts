import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  KMSClient,
  NotFoundException,
} from '@aws-sdk/client-kms';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { artistKeyAlias, assertArtistId } from '@bmg/crypto';
import { artistKeyPolicy } from './policy.ts';

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

/** Step Functions task: `{ artistId }` → `{ artistId, keyArn, created }`. */
export const handler = async (event: OnboardInput): Promise<OnboardResult> => {
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
};
