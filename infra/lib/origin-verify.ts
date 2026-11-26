import { SecretValue } from 'aws-cdk-lib';
import type { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { names, type BmgConfig, type EnvironmentName } from '@bmg/config';

/**
 * Security review M1. The APIs sit behind CloudFront, so their regional WAFs
 * see a CloudFront edge server's address, shared by everyone in that city,
 * not the visitor's. Per-IP rate limits there would block a whole city for one
 * noisy client. The per-visitor limits now live on CloudFront's own WAF (the
 * edge stack); CloudFront sends this header with a secret value to the APIs,
 * and the regional rate rules apply only to requests without it (someone
 * calling execute-api directly, where the address is real).
 */
export const ORIGIN_VERIFY_HEADER = 'x-bmg-origin-verify';

/**
 * The secret's value as a CloudFormation dynamic reference, resolved at deploy
 * time (it never appears in the template). Stacks deployed after the API
 * stack, which creates the secret, use this.
 */
export function originVerifyValue(cfg: BmgConfig, env: EnvironmentName): string {
  return SecretValue.secretsManager(names.originVerifySecret(cfg, env)).unsafeUnwrap();
}

/** Matches requests that came through CloudFront (the header with the right value). */
export function viaCloudFront(value: string): CfnWebACL.StatementProperty {
  return {
    byteMatchStatement: {
      fieldToMatch: { singleHeader: { Name: ORIGIN_VERIFY_HEADER } },
      positionalConstraint: 'EXACTLY',
      searchString: value,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  };
}

/** A per-IP rate rule for direct calls only: CloudFront traffic is limited at the edge. */
export function directRateLimit(limit: number, value: string): CfnWebACL.StatementProperty {
  return {
    rateBasedStatement: {
      limit,
      aggregateKeyType: 'IP',
      scopeDownStatement: { notStatement: { statement: viaCloudFront(value) } },
    },
  };
}
