import { Effect, ManagedPolicy, PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { names, TAG_ENV, TAG_ROLE, type BmgConfig } from '@bmg/config';
import { allowedRegions } from './common.ts';

/** Global services whose API calls are not tied to the requested region. */
const GLOBAL_SERVICE_ACTIONS = [
  'iam:*',
  'sts:*',
  'organizations:*',
  'cloudfront:*',
  'route53:*',
  'route53domains:*',
  'budgets:*',
  'ce:*',
  'support:*',
  'health:*',
  'trustedadvisor:*',
  'globalaccelerator:*',
  'account:*',
  's3:GetAccountPublicAccessBlock',
  's3:ListAllMyBuckets',
];

/**
 * The account permission boundary (design section 4.2). The app runs in a single
 * AWS account with no SCPs (Organizations only holds the AI services opt-out
 * policy, rev 11), so this boundary does the job SCPs would otherwise do. It
 * is attached to every role the app and pipeline create, including the CDK
 * CloudFormation execution roles of the staging and prod bootstraps.
 */
export function buildPermissionBoundaryDocument(cfg: BmgConfig): PolicyDocument {
  const boundaryArn = `arn:aws:iam::${cfg.account.id}:policy/${names.permissionBoundary(cfg)}`;
  const prodQ = cfg.environments.prod.qualifier;
  const stagingQ = cfg.environments.staging.qualifier;

  return new PolicyDocument({
    statements: [
      new PolicyStatement({
        sid: 'AllowWithinBoundary',
        effect: Effect.ALLOW,
        actions: ['*'],
        resources: ['*'],
      }),
      new PolicyStatement({
        sid: 'DenyOutsideAllowedRegions',
        effect: Effect.DENY,
        notActions: GLOBAL_SERVICE_ACTIONS,
        resources: ['*'],
        conditions: { StringNotEquals: { 'aws:RequestedRegion': allowedRegions(cfg) } },
      }),
      new PolicyStatement({
        sid: 'DenySecurityServiceTampering',
        effect: Effect.DENY,
        actions: [
          'cloudtrail:StopLogging',
          'cloudtrail:DeleteTrail',
          'cloudtrail:UpdateTrail',
          'cloudtrail:PutEventSelectors',
          'guardduty:DeleteDetector',
          'guardduty:UpdateDetector',
          'guardduty:DisassociateFromAdministratorAccount',
          'securityhub:DisableSecurityHub',
          'securityhub:BatchDisableStandards',
          'config:StopConfigurationRecorder',
          'config:DeleteConfigurationRecorder',
          'config:DeleteDeliveryChannel',
          'access-analyzer:DeleteAnalyzer',
        ],
        resources: ['*'],
      }),
      new PolicyStatement({
        sid: 'DenyIamUsersAndKeys',
        effect: Effect.DENY,
        actions: [
          'iam:CreateUser',
          'iam:CreateAccessKey',
          'iam:CreateLoginProfile',
          'iam:UpdateLoginProfile',
        ],
        resources: ['*'],
      }),
      new PolicyStatement({
        sid: 'DenyRolesWithoutThisBoundary',
        effect: Effect.DENY,
        actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        resources: ['*'],
        conditions: { StringNotEquals: { 'iam:PermissionsBoundary': boundaryArn } },
      }),
      new PolicyStatement({
        sid: 'DenyBoundaryRemovalOrEdit',
        effect: Effect.DENY,
        actions: [
          'iam:DeleteRolePermissionsBoundary',
          'iam:DeletePolicy',
          'iam:CreatePolicyVersion',
          'iam:DeletePolicyVersion',
          'iam:SetDefaultPolicyVersion',
        ],
        resources: [boundaryArn, `arn:aws:iam::${cfg.account.id}:role/*`],
      }),
      new PolicyStatement({
        sid: 'DenyKeyDeletionExceptOffboarding',
        effect: Effect.DENY,
        actions: ['kms:ScheduleKeyDeletion', 'kms:DisableKey'],
        resources: ['*'],
        conditions: { StringNotEquals: { [`aws:PrincipalTag/${TAG_ROLE}`]: 'offboarding' } },
      }),
      new PolicyStatement({
        sid: 'DenyCrossEnvironmentAccess',
        effect: Effect.DENY,
        // Role assumption is governed by the two statements below instead.
        notActions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: ['*'],
        conditions: {
          StringNotEquals: { [`aws:ResourceTag/${TAG_ENV}`]: `\${aws:PrincipalTag/${TAG_ENV}}` },
          Null: {
            [`aws:ResourceTag/${TAG_ENV}`]: 'false',
            [`aws:PrincipalTag/${TAG_ENV}`]: 'false',
          },
        },
      }),
      new PolicyStatement({
        sid: 'DenyProdDeployRolesExceptProdPipeline',
        effect: Effect.DENY,
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${cfg.account.id}:role/cdk-${prodQ}-*`],
        conditions: { StringNotEquals: { 'aws:PrincipalTag/bmg:deploy-target': 'prod' } },
      }),
      new PolicyStatement({
        sid: 'DenyStagingDeployRolesExceptStagingPipeline',
        effect: Effect.DENY,
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${cfg.account.id}:role/cdk-${stagingQ}-deploy-role-*`,
          `arn:aws:iam::${cfg.account.id}:role/cdk-${stagingQ}-file-publishing-role-*`,
          `arn:aws:iam::${cfg.account.id}:role/cdk-${stagingQ}-image-publishing-role-*`,
        ],
        conditions: { StringNotEquals: { 'aws:PrincipalTag/bmg:deploy-target': 'staging' } },
      }),
    ],
  });
}

export function createPermissionBoundary(scope: Construct, cfg: BmgConfig): ManagedPolicy {
  return new ManagedPolicy(scope, 'PermissionBoundary', {
    managedPolicyName: names.permissionBoundary(cfg),
    description: 'BMG account guardrails (replaces SCPs; single account, no AWS Organizations)',
    document: buildPermissionBoundaryDocument(cfg),
  });
}
