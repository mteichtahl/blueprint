import {
  AttachPolicyCommand,
  CreateOrganizationCommand,
  CreatePolicyCommand,
  DescribeEffectivePolicyCommand,
  DescribeOrganizationCommand,
  EnablePolicyTypeCommand,
  ListPoliciesCommand,
  ListRootsCommand,
  ListTargetsForPolicyCommand,
  OrganizationsClient,
  type Root,
} from '@aws-sdk/client-organizations';
import {
  AI_OPT_OUT_POLICY,
  AI_OPT_OUT_POLICY_NAME,
  AI_OPT_OUT_POLICY_TYPE,
  optedOutOf,
} from '@bmg/config/ai-opt-out';
import { assertAccount, readConfig } from '../lib/aws.ts';
import { executePlan, fail, heading, log, ok, warn, type GlobalOptions } from '../lib/runtime.ts';

/** Organizations is a global service served from us-east-1. */
const orgs = () => new OrganizationsClient({ region: 'us-east-1' });

const notInUse = (err: unknown) =>
  (err as { name?: string }).name === 'AWSOrganizationsNotInUseException';

interface OrgState {
  /** undefined: the account isn't in an organization yet. */
  org?: { id: string; masterAccountId: string; allFeatures: boolean };
  root?: Root;
  policyId?: string;
  attached: boolean;
}

async function readState(client: OrganizationsClient): Promise<OrgState> {
  let described;
  try {
    described = (await client.send(new DescribeOrganizationCommand({}))).Organization;
  } catch (err) {
    if (notInUse(err)) return { attached: false };
    throw err;
  }
  const org = {
    id: described?.Id ?? '',
    masterAccountId: described?.MasterAccountId ?? '',
    allFeatures: described?.FeatureSet === 'ALL',
  };
  const root = (await client.send(new ListRootsCommand({}))).Roots?.[0];
  const policies = await client.send(new ListPoliciesCommand({ Filter: AI_OPT_OUT_POLICY_TYPE }));
  const policyId = policies.Policies?.find((p) => p.Name === AI_OPT_OUT_POLICY_NAME)?.Id;
  let attached = false;
  if (policyId && root?.Id) {
    const targets = await client.send(new ListTargetsForPolicyCommand({ PolicyId: policyId }));
    attached = (targets.Targets ?? []).some((t) => t.TargetId === root.Id);
  }
  return { org, ...(root ? { root } : {}), ...(policyId ? { policyId } : {}), attached };
}

const typeEnabled = (root: Root | undefined) =>
  (root?.PolicyTypes ?? []).some(
    (t) => t.Type === AI_OPT_OUT_POLICY_TYPE && t.Status === 'ENABLED',
  );

/** Whether Amazon Transcribe is opted out for this account, as AWS reports it. */
async function transcribeOptedOut(client: OrganizationsClient, accountId: string) {
  try {
    const res = await client.send(
      new DescribeEffectivePolicyCommand({
        PolicyType: AI_OPT_OUT_POLICY_TYPE,
        TargetId: accountId,
      }),
    );
    return optedOutOf('transcribe', res.EffectivePolicy?.PolicyContent);
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (notInUse(err) || name === 'EffectivePolicyNotFoundException') return false;
    throw err;
  }
}

/**
 * `blueprint ai opt-out`: opt this account out of AWS using its content to
 * improve AI services, which meeting transcription (rev 11) needs. It turns on
 * AWS Organizations with only this account in it, enables the AI services
 * opt-out policy type, and attaches an opt-out-of-everything policy to the
 * root. No other accounts, OUs or SCPs are created; the permission boundary
 * still does the job SCPs would. Safe to re-run: each step checks first.
 */
export async function aiOptOut(opts: GlobalOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const client = orgs();
  const state = await readState(client);

  if (state.org && state.org.masterAccountId !== cfg.account.id) {
    throw new Error(
      `This account is a member of organization ${state.org.id}, managed by account ` +
        `${state.org.masterAccountId}. Ask that account's admin to attach an AI services ` +
        'opt-out policy instead; this command only manages a one-account organization.',
    );
  }
  if (state.org && !state.org.allFeatures) {
    throw new Error(
      'The organization only has consolidated billing. Turn on all features in the AWS ' +
        'Organizations console first (opt-out policies need them), then re-run this command.',
    );
  }

  const steps = [];
  if (!state.org) {
    steps.push({
      description: 'Turn on AWS Organizations (all features) with this account as its only account',
      run: async () => {
        await client.send(new CreateOrganizationCommand({ FeatureSet: 'ALL' }));
        ok('Organization created. No other accounts, OUs or SCPs were added.');
      },
    });
  }
  if (!typeEnabled(state.root)) {
    steps.push({
      description: 'Enable AI services opt-out policies on the root',
      run: async () => {
        const root = state.root ?? (await client.send(new ListRootsCommand({}))).Roots?.[0];
        if (!root?.Id) throw new Error('The organization has no root yet. Try again in a minute.');
        state.root = root;
        if (typeEnabled(root)) return ok('Already enabled');
        await client.send(
          new EnablePolicyTypeCommand({ RootId: root.Id, PolicyType: AI_OPT_OUT_POLICY_TYPE }),
        );
        ok('Enabled');
      },
    });
  }
  if (!state.policyId) {
    steps.push({
      description: `Create the policy ${AI_OPT_OUT_POLICY_NAME} (opt out of every AI service)`,
      run: async () => {
        const created = await client.send(
          new CreatePolicyCommand({
            Name: AI_OPT_OUT_POLICY_NAME,
            Description:
              'BMG: AWS may not store or use our content (meeting audio and transcripts) to improve AI services',
            Type: AI_OPT_OUT_POLICY_TYPE,
            Content: JSON.stringify(AI_OPT_OUT_POLICY),
          }),
        );
        state.policyId = created.Policy?.PolicySummary?.Id;
        ok(`Created ${state.policyId}`);
      },
    });
  }
  if (!state.attached) {
    steps.push({
      description: 'Attach the policy to the root (it then applies to this account)',
      run: async () => {
        const root = state.root ?? (await client.send(new ListRootsCommand({}))).Roots?.[0];
        if (!root?.Id || !state.policyId) throw new Error('Policy or root missing');
        await client.send(new AttachPolicyCommand({ PolicyId: state.policyId, TargetId: root.Id }));
        ok('Attached');
      },
    });
  }

  if (steps.length === 0) {
    heading('AI services opt-out');
    ok('Already set up');
  } else {
    await executePlan('Opt out of AWS AI service improvement', steps, opts);
    if (opts.dryRun) return;
  }
  await aiStatus();
}

/** `blueprint ai status`: is meeting transcription allowed to run? (read-only) */
export async function aiStatus(): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  heading('AI services opt-out');
  const client = orgs();
  const state = await readState(client);
  if (!state.org) {
    fail('This account is not in an organization, so it has no opt-out policy.');
    log('    Run `blueprint ai opt-out` to set it up.');
    return;
  }
  ok(`Organization ${state.org.id} (this account manages it)`);
  (typeEnabled(state.root) ? ok : fail)('AI services opt-out policies enabled on the root');
  (state.attached ? ok : fail)(`${AI_OPT_OUT_POLICY_NAME} attached to the root`);
  if (await transcribeOptedOut(client, cfg.account.id)) {
    ok('Amazon Transcribe is opted out: meeting transcription can run');
  } else {
    fail('Amazon Transcribe is not opted out: meeting transcription stays off');
    warn('It can take a few minutes for a new policy to take effect.');
  }
}
