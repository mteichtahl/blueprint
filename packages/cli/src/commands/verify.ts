import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { names } from '@bmg/config';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import { fail, heading, ok } from '../lib/runtime.ts';

interface GateReport {
  passed: boolean;
  results: Array<{ name: string; expected: string; actual: string; detail?: string }>;
}

/**
 * `bmg verify isolation`: runs the Phase 2 gate on demand. Real KMS calls prove
 * one artist's session can't use another artist's key, and BMG roles can't
 * decrypt items an artist marked private (design 9.1). Read-only apart from
 * the two permanent test keys it uses in staging.
 */
export async function verifyIsolation(opts: { env: 'staging' }): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const region = cfg.account.homeRegion;
  let fn: string | undefined;
  try {
    fn = (
      await new SSMClient({ region }).send(
        new GetParameterCommand({ Name: names.ssm(cfg, opts.env, 'keys/isolation-gate-function') }),
      )
    ).Parameter?.Value;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (!fn)
    throw new Error(`No isolation gate in ${opts.env} yet. It is deployed with the keys stack.`);

  heading(`Artist isolation (${opts.env})`);
  const res = await new LambdaClient({ region }).send(new InvokeCommand({ FunctionName: fn }));
  const payload = Buffer.from(res.Payload ?? []).toString();
  if (res.FunctionError) throw new Error(`The gate function failed: ${payload}`);
  const report = JSON.parse(payload) as GateReport;
  for (const r of report.results) {
    const line = `${r.name}: expected ${r.expected}, got ${r.actual}${r.detail ? ` (${r.detail})` : ''}`;
    (r.actual === r.expected ? ok : fail)(line);
  }
  if (!report.passed) {
    process.exitCode = 1;
    fail('Isolation gate FAILED');
  } else {
    ok(`Isolation gate passed (${report.results.length} checks)`);
  }
}
