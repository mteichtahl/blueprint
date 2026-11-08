import { promises as dns } from 'node:dns';
import type { BmgConfig } from '@bmg/config';
import { readConfig } from '../lib/aws.ts';
import {
  evaluateMailDns,
  GMAIL_SEND_SCOPE,
  googleSetupCommands,
  serviceAccountEmail,
} from '../lib/plans.ts';
import {
  commandExists,
  executePlan,
  fail,
  heading,
  log,
  ok,
  run,
  warn,
  type GlobalOptions,
  type PlanStep,
} from '../lib/runtime.ts';

async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function gcloud(args: string[], capture = false) {
  return run('gcloud', args, { capture, allowFailure: capture });
}

async function ensureProject(cfg: BmgConfig): Promise<string> {
  const p = cfg.google.gcpProjectId;
  let r = await gcloud(['projects', 'describe', p, '--format', 'value(projectNumber)'], true);
  if (r.code !== 0) {
    await run('gcloud', ['projects', 'create', p, '--name', 'BMG App Mailer']);
    r = await gcloud(['projects', 'describe', p, '--format', 'value(projectNumber)'], true);
  }
  const number = r.stdout.trim();
  if (!number) throw new Error(`Could not read the project number for ${p}`);
  return number;
}

export async function checkMailDns(domain: string): Promise<void> {
  heading(`Email DNS for ${domain}`);
  const found = evaluateMailDns(
    await txt(domain),
    await txt(`google._domainkey.${domain}`),
    await txt(`_dmarc.${domain}`),
  );
  (found.spf ? ok : fail)('SPF includes _spf.google.com');
  (found.dkim ? ok : fail)(
    'DKIM record at google._domainkey (Admin console → Apps → Gmail → Authenticate email)',
  );
  (found.dmarc ? ok : fail)('DMARC record at _dmarc (start with p=quarantine)');
}

/**
 * `bmg google setup`: keyless Gmail sending from BMG's Google Workspace
 * (design 7.4). AWS signs in with Workload Identity Federation; the service
 * account has no JSON key and may only send mail as the configured sender.
 */
export async function googleSetup(opts: GlobalOptions): Promise<void> {
  const cfg = readConfig();
  if (!(await commandExists('gcloud'))) {
    throw new Error('gcloud is not installed. See https://cloud.google.com/sdk/docs/install');
  }

  let projectNumber = 'PROJECT_NUMBER';
  const steps: PlanStep[] = [
    {
      description: `Create or reuse Google Cloud project ${cfg.google.gcpProjectId}`,
      run: async () => {
        projectNumber = await ensureProject(cfg);
        ok(`project number ${projectNumber}`);
      },
    },
  ];
  // Commands are rebuilt after the project number is known; the plan shows them with a placeholder.
  for (const [i, cmd] of googleSetupCommands(cfg, projectNumber).entries()) {
    steps.push({
      description: cmd.description,
      run: async () => {
        const real = googleSetupCommands(cfg, projectNumber)[i]!;
        const r = await run('gcloud', real.args, { capture: true, allowFailure: true });
        if (r.code !== 0 && !/already exists|ALREADY_EXISTS/i.test(r.stderr)) {
          throw new Error(`gcloud ${real.args.slice(0, 4).join(' ')} failed:\n${r.stderr}`);
        }
      },
    });
  }
  await executePlan('Google Workspace email (keyless, send-only)', steps, opts);
  if (opts.dryRun) return;

  const sa = serviceAccountEmail(cfg);
  const uid = (
    await run(
      'gcloud',
      [
        'iam',
        'service-accounts',
        'describe',
        sa,
        '--project',
        cfg.google.gcpProjectId,
        '--format',
        'value(uniqueId)',
      ],
      {
        capture: true,
      },
    )
  ).stdout.trim();

  heading('One manual step for the Workspace super admin (Kyra)');
  log(
    '  admin.google.com → Security → Access and data control → API controls →\n' +
      '  Domain-wide delegation → Add new:\n' +
      `    Client ID:    ${uid}\n` +
      `    OAuth scopes: ${GMAIL_SEND_SCOPE}\n` +
      `  The app will only send as ${cfg.google.senderAddress}. It can never read mail.`,
  );
  await checkMailDns(cfg.google.workspaceDomain);
  warn('A test email is sent by `bmg google test` once the mailer Lambda exists (Phase 3).');
}
