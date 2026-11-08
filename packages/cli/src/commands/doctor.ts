import { AccessAnalyzerClient, ListAnalyzersCommand } from '@aws-sdk/client-accessanalyzer';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  ConfigServiceClient,
  DescribeConfigurationRecordersCommand,
} from '@aws-sdk/client-config-service';
import { GuardDutyClient, ListDetectorsCommand } from '@aws-sdk/client-guardduty';
import { DescribeHubCommand, SecurityHubClient } from '@aws-sdk/client-securityhub';
import { ListServiceQuotasCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { ListVectorBucketsCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import type { BmgConfig } from '@bmg/config';
import { callerIdentity, isNotFound, readConfig } from '../lib/aws.ts';
import { nodeVersionOk } from '../lib/plans.ts';
import { commandExists, fail, heading, log, ok, run, warn } from '../lib/runtime.ts';

export interface Check {
  name: string;
  required: boolean;
  run: (cfg: BmgConfig) => Promise<{ ok: boolean; detail: string }>;
}

export interface ExistingServices {
  guardDuty: boolean;
  securityHub: boolean;
  config: boolean;
  accessAnalyzer: boolean;
}

/** Detect security services already on in the account, so the guardrails stack can skip them. */
export async function detectExistingServices(cfg: BmgConfig): Promise<ExistingServices> {
  const region = cfg.account.homeRegion;
  const gd = await new GuardDutyClient({ region }).send(new ListDetectorsCommand({}));
  let securityHub = false;
  try {
    await new SecurityHubClient({ region }).send(new DescribeHubCommand({}));
    securityHub = true;
  } catch (err) {
    if (!/InvalidAccess|NotFound/.test((err as Error).name)) throw err;
  }
  const rec = await new ConfigServiceClient({ region }).send(
    new DescribeConfigurationRecordersCommand({}),
  );
  const analyzers = await new AccessAnalyzerClient({ region }).send(
    new ListAnalyzersCommand({ type: 'ACCOUNT' }),
  );
  return {
    accessAnalyzer: (analyzers.analyzers ?? []).some((a) => a.status === 'ACTIVE'),
    guardDuty: (gd.DetectorIds?.length ?? 0) > 0,
    securityHub,
    config: (rec.ConfigurationRecorders?.length ?? 0) > 0,
  };
}

const checks: Check[] = [
  {
    name: 'Node.js >= 22.12',
    required: true,
    run: async () => ({ ok: nodeVersionOk(process.version), detail: process.version }),
  },
  {
    name: 'AWS credentials for the configured account',
    required: true,
    run: async (cfg) => {
      const id = await callerIdentity(cfg.account.homeRegion);
      return { ok: id.Account === cfg.account.id, detail: `${id.Arn} (account ${id.Account})` };
    },
  },
  {
    name: 'AWS CDK CLI (infra workspace)',
    required: true,
    run: async () => {
      const r = await run('npx', ['--no-install', 'cdk', '--version'], {
        capture: true,
        allowFailure: true,
      });
      return { ok: r.code === 0, detail: r.stdout.trim() || 'run `npm install` first' };
    },
  },
  {
    name: 'GitHub CLI (gh) installed and signed in',
    required: true,
    run: async () => {
      if (!(await commandExists('gh')))
        return { ok: false, detail: 'install from https://cli.github.com' };
      const r = await run('gh', ['auth', 'status'], { capture: true, allowFailure: true });
      return { ok: r.code === 0, detail: r.code === 0 ? 'signed in' : 'run `gh auth login`' };
    },
  },
  {
    name: 'Bedrock: Australia-only inference profiles for the configured models',
    required: true,
    run: async (cfg) => {
      const client = new BedrockClient({ region: cfg.account.homeRegion });
      const ids = new Set<string>();
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListInferenceProfilesCommand({ nextToken, typeEquals: 'SYSTEM_DEFINED' }),
        );
        page.inferenceProfileSummaries?.forEach(
          (p) => p.inferenceProfileId && ids.add(p.inferenceProfileId),
        );
        nextToken = page.nextToken;
      } while (nextToken);
      const wanted = [cfg.ai.assistantModelProfile, cfg.ai.summaryModelProfile];
      const missing = wanted.filter((w) => !ids.has(w));
      return {
        ok: missing.length === 0,
        detail: missing.length
          ? `not found: ${missing.join(', ')} (check model access / newer ids)`
          : wanted.join(', '),
      };
    },
  },
  {
    name: 'Bedrock AgentCore available in the home region',
    required: true,
    run: async (cfg) => {
      await new BedrockAgentCoreControlClient({ region: cfg.account.homeRegion }).send(
        new ListAgentRuntimesCommand({ maxResults: 1 }),
      );
      return { ok: true, detail: cfg.account.homeRegion };
    },
  },
  {
    name: 'Amazon S3 Vectors available in the home region',
    required: true,
    run: async (cfg) => {
      await new S3VectorsClient({ region: cfg.account.homeRegion }).send(
        new ListVectorBucketsCommand({ maxResults: 1 }),
      );
      return { ok: true, detail: cfg.account.homeRegion };
    },
  },
  {
    name: 'Bedrock knowledge base quota (one per opted-in artist + BMG)',
    required: false,
    run: async (cfg) => {
      const client = new ServiceQuotasClient({ region: cfg.account.homeRegion });
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListServiceQuotasCommand({ ServiceCode: 'bedrock', NextToken: nextToken }),
        );
        const kb = page.Quotas?.find((q) =>
          /knowledge bases? per account/i.test(q.QuotaName ?? ''),
        );
        if (kb) {
          const value = kb.Value ?? 0;
          return {
            ok: value >= 60,
            detail: `${kb.QuotaName}: ${value}${value < 60 ? ' — request an increase before Phase 5' : ''}`,
          };
        }
        nextToken = page.NextToken;
      } while (nextToken);
      return { ok: false, detail: 'quota not found; check Service Quotas manually' };
    },
  },
  {
    name: 'Security services already enabled (guardrails will skip these)',
    required: false,
    run: async (cfg) => {
      const e = await detectExistingServices(cfg);
      const on = Object.entries(e)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return { ok: true, detail: on.length ? `already on: ${on.join(', ')}` : 'none yet' };
    },
  },
];

/** `bmg doctor`: read-only prerequisite checks. */
export async function doctor(): Promise<void> {
  const cfg = readConfig();
  heading(`Checking prerequisites for account ${cfg.account.id} in ${cfg.account.homeRegion}`);
  let failedRequired = 0;
  for (const check of checks) {
    try {
      const r = await check.run(cfg);
      if (r.ok) ok(`${check.name}: ${r.detail}`);
      else if (check.required) {
        failedRequired++;
        fail(`${check.name}: ${r.detail}`);
      } else warn(`${check.name}: ${r.detail}`);
    } catch (err) {
      const msg = isNotFound(err) ? 'not found' : (err as Error).message;
      if (check.required) {
        failedRequired++;
        fail(`${check.name}: ${msg}`);
      } else warn(`${check.name}: ${msg}`);
    }
  }
  if (failedRequired > 0) {
    log(`\n${failedRequired} required check(s) failed.`);
    process.exitCode = 1;
  } else {
    log('\nAll required checks passed.');
  }
}
