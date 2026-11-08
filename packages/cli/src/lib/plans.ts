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
}

export function accountStacks(cfg: BmgConfig): string[] {
  return [names.stack(cfg, 'account-guardrails'), names.stack(cfg, 'account-global')];
}

export function deployArgs(stacks: string[], skip: SkipServices = {}): string[] {
  const ctx: string[] = [];
  if (skip.guardDuty) ctx.push('-c', 'bmg:skipGuardDuty=true');
  if (skip.securityHub) ctx.push('-c', 'bmg:skipSecurityHub=true');
  if (skip.config) ctx.push('-c', 'bmg:skipConfig=true');
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

// ---- Google Workspace mail sending (design 7.4) -----------------------------------------

export const WIF_POOL = 'bmg-aws';
export const WIF_PROVIDER = 'bmg-aws-account';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export function serviceAccountEmail(cfg: BmgConfig): string {
  return `${cfg.google.serviceAccountName}@${cfg.google.gcpProjectId}.iam.gserviceaccount.com`;
}

export function mailerRoles(cfg: BmgConfig): string[] {
  return ENVIRONMENTS.map((env) => names.mailerRole(cfg, env));
}

/** gcloud commands, in order. `projectNumber` is resolved after the project exists. */
export function googleSetupCommands(
  cfg: BmgConfig,
  projectNumber: string,
): { description: string; args: string[] }[] {
  const p = cfg.google.gcpProjectId;
  const sa = serviceAccountEmail(cfg);
  const roles = mailerRoles(cfg);
  const principal = (role: string) =>
    `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.aws_role/${role}`;

  return [
    {
      description: 'Enable the IAM, STS and Gmail APIs',
      args: [
        'services',
        'enable',
        'iam.googleapis.com',
        'iamcredentials.googleapis.com',
        'sts.googleapis.com',
        'gmail.googleapis.com',
        '--project',
        p,
      ],
    },
    {
      description: `Create service account ${sa} (no keys are ever created)`,
      args: [
        'iam',
        'service-accounts',
        'create',
        cfg.google.serviceAccountName,
        '--display-name',
        'BMG app mailer (send-only)',
        '--project',
        p,
      ],
    },
    {
      description: `Create workload identity pool ${WIF_POOL}`,
      args: [
        'iam',
        'workload-identity-pools',
        'create',
        WIF_POOL,
        '--location',
        'global',
        '--display-name',
        'BMG AWS account',
        '--project',
        p,
      ],
    },
    {
      description: `Trust AWS account ${cfg.account.id}, limited to roles ${roles.join(', ')}`,
      args: [
        'iam',
        'workload-identity-pools',
        'providers',
        'create-aws',
        WIF_PROVIDER,
        '--workload-identity-pool',
        WIF_POOL,
        '--location',
        'global',
        '--account-id',
        cfg.account.id,
        '--attribute-mapping',
        "google.subject=assertion.arn,attribute.aws_role=assertion.arn.extract('assumed-role/{role}/')",
        '--attribute-condition',
        `attribute.aws_role in [${roles.map((r) => `'${r}'`).join(', ')}]`,
        '--project',
        p,
      ],
    },
    ...roles.flatMap((role) => [
      {
        description: `Let ${role} act as the mailer service account`,
        args: [
          'iam',
          'service-accounts',
          'add-iam-policy-binding',
          sa,
          '--role',
          'roles/iam.workloadIdentityUser',
          '--member',
          principal(role),
          '--project',
          p,
        ],
      },
      {
        description: `Let ${role} sign the delegation JWT (signJwt) for the mailer`,
        args: [
          'iam',
          'service-accounts',
          'add-iam-policy-binding',
          sa,
          '--role',
          'roles/iam.serviceAccountTokenCreator',
          '--member',
          principal(role),
          '--project',
          p,
        ],
      },
    ]),
  ];
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
