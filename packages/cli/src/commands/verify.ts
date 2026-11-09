import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { names, type BmgConfig } from '@bmg/config';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import { fail, heading, ok } from '../lib/runtime.ts';

interface GateReport {
  passed: boolean;
  results: Array<{ name: string; expected: string; actual: string; detail?: string }>;
}

async function gateFunction(cfg: BmgConfig, env: 'staging', param: string) {
  try {
    return (
      await new SSMClient({ region: cfg.account.homeRegion }).send(
        new GetParameterCommand({ Name: names.ssm(cfg, env, param) }),
      )
    ).Parameter?.Value;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return undefined;
  }
}

async function runGate(cfg: BmgConfig, title: string, fn: string): Promise<boolean> {
  heading(title);
  const res = await new LambdaClient({ region: cfg.account.homeRegion }).send(
    new InvokeCommand({ FunctionName: fn }),
  );
  const payload = Buffer.from(res.Payload ?? []).toString();
  if (res.FunctionError) throw new Error(`The gate function failed: ${payload}`);
  const report = JSON.parse(payload) as GateReport;
  for (const r of report.results) {
    const line = `${r.name}: expected ${r.expected}, got ${r.actual}${r.detail ? ` (${r.detail})` : ''}`;
    (r.actual === r.expected ? ok : fail)(line);
  }
  if (!report.passed) fail(`${title} FAILED`);
  else ok(`${title} passed (${report.results.length} checks)`);
  return report.passed;
}

/**
 * `blueprint verify isolation`: runs the staging gates on demand.
 * - Keys (Phase 2): real KMS calls prove one artist's session can't use
 *   another artist's key, and BMG roles can't decrypt items an artist marked
 *   private (design 9.1).
 * - Files (Phase 3): the same rules for stored files, through S3.
 * Read-only apart from the two permanent test artists' keys and test objects.
 */
export async function verifyIsolation(opts: { env: 'staging' }): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const keysGate = await gateFunction(cfg, opts.env, 'keys/isolation-gate-function');
  if (!keysGate)
    throw new Error(`No isolation gate in ${opts.env} yet. It is deployed with the keys stack.`);
  let passed = await runGate(cfg, `Artist isolation (${opts.env})`, keysGate);
  const filesGate = await gateFunction(cfg, opts.env, 'files/gate-function');
  if (filesGate) passed = (await runGate(cfg, `File isolation (${opts.env})`, filesGate)) && passed;
  if (!passed) process.exitCode = 1;
}
