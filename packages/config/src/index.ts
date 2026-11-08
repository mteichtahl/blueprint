import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * bmg.config.json holds NON-SECRET settings only. The repo is public, so
 * anything secret (API keys, client secrets, signing material) lives in
 * AWS Secrets Manager and is set with `bmg secrets set`.
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
    /** Set by `bmg github connect`. */
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
  google: z.object({
    workspaceDomain: z.string().min(3),
    senderAddress: z.email(),
    gcpProjectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    serviceAccountName: z.string().default('bmg-mailer'),
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
    throw new Error(`${path} not found. Run \`npm run bmg -- init\` first.`);
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
  mailerRole: (cfg: BmgConfig, env: EnvironmentName) => `${cfg.project}-${env}-mailer`,
  ssm: (cfg: BmgConfig, env: EnvironmentName, key: string) => `/${cfg.project}/${env}/${key}`,
};

export const TAG_ENV = 'bmg:env';
export const TAG_ROLE = 'bmg:role';
