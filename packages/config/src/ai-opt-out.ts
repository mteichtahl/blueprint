/**
 * AWS AI services opt-out (rev 11, meeting transcripts).
 *
 * Amazon Transcribe may keep and use audio and transcripts to improve the
 * service unless the account opts out, and the only way to opt out is an
 * AWS Organizations AI services opt-out policy. A standalone account can't
 * have one, so `blueprint ai opt-out` turns on Organizations with just this
 * one account in it (no other accounts, OUs or SCPs) and attaches this policy
 * to the root. Transcription checks the account's effective policy before
 * every job and refuses to run without it.
 *
 * Bedrock (summaries, plan suggestions) isn't covered: it doesn't use
 * customer content for service improvement.
 */

/** The policy's name in Organizations. */
export const AI_OPT_OUT_POLICY_NAME = 'bmg-ai-services-opt-out';

/** Policy type to enable on the root. */
export const AI_OPT_OUT_POLICY_TYPE = 'AISERVICES_OPT_OUT_POLICY';

/**
 * Opt out of every AI service, now and in future, and stop any child policy
 * from opting back in.
 */
export const AI_OPT_OUT_POLICY = {
  services: {
    default: {
      opt_out_policy: {
        '@@operators_allowed_for_child_policies': ['@@none'],
        '@@assign': 'optOut',
      },
    },
  },
} as const;

/**
 * Whether an account's effective AI opt-out policy (the JSON string from
 * `DescribeEffectivePolicy`) opts `service` out. A service-specific setting
 * wins; otherwise `default` applies. Anything unreadable counts as not opted
 * out, so transcription fails closed.
 */
export function optedOutOf(service: string, effectivePolicyContent: string | undefined): boolean {
  if (!effectivePolicyContent) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(effectivePolicyContent);
  } catch {
    return false;
  }
  const services = (doc as { services?: Record<string, unknown> } | null)?.services;
  if (!services || typeof services !== 'object') return false;
  const setting = (entry: unknown): string | undefined => {
    const v = (entry as { opt_out_policy?: unknown } | undefined)?.opt_out_policy;
    if (typeof v === 'string') return v;
    // Effective policies are resolved, but accept the authoring form too.
    const assigned = (v as { '@@assign'?: unknown } | undefined)?.['@@assign'];
    return typeof assigned === 'string' ? assigned : undefined;
  };
  const own = setting(services[service]);
  if (own !== undefined) return own === 'optOut';
  return setting(services.default) === 'optOut';
}
