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
/**
 * What the onboarding task (key-admin role) may do to an artist key: set it
 * up and read it back. Never PutKeyPolicy or grant changes, so a compromised
 * onboarding function can't rewrite a key policy to give itself Decrypt
 * (Phase 6 review, finding K1). Policy changes go through account admins.
 */
export const KEY_ADMIN_ACTIONS = [
  'kms:DescribeKey',
  'kms:GetKeyPolicy',
  'kms:GetKeyRotationStatus',
  'kms:ListResourceTags',
  'kms:EnableKeyRotation',
  'kms:TagResource',
  'kms:CreateAlias',
];

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
        Action: KEY_ADMIN_ACTIONS,
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

/** True if a key's current policy still lets the key-admin role rewrite it. */
export function needsRefresh(currentPolicy: string, keyAdminRoleArn: string): boolean {
  const doc = JSON.parse(currentPolicy) as { Statement?: Record<string, unknown>[] };
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]);
  return (doc.Statement ?? []).some((st) => {
    if (st.Effect !== 'Allow') return false;
    const principals = list((st.Principal as { AWS?: unknown } | undefined)?.AWS);
    if (!principals.includes(keyAdminRoleArn)) return false;
    const actions = list(st.Action);
    return actions.some((a) => KEY_ADMIN_ACTIONS.indexOf(a as string) === -1);
  });
}
