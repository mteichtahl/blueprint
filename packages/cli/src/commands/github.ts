import {
  CodeConnectionsClient,
  CreateConnectionCommand,
  GetConnectionCommand,
  ListConnectionsCommand,
} from '@aws-sdk/client-codeconnections';
import { saveConfig, configPath } from '@bmg/config';
import { assertAccount, readConfig } from '../lib/aws.ts';
import { githubProtectionRequests } from '../lib/plans.ts';
import {
  executePlan,
  log,
  ok,
  REPO_ROOT,
  run,
  sleep,
  warn,
  type GlobalOptions,
  type PlanStep,
} from '../lib/runtime.ts';

const CONNECTION_NAME = 'bmg-github';

/** `bmg github connect`: CodeConnections link so CodeBuild can host the GitHub runners. */
export async function githubConnect(opts: GlobalOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const client = new CodeConnectionsClient({ region: cfg.account.homeRegion });

  let arn = cfg.github.connectionArn;
  if (!arn) {
    const existing = await client.send(
      new ListConnectionsCommand({ ProviderTypeFilter: 'GitHub' }),
    );
    arn = existing.Connections?.find((c) => c.ConnectionName === CONNECTION_NAME)?.ConnectionArn;
  }

  if (!arn) {
    await executePlan(
      'GitHub connection',
      [
        {
          description: `Create AWS CodeConnections connection "${CONNECTION_NAME}" to GitHub`,
          run: async () => {
            const r = await client.send(
              new CreateConnectionCommand({
                ConnectionName: CONNECTION_NAME,
                ProviderType: 'GitHub',
                Tags: [{ Key: 'bmg:env', Value: 'tooling' }],
              }),
            );
            arn = r.ConnectionArn;
          },
        },
      ],
      opts,
    );
    if (!arn) return;
  }

  let status = (await client.send(new GetConnectionCommand({ ConnectionArn: arn }))).Connection
    ?.ConnectionStatus;
  if (status !== 'AVAILABLE') {
    log(
      `\nOne manual step: approve the connection in the AWS console.\n` +
        `  https://${cfg.account.homeRegion}.console.aws.amazon.com/codesuite/settings/connections\n` +
        `  Open "${CONNECTION_NAME}" → Update pending connection → install the AWS Connector for GitHub\n` +
        `  on ${cfg.github.owner}, limited to the "${cfg.github.repo}" repository only.\n` +
        'Waiting for the connection to become AVAILABLE (up to 15 minutes)...',
    );
    const deadline = Date.now() + 15 * 60_000;
    while (status !== 'AVAILABLE' && Date.now() < deadline) {
      await sleep(10_000);
      status = (await client.send(new GetConnectionCommand({ ConnectionArn: arn }))).Connection
        ?.ConnectionStatus;
    }
  }
  if (status !== 'AVAILABLE') {
    warn(`Connection is ${status}. Re-run \`bmg github connect\` after approving it.`);
    process.exitCode = 1;
  } else {
    ok(`Connection AVAILABLE: ${arn}`);
  }
  saveConfig({ ...cfg, github: { ...cfg.github, connectionArn: arn } }, configPath(REPO_ROOT));
  ok('Saved github.connectionArn to bmg.config.json (commit it; it is not a secret).');
}

async function ghUserId(login: string): Promise<number> {
  const r = await run('gh', ['api', `users/${login}`, '--jq', '.id'], { capture: true });
  return Number(r.stdout.trim());
}

/** `bmg github protect`: repo settings for a public repo on self-hosted runners (16.2-16.4). */
export async function githubProtect(opts: GlobalOptions): Promise<void> {
  const cfg = readConfig();
  const reviewerIds = await Promise.all(cfg.github.productionReviewers.map(ghUserId));
  const requests = githubProtectionRequests(cfg, reviewerIds);
  const steps: PlanStep[] = requests.map((req) => ({
    description: req.description,
    run: async () => {
      const args = ['api', '-X', req.method, req.path, '-H', 'Accept: application/vnd.github+json'];
      if (req.body !== undefined) args.push('--input', '-');
      await run('gh', args, {
        capture: true,
        ...(req.body !== undefined ? { input: JSON.stringify(req.body) } : {}),
      });
    },
  }));
  log(
    'Note: the repo becomes PUBLIC. Fork pull requests will never run on the CodeBuild runners\n' +
      'without approval, and the runners only start for the GitHub user ids in bmg.config.json.',
  );
  await executePlan(`GitHub protection for ${cfg.github.owner}/${cfg.github.repo}`, steps, opts);
}
