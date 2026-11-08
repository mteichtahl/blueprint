/**
 * The key policy put on every artist key when it is created (design 9.1).
 * Pure, so the whole policy is unit-tested and reviewed in one place.
 */

export interface ArtistKeyPolicyInput {
  accountId: string;
  artistId: string;
  /** `bmg-<env>-key-admin`: creates keys, never decrypts. */
  keyAdminRoleArn: string;
  /** `bmg-<env>-data-access`: the only role that can use the key, per tagged session. */
  dataAccessRoleArn: string;
}

const ADMIN_ACTIONS = [
  'kms:DescribeKey',
  'kms:GetKeyPolicy',
  'kms:GetKeyRotationStatus',
  'kms:ListResourceTags',
  'kms:ListGrants',
  'kms:ListKeyPolicies',
  'kms:PutKeyPolicy',
  'kms:EnableKeyRotation',
  'kms:TagResource',
  'kms:UntagResource',
  'kms:RetireGrant',
  'kms:RevokeGrant',
];

/** The only actions that touch data. No statement grants them except to the data-access role. */
export const DATA_ACTIONS = [
  'kms:Encrypt',
  'kms:Decrypt',
  'kms:GenerateDataKey',
  'kms:GenerateDataKeyWithoutPlaintext',
];

export function artistKeyPolicy(input: ArtistKeyPolicyInput) {
  const root = `arn:aws:iam::${input.accountId}:root`;
  return {
    Version: '2012-10-17',
    Statement: [
      {
        // Keeps the key manageable (never orphaned) but grants no data access:
        // IAM policies in the account can only ever add these admin actions.
        Sid: 'AccountAdministrationOnly',
        Effect: 'Allow',
        Principal: { AWS: root },
        Action: ADMIN_ACTIONS,
        Resource: '*',
      },
      {
        Sid: 'KeyAdminRole',
        Effect: 'Allow',
        Principal: { AWS: input.keyAdminRoleArn },
        Action: [...ADMIN_ACTIONS, 'kms:CreateAlias'],
        Resource: '*',
      },
      {
        Sid: 'UseOnlyForThisArtist',
        Effect: 'Allow',
        Principal: { AWS: input.dataAccessRoleArn },
        Action: DATA_ACTIONS,
        Resource: '*',
        Condition: {
          StringEquals: {
            'aws:PrincipalTag/artistId': input.artistId,
            'kms:EncryptionContext:artistId': input.artistId,
          },
        },
      },
      {
        Sid: 'DescribeForThisArtist',
        Effect: 'Allow',
        Principal: { AWS: input.dataAccessRoleArn },
        Action: 'kms:DescribeKey',
        Resource: '*',
        Condition: { StringEquals: { 'aws:PrincipalTag/artistId': input.artistId } },
      },
      {
        // "Private" is enforced by KMS, not only by app code (design 9.1).
        Sid: 'PrivateItemsOnlyForTheArtist',
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Action: 'kms:Decrypt',
        Resource: '*',
        Condition: {
          StringEquals: { 'kms:EncryptionContext:visibility': 'private' },
          StringNotEquals: { 'aws:PrincipalTag/role': 'artist' },
        },
      },
      {
        // Crypto-shredding happens only through the offboarding workflow.
        Sid: 'DeletionOnlyByOffboarding',
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Action: ['kms:ScheduleKeyDeletion', 'kms:DisableKey'],
        Resource: '*',
        Condition: { StringNotEquals: { 'aws:PrincipalTag/bmg:role': 'offboarding' } },
      },
    ],
  };
}
