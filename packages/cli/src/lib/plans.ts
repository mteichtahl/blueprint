/**
 * Pure builders for everything the CLI runs. Keeping these free of I/O makes the
 * exact commands and API calls reviewable and unit-tested.
 */
import { names, type BmgConfig, type EnvironmentName } from '@bmg/config';

export const ENVIRONMENTS: EnvironmentName[] = ['staging', 'prod'];

// ---- CDK bootstrap -------------------------------------------------------------------

export interface BootstrapSpec {
  label: string;
  qualifier: string;
  args: string[];
}

function bootstrapTargets(cfg: BmgConfig): string[] {
  return [cfg.account.homeRegion, cfg.account.edgeRegion].map(
    (region) => `aws://${cfg.account.id}/${region}`,
  );
}

/** Tooling bootstrap: used by admin-deployed account and tooling stacks. No boundary. */
export function toolingBootstrap(cfg: BmgConfig): BootstrapSpec {
  const q = cfg.toolingQualifier;
  return {
    label: `tooling (${q})`,
    qualifier: q,
    args: [
      'bootstrap',
      ...bootstrapTargets(cfg),
      '--qualifier',
      q,
      '--toolkit-stack-name',
      `CDKToolkit-${q}`,
      '--tags',
      'bmg:env=tooling',
      '--termination-protection',
    ],
  };
}

/**
 * Environment bootstraps: separate roles per environment, tagged with bmg:env,
 * and the CloudFormation execution role is held inside the account permission
 * boundary (design 4.1 / 4.2).
 */
export function envBootstrap(cfg: BmgConfig, env: EnvironmentName): BootstrapSpec {
  const q = cfg.environments[env].qualifier;
  return {
    label: `${env} (${q})`,
    qualifier: q,
    args: [
      'bootstrap',
      ...bootstrapTargets(cfg),
      '--qualifier',
      q,
      '--toolkit-stack-name',
      `CDKToolkit-${q}`,
      '--tags',
      `bmg:env=${env}`,
      '--custom-permissions-boundary',
      names.permissionBoundary(cfg),
      '--cloudformation-execution-policies',
      'arn:aws:iam::aws:policy/AdministratorAccess',
      '--termination-protection',
    ],
  };
}

// ---- CDK deploy ------------------------------------------------------------------------

export interface SkipServices {
  guardDuty?: boolean;
  securityHub?: boolean;
  config?: boolean;
  accessAnalyzer?: boolean;
}

export interface ExistingServiceIds {
  guardDuty: string[];
  securityHub: string[];
  config: string[];
  accessAnalyzer: string[];
}

/** CloudFormation resource statuses that mean the stack really manages the resource. */
export function isLiveResourceStatus(status: string | undefined): boolean {
  return (
    !!status &&
    /(CREATE|UPDATE|IMPORT)_COMPLETE$|UPDATE_IN_PROGRESS$|UPDATE_FAILED$/.test(status) &&
    !status.startsWith('DELETE')
  );
}

/**
 * A service is "external" (skip creating it) when an instance exists that our
 * stack does not own. AWS allows one detector / hub / recorder / account
 * analyzer per region, so creating another would fail.
 */
export function externalServices(
  existing: ExistingServiceIds,
  owned: Set<string>,
): Required<SkipServices> {
  const external = (ids: string[]) => ids.some((id) => !owned.has(id));
  return {
    guardDuty: external(existing.guardDuty),
    securityHub: external(existing.securityHub),
    config: external(existing.config),
    accessAnalyzer: external(existing.accessAnalyzer),
  };
}

/** Pipeline-deployed stacks per environment, in deploy order. */
export const ENV_STACK_SUFFIXES = [
  'foundation',
  'data',
  'identity',
  'keys',
  'audit',
  'api',
  'web',
] as const;

export function accountStacks(cfg: BmgConfig): string[] {
  return [names.stack(cfg, 'account-guardrails'), names.stack(cfg, 'account-global')];
}

export function deployArgs(stacks: string[], skip: SkipServices = {}): string[] {
  const ctx: string[] = [];
  if (skip.guardDuty) ctx.push('-c', 'bmg:skipGuardDuty=true');
  if (skip.securityHub) ctx.push('-c', 'bmg:skipSecurityHub=true');
  if (skip.config) ctx.push('-c', 'bmg:skipConfig=true');
  if (skip.accessAnalyzer) ctx.push('-c', 'bmg:skipAccessAnalyzer=true');
  return ['deploy', ...stacks, '--require-approval', 'broadening', ...ctx];
}

// ---- GitHub repository protection (design 16.2-16.4) ------------------------------------

export interface GhRequest {
  description: string;
  method: 'GET' | 'PUT' | 'PATCH' | 'POST';
  path: string;
  body?: unknown;
}

export const REQUIRED_CHECKS = ['CI checks', 'Workflow policy', 'Secret scan'];

