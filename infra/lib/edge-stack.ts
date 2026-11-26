import { CfnOutput } from 'aws-cdk-lib';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { EnvironmentName } from '@bmg/config';
import { BmgStack, type BmgStackProps } from './common.ts';

export interface EdgeStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
}

/** Requests per 5 minutes from one visitor to the APIs (/v1 and /public), as the API WAF had. */
export const EDGE_API_LIMIT = 1000;
/** Requests per 5 minutes from one visitor to the public forms (newsletter, recovery, enquiries). */
export const EDGE_PUBLIC_LIMIT = 100;
/** Requests per 5 minutes from one visitor to anything (pages and assets too). */
export const EDGE_ALL_LIMIT = 3000;

/**
 * CloudFront's own WAF (security review M1), in us-east-1 as CloudFront
 * requires. Here the address is the real visitor's, so the per-IP rate limits
 * and the IP reputation list judge people, not CloudFront edge servers. The
 * regional API WAFs keep their managed rules and body limits, and now rate
 * limit only direct calls (see origin-verify.ts).
 */
export class EdgeStack extends BmgStack {
  readonly webAcl: CfnWebACL;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    const qualifier = props.config.environments[props.envName].qualifier;
    super(scope, id, { ...props, qualifier, envTag: props.envName });
    const p = `${props.config.project}-${props.envName}`;

    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName,
    });
    const pathStarts = (prefix: string): CfnWebACL.StatementProperty => ({
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: 'STARTS_WITH',
        searchString: prefix,
        textTransformations: [{ priority: 0, type: 'NONE' }],
      },
    });
    const rate = (
      name: string,
      priority: number,
      limit: number,
      scopeDownStatement?: CfnWebACL.StatementProperty,
    ): CfnWebACL.RuleProperty => ({
      name,
      priority,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit,
          aggregateKeyType: 'IP',
          ...(scopeDownStatement ? { scopeDownStatement } : {}),
        },
      },
      visibilityConfig: visibility(name),
    });
    const managed = (name: string, priority: number): CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: visibility(name),
    });

    this.webAcl = new CfnWebACL(this, 'Waf', {
      name: `${p}-edge`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`${p}-edge`),
      rules: [
        managed('AWSManagedRulesAmazonIpReputationList', 0),
        rate('RateLimitPublicFormsPerIp', 1, EDGE_PUBLIC_LIMIT, {
          andStatement: {
            statements: [
              pathStarts('/public/'),
              {
                byteMatchStatement: {
                  fieldToMatch: { method: {} },
                  positionalConstraint: 'EXACTLY',
                  searchString: 'POST',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
            ],
          },
        }),
        rate('RateLimitApiPerIp', 2, EDGE_API_LIMIT, {
          orStatement: { statements: [pathStarts('/v1/'), pathStarts('/public/')] },
        }),
        rate('RateLimitAllPerIp', 3, EDGE_ALL_LIMIT),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 4),
      ],
    });
    new CfnOutput(this, 'EdgeWebAclArn', { value: this.webAcl.attrArn });
  }
}
