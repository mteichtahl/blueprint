import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * bmg.config.json holds NON-SECRET settings only. The repo is public, so
 * anything secret (API keys, client secrets, signing material) lives in
 * AWS Secrets Manager and is set with `blueprint secrets set`.
 */

const awsAccountId = z.string().regex(/^\d{12}$/, 'must be a 12-digit AWS account id');
const awsRegion = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'must be an AWS region code');
/** CDK bootstrap qualifiers: lowercase alphanumeric, max 10 characters. */
const qualifier = z.string().regex(/^[a-z0-9]{1,10}$/);

export const EnvironmentName = z.enum(['staging', 'prod']);
export type EnvironmentName = z.infer<typeof EnvironmentName>;

const environmentSchema = z.object({
  /** CDK bootstrap qualifier for this environment (separate roles per env). */
  qualifier,
  /** Subdomain prefix, '' for prod, 'staging' for staging. */
  subdomain: z.string(),
  /** Cognito feature plan for this environment (D3). */
  cognitoPlan: z.enum(['ESSENTIALS', 'PLUS']),
  /**
   * Social sign-in providers turned on (design D2). Each needs its OAuth app
   * registered and its secret in Secrets Manager (`<project>/<env>/social/<provider>`)
   * before it's listed here: `blueprint social setup`.
   */
  socialProviders: z.array(z.enum(['Google', 'Apple', 'Facebook'])).default([]),
  /**
   * Text-message codes as a second factor. Needs Amazon SNS out of its SMS
   * sandbox (production access) for the account and region first.
   */
  smsMfa: z.boolean().default(false),
});

export const BmgConfigSchema = z.object({
  $schemaVersion: z.literal(1),
  project: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,20}$/)
    .default('bmg'),
  account: z.object({
    id: awsAccountId,
    /** All workloads and data (D1). */
    homeRegion: awsRegion.default('ap-southeast-2'),
    /** Only CloudFront certificates and CloudFront-scope WAF live here. */
    edgeRegion: z.literal('us-east-1').default('us-east-1'),
    /** Backup copies stay in Australia. */
    backupRegion: awsRegion.default('ap-southeast-4'),
    /**
     * Account-level security services that already existed before BMG (one per
     * region is allowed). Written by `blueprint account setup`; the guardrails stack
     * reuses these instead of creating its own, however it is deployed.
     */
    existingServices: z
      .object({
        guardDuty: z.boolean().default(false),
        securityHub: z.boolean().default(false),
        config: z.boolean().default(false),
        accessAnalyzer: z.boolean().default(false),
      })
      .default({ guardDuty: false, securityHub: false, config: false, accessAnalyzer: false }),
  }),
  toolingQualifier: qualifier.default('bmgtool'),
  environments: z.object({
    staging: environmentSchema,
    prod: environmentSchema,
  }),
  domain: z.object({
    root: z.string().min(3),
  }),
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    /** Set by `blueprint github connect`. */
    connectionArn: z.string().startsWith('arn:aws:codeconnections:').optional(),
    /**
     * Numeric GitHub user ids allowed to trigger CodeBuild runners. The repo is
     * public, so this is what stops strangers running code on our runners.
     */
    allowedActorIds: z.array(z.string().regex(/^\d+$/)).min(1),
    /** GitHub logins that approve production deploys. */
    productionReviewers: z.array(z.string().min(1)).min(1),
  }),
  alerts: z.object({
    emails: z.array(z.email()).min(1),
  }),
  budget: z.object({
    monthlyUsd: z.number().positive().default(400),
  }),
  audit: z.object({
    /**
     * GOVERNANCE while the platform is being set up; switch to COMPLIANCE
     * (irreversible) once stable — design section 9.2.
     */
    objectLockMode: z.enum(['GOVERNANCE', 'COMPLIANCE']).default('GOVERNANCE'),
    retentionDays: z.number().int().positive().default(2555),
  }),
  /**
   * App email goes out through Gmail SMTP as the sender below (design 7.4).
   * The Gmail app password lives in Secrets Manager (`blueprint email setup`), never here.
   */
  email: z.object({
    senderAddress: z.email(),
    senderName: z.string().min(1).default('Blueprint Music Group'),
    /** Domain whose SPF/DKIM/DMARC records are checked. */
    domain: z.string().min(3),
    smtpHost: z.string().min(1).default('smtp.gmail.com'),
    /** 587 = STARTTLS (465 = implicit TLS). Port 25 is never used. */
    smtpPort: z.union([z.literal(587), z.literal(465)]).default(587),
  }),
  ai: z.object({
    /** Australia-only geographic inference profile (D7). */
    assistantModelProfile: z.string().min(1),
    summaryModelProfile: z.string().min(1),
  }),
});

export type BmgConfig = z.infer<typeof BmgConfigSchema>;