export function githubProtectionRequests(cfg: BmgConfig, reviewerIds: number[]): GhRequest[] {
  const repo = `/repos/${cfg.github.owner}/${cfg.github.repo}`;
  return [
    {
      description: 'Make the repository public and squash-merge only (D14, O6)',
      method: 'PATCH',
      path: repo,
      body: {
        visibility: 'public',
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        delete_branch_on_merge: true,
      },
    },
    {
      description: 'Turn on secret scanning with push protection',
      method: 'PATCH',
      path: repo,
      body: {
        security_and_analysis: {
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
        },
      },
    },
    {
      description: 'Turn on Dependabot vulnerability alerts (D10)',
      method: 'PUT',
      path: `${repo}/vulnerability-alerts`,
    },
    {
      description: 'Allow only GitHub-owned and listed actions, pinned to full SHAs',
      method: 'PUT',
      path: `${repo}/actions/permissions`,
      body: { enabled: true, allowed_actions: 'selected', sha_pinning_required: true },
    },
    {
      description: 'Allow-list third-party actions',
      method: 'PUT',
      path: `${repo}/actions/permissions/selected-actions`,
      body: {
        github_owned_allowed: true,
        verified_allowed: false,
        patterns_allowed: ['gitleaks/gitleaks-action@*'],
      },
    },
    {
      description: 'Require approval before workflows run for ALL external contributors (16.4)',
      method: 'PUT',
      path: `${repo}/actions/permissions/fork-pr-contributor-approval`,
      body: { approval_policy: 'all_external_contributors' },
    },
    {
      description: 'Default workflow token is read-only and cannot approve PRs',
      method: 'PUT',
      path: `${repo}/actions/permissions/workflow`,
      body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    },
    {
      description: 'Create the staging environment (protected branches only)',
      method: 'PUT',
      path: `${repo}/environments/staging`,
      body: {
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
    },
    {
      description: `Create the production environment with required reviewers (${cfg.github.productionReviewers.join(', ')})`,
      method: 'PUT',
      path: `${repo}/environments/production`,
      body: {
        reviewers: reviewerIds.map((id) => ({ type: 'User', id })),
        prevent_self_review: false,
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
    },
    {
      description: `Protect main: required checks (${REQUIRED_CHECKS.join(', ')}), linear history, no force push`,
      method: 'PUT',
      path: `${repo}/branches/main/protection`,
      body: {
        required_status_checks: { strict: true, contexts: REQUIRED_CHECKS },
        enforce_admins: false,
        // Solo maintainer: GitHub does not let you approve your own PR, so reviews are
        // not required on merge; production deploys still need an environment reviewer.
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          require_code_owner_reviews: false,
          dismiss_stale_reviews: true,
        },
        restrictions: null,
        required_linear_history: true,
        allow_force_pushes: false,
        allow_deletions: false,
        required_conversation_resolution: true,
      },
    },
    {
      description: 'Require signed commits on main',
      method: 'POST',
      path: `${repo}/branches/main/protection/required_signatures`,
    },
  ];
}

// ---- Gmail SMTP (design 7.4) -----------------------------------------------------------

export interface SmtpSecret {
  host: string;
  port: number;
  /** true for 465 (implicit TLS); 587 upgrades with STARTTLS. */
  secure: boolean;
  username: string;
  password: string;
  from: string;
}

/**
 * Gmail app passwords are 16 letters, shown in four groups of four.
 * Normalise what the user pastes and reject anything else early.
 */
export function normaliseAppPassword(raw: string): string {
  const pw = raw.replace(/\s+/g, '').toLowerCase();
  if (!/^[a-z]{16}$/.test(pw)) {
    throw new Error('A Gmail app password is 16 letters (e.g. "abcd efgh ijkl mnop").');
  }
  return pw;
}

export function smtpSecretPayload(cfg: BmgConfig, appPassword: string): SmtpSecret {
  return {
    host: cfg.email.smtpHost,
    port: cfg.email.smtpPort,
    secure: cfg.email.smtpPort === 465,
    username: cfg.email.senderAddress,
    password: normaliseAppPassword(appPassword),
    from: `"${cfg.email.senderName}" <${cfg.email.senderAddress}>`,
  };
}

export interface DnsFindings {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
}

export function evaluateMailDns(
  spfTxt: string[],
  dkimTxt: string[],
  dmarcTxt: string[],
): DnsFindings {
  return {
    spf: spfTxt.some((t) => t.startsWith('v=spf1') && t.includes('include:_spf.google.com')),
    dkim: dkimTxt.some((t) => t.replace(/\s/g, '').startsWith('v=DKIM1')),
    dmarc: dmarcTxt.some((t) => t.startsWith('v=DMARC1')),
  };
}

// ---- Misc ---------------------------------------------------------------------------------

export function nodeVersionOk(version: string, min = [22, 12, 0]): boolean {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export const SECRET_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function secretId(cfg: BmgConfig, env: EnvironmentName, name: string): string {
  if (!SECRET_NAME.test(name)) {
    throw new Error(`Secret name "${name}" must be lowercase letters, digits and dashes`);
  }
  return `${cfg.project}/${env}/${name}`;
}

export const RUNNER_KINDS = ['ci', 'deploy-staging', 'deploy-prod'] as const;

/**
 * Named resources in the tooling stack that CloudFormation keeps when the stack
 * is deleted (RemovalPolicy.RETAIN). After a failed first deploy they are left
 * behind and block the next create, so `pipeline deploy` removes them.
 */
export function toolingRetainedResources(cfg: BmgConfig) {
  return {
    repository: names.agentRepository(cfg),
    logGroups: RUNNER_KINDS.map((k) => names.runnerLogGroup(cfg, k)),
  };
}

/** Split firing alarms into BMG's own (named `<project>-…`) and other workloads'. */
export function partitionAlarms<T extends { name: string }>(alarms: T[], project: string) {
  const ours = alarms.filter((a) => a.name.startsWith(`${project}-`));
  return { ours, others: alarms.filter((a) => !ours.includes(a)) };
}
