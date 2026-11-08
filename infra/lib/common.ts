import { DefaultStackSynthesizer, Stack, Tags, Validations, type StackProps } from 'aws-cdk-lib';
import { ManagedPolicy, PermissionsBoundary } from 'aws-cdk-lib/aws-iam';
import type { Construct, IConstruct } from 'constructs';
import { names, TAG_ENV, type BmgConfig } from '@bmg/config';

export type BmgEnvTag = 'tooling' | 'staging' | 'prod' | 'account';

export interface BmgStackProps extends StackProps {
  readonly config: BmgConfig;
  /** CDK bootstrap qualifier used to deploy this stack. */
  readonly qualifier: string;
  /** Value of the bmg:env tag applied to every resource in the stack. */
  readonly envTag: BmgEnvTag;
  /** Attach the account permission boundary to every IAM role in the stack. */
  readonly applyBoundary?: boolean;
}

/**
 * Base stack: fixed account/region, the right bootstrap qualifier, the env tag
 * on every resource, and (by default) the account permission boundary on every
 * role — design section 4.2.
 */
export class BmgStack extends Stack {
  readonly config: BmgConfig;

  constructor(scope: Construct, id: string, props: BmgStackProps) {
    super(scope, id, {
      ...props,
      synthesizer: new DefaultStackSynthesizer({ qualifier: props.qualifier }),
      terminationProtection: props.terminationProtection ?? true,
    });
    this.config = props.config;
    Tags.of(this).add(TAG_ENV, props.envTag);
    Tags.of(this).add('bmg:project', props.config.project);
    Tags.of(this).add('bmg:managed-by', 'cdk');
    if (props.applyBoundary ?? true) {
      PermissionsBoundary.of(this).apply(
        ManagedPolicy.fromManagedPolicyName(
          this,
          'Boundary',
          names.permissionBoundary(props.config),
        ),
      );
    }
  }
}

/** Regions the account may use: home (workloads), edge (us-east-1), backup copies. */
export function allowedRegions(cfg: BmgConfig): string[] {
  return [...new Set([cfg.account.homeRegion, cfg.account.edgeRegion, cfg.account.backupRegion])];
}

/** ARNs of the CDK bootstrap roles for one qualifier, in every region it is bootstrapped. */
export function cdkRoleArns(
  cfg: BmgConfig,
  qualifierValue: string,
  kinds: Array<'deploy' | 'file-publishing' | 'image-publishing' | 'lookup'>,
): string[] {
  const regions = [cfg.account.homeRegion, cfg.account.edgeRegion];
  return kinds.flatMap((kind) =>
    regions.map(
      (region) =>
        `arn:aws:iam::${cfg.account.id}:role/cdk-${qualifierValue}-${kind}-role-${cfg.account.id}-${region}`,
    ),
  );
}

/**
 * Acknowledge specific cdk-nag findings on a construct, with the reason recorded
 * in the cloud assembly. `findings` are the bracketed ids cdk-nag reports, e.g.
 * `AwsSolutions-IAM5[Action::kms:GenerateDataKey*]`.
 */
export function acknowledge(scope: IConstruct, reason: string, ...findings: string[]): void {
  for (const finding of findings) {
    Validations.of(scope).acknowledge({ id: `AwsSolutions::${finding}`, reason });
  }
}

/** The KMS action families CDK's key.grantEncryptDecrypt() emits. */
export const KMS_GRANT_FINDINGS = [
  'AwsSolutions-IAM5[Action::kms:GenerateDataKey*]',
  'AwsSolutions-IAM5[Action::kms:ReEncrypt*]',
];