export const CONFIG_FILE = 'bmg.config.json';

export function configPath(cwd = process.cwd()): string {
  return resolve(cwd, CONFIG_FILE);
}

export function parseConfig(raw: unknown): BmgConfig {
  const result = BmgConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${CONFIG_FILE}:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(path = configPath()): BmgConfig {
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Run \`blueprint init\` first.`);
  }
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveConfig(config: BmgConfig, path = configPath()): void {
  const validated = parseConfig(config);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
}

/** Resource-name helpers so the CLI and CDK always agree on names. */
export const names = {
  stack: (cfg: BmgConfig, suffix: string) => `${cfg.project}-${suffix}`,
  envStack: (cfg: BmgConfig, env: EnvironmentName, suffix: string) =>
    `${cfg.project}-${env}-${suffix}`,
  permissionBoundary: (cfg: BmgConfig) => `${cfg.project}-permission-boundary`,
  cdkRole: (
    qualifierValue: string,
    kind: 'deploy' | 'file-publishing' | 'image-publishing' | 'lookup' | 'cfn-exec',
    cfg: BmgConfig,
  ) => `cdk-${qualifierValue}-${kind}-role-${cfg.account.id}-${cfg.account.homeRegion}`,
  runnerProject: (cfg: BmgConfig, kind: 'ci' | 'deploy-staging' | 'deploy-prod') =>
    `${cfg.project}-${kind}`,
  runnerLogGroup: (cfg: BmgConfig, kind: 'ci' | 'deploy-staging' | 'deploy-prod') =>
    `/aws/codebuild/${cfg.project}-${kind}`,
  agentRepository: (cfg: BmgConfig) => `${cfg.project}-agent`,
  mailerRole: (cfg: BmgConfig, env: EnvironmentName) => `${cfg.project}-${env}-mailer`,
  /** Secrets Manager id of the Gmail SMTP credentials for an environment. */
  smtpSecret: (cfg: BmgConfig, env: EnvironmentName) => `${cfg.project}/${env}/gmail-smtp`,
  /** One social sign-in provider's OAuth app (JSON: clientId and clientSecret, or Apple's teamId, keyId, privateKey). */
  socialSecret: (cfg: BmgConfig, env: EnvironmentName, provider: string) =>
    `${cfg.project}/${env}/social/${provider.toLowerCase()}`,
  /** Secrets Manager id of the end-to-end test accounts (docs/e2e.md); read by the Staging E2E job. */
  e2eSecret: (cfg: BmgConfig, env: EnvironmentName) => `${cfg.project}/${env}/e2e-accounts`,
  /** Secrets Manager id prefix for the connector OAuth apps: `<prefix>/<provider>` (Phase 4). */
  connectorSecretPrefix: (cfg: BmgConfig, env: EnvironmentName) =>
    `${cfg.project}/${env}/connectors`,
  ssm: (cfg: BmgConfig, env: EnvironmentName, key: string) => `/${cfg.project}/${env}/${key}`,
  /** DynamoDB table names (design 8.1). */
  table: (cfg: BmgConfig, env: EnvironmentName, kind: TableKind) => `${cfg.project}-${env}-${kind}`,
  /** Public host name in an environment, e.g. app.blueprintmusic.group / app.staging.blueprintmusic.group. */
  host: (cfg: BmgConfig, env: EnvironmentName, sub: 'app' | 'api' | 'files' | 'join' | 'auth') => {
    const envPart = cfg.environments[env].subdomain;
    return [sub, envPart, cfg.domain.root].filter(Boolean).join('.');
  },
  /**
   * Cognito managed-login prefix domain (<prefix>.auth.<region>.amazoncognito.com).
   * Globally unique, so it includes the account id.
   */
  cognitoDomainPrefix: (cfg: BmgConfig, env: EnvironmentName) =>
    `${cfg.project}-${env}-${cfg.account.id}`,
  /** File buckets (design 9.2). S3 names are global, so the account id is appended. */
  bucket: (cfg: BmgConfig, env: EnvironmentName, kind: FileBucketKind) =>
    `${cfg.project}-${env}-${kind}-${cfg.account.id}`,
};

export const FILE_BUCKET_KINDS = ['quarantine', 'artist-data', 'org-data'] as const;
export type FileBucketKind = (typeof FILE_BUCKET_KINDS)[number];

export const TABLE_KINDS = ['main', 'consent', 'sessions', 'idempotency'] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

/** Cognito groups (design 6.1). Membership is set only by the API or the CLI. */
export const USER_GROUPS = ['bmg-admin', 'bmg-staff', 'artist'] as const;
export type UserGroup = (typeof USER_GROUPS)[number];

export const TAG_ENV = 'bmg:env';
export const TAG_ROLE = 'bmg:role';
