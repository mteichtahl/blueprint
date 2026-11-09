import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import { configPath, parseConfig, saveConfig, type BmgConfig } from '@bmg/config';
import { callerIdentity } from '../lib/aws.ts';
import { log, ok, REPO_ROOT, run, warn, type GlobalOptions } from '../lib/runtime.ts';

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

async function githubUserId(login: string): Promise<string | undefined> {
  try {
    const r = await run('gh', ['api', `users/${login}`, '--jq', '.id'], { capture: true });
    return r.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `blueprint init`: write bmg.config.json (non-secret settings only — the repo is public). */
export async function init(opts: GlobalOptions): Promise<void> {
  const path = configPath(REPO_ROOT);
  const base: BmgConfig = parseConfig(
    JSON.parse(
      readFileSync(existsSync(path) ? path : resolve(REPO_ROOT, 'bmg.config.example.json'), 'utf8'),
    ),
  );
  if (existsSync(path) && !opts.yes) {
    const again = await confirm({ message: 'bmg.config.json exists. Update it?', default: true });
    if (!again) return;
  }

  let detectedAccount: string | undefined;
  try {
    detectedAccount = (await callerIdentity(base.account.homeRegion)).Account;
  } catch {
    warn('No AWS credentials found; enter the account id by hand.');
  }

  const accountId = await input({
    message: 'AWS account id',
    default: detectedAccount ?? base.account.id,
    validate: (v) => /^\d{12}$/.test(v) || '12 digits',
  });
  const homeRegion = await input({
    message: 'Home region (all data)',
    default: base.account.homeRegion,
  });
  const domain = await input({ message: 'App domain', default: base.domain.root });
  const owner = await input({ message: 'GitHub owner', default: base.github.owner });
  const repo = await input({ message: 'GitHub repo', default: base.github.repo });
  const actorLogins = list(
    await input({
      message: 'GitHub logins allowed to trigger CI runners (comma separated)',
      default: owner,
    }),
  );
  const actorIds: string[] = [];
  for (const login of actorLogins) {
    const id = await githubUserId(login);
    if (id) {
      ok(`${login} → GitHub user id ${id}`);
      actorIds.push(id);
    } else {
      actorIds.push(
        await input({
          message: `Numeric GitHub user id for ${login} (gh not available)`,
          validate: (v) => /^\d+$/.test(v) || 'digits only',
        }),
      );
    }
  }
  // Dependabot (D10) opens PRs as dependabot[bot]; its CI only runs if it may start a runner.
  const DEPENDABOT_ID = '49699333';
  if (
    !actorIds.includes(DEPENDABOT_ID) &&
    (await confirm({
      message: 'Let Dependabot pull requests run CI on the CodeBuild runners?',
      default: true,
    }))
  ) {
    actorIds.push(DEPENDABOT_ID);
  }
  const reviewers = list(
    await input({
      message: 'GitHub logins who approve production deploys',
      default: base.github.productionReviewers.join(','),
    }),
  );
  const emails = list(
    await input({
      message: 'Alert email addresses (comma separated)',
      default: base.alerts.emails.join(','),
    }),
  );
  const budget = Number(
    await input({ message: 'Monthly AWS budget (USD)', default: String(base.budget.monthlyUsd) }),
  );
  const sender = await input({
    message: 'Gmail address that sends app email (Gmail SMTP)',
    default: base.email.senderAddress,
  });

  const next: BmgConfig = parseConfig({
    ...base,
    account: { ...base.account, id: accountId, homeRegion },
    domain: { root: domain },
    github: {
      ...base.github,
      owner,
      repo,
      allowedActorIds: actorIds,
      productionReviewers: reviewers,
      // A placeholder ARN from the example file must never be carried over.
      ...(base.github.connectionArn?.includes('00000000-0000') ? { connectionArn: undefined } : {}),
    },
    alerts: { emails },
    budget: { monthlyUsd: budget },
    email: {
      ...base.email,
      senderAddress: sender,
      domain: sender.split('@')[1] ?? base.email.domain,
    },
  });
  saveConfig(next, path);
  ok(`Wrote ${path}`);
  log('Commit bmg.config.json — it holds no secrets. Next: `blueprint doctor`.');
}
