import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
} from '@aws-sdk/client-codebuild';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { names } from '@bmg/config';
import { isNotFound, readConfig } from '../lib/aws.ts';
import { ENVIRONMENTS, ENV_STACK_SUFFIXES, accountStacks, partitionAlarms } from '../lib/plans.ts';
import { fail, heading, log, ok, warn } from '../lib/runtime.ts';

/** `bmg status`: read-only overview of stacks, runners, alarms and deployed versions. */
export async function status(): Promise<void> {
  const cfg = readConfig();
  const region = cfg.account.homeRegion;
  const cfn = new CloudFormationClient({ region });
  const cfnEdge = new CloudFormationClient({ region: cfg.account.edgeRegion });

  heading('Stacks');
  const stacks: Array<[string, CloudFormationClient]> = [
    [accountStacks(cfg)[0]!, cfn],
    [accountStacks(cfg)[1]!, cfnEdge],
    [names.stack(cfg, 'tooling'), cfn],
    ...ENVIRONMENTS.flatMap((env) =>
      ENV_STACK_SUFFIXES.map((suffix): [string, CloudFormationClient] => [
        names.envStack(cfg, env, suffix),
        cfn,
      ]),
    ),
  ];
  for (const [name, client] of stacks) {
    try {
      const s = (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
      const st = s?.StackStatus ?? 'UNKNOWN';
      (/COMPLETE$/.test(st) && !/ROLLBACK/.test(st) ? ok : fail)(`${name}: ${st}`);
    } catch (err) {
      if (/does not exist/.test((err as Error).message)) warn(`${name}: not deployed`);
      else throw err;
    }
  }

  heading('CI/CD runners (last build)');
  const cb = new CodeBuildClient({ region });
  for (const kind of ['ci', 'deploy-staging', 'deploy-prod'] as const) {
    const project = names.runnerProject(cfg, kind);
    try {
      const ids = (
        await cb.send(
          new ListBuildsForProjectCommand({ projectName: project, sortOrder: 'DESCENDING' }),
        )
      ).ids;
      if (!ids?.length) {
        warn(`${project}: no builds yet`);
        continue;
      }
      const b = (await cb.send(new BatchGetBuildsCommand({ ids: [ids[0]!] }))).builds?.[0];
      (b?.buildStatus === 'SUCCEEDED' || b?.buildStatus === 'IN_PROGRESS' ? ok : fail)(
        `${project}: ${b?.buildStatus} at ${b?.startTime?.toISOString()}`,
      );
    } catch (err) {
      if (isNotFound(err)) warn(`${project}: not deployed`);
      else throw err;
    }
  }

  heading('Deployed versions');
  const ssm = new SSMClient({ region });
  for (const env of ENVIRONMENTS) {
    try {
      const v = (
        await ssm.send(new GetParameterCommand({ Name: names.ssm(cfg, env, 'foundation/version') }))
      ).Parameter?.Value;
      ok(`${env}: ${v}`);
    } catch (err) {
      if (isNotFound(err)) warn(`${env}: not deployed`);
      else throw err;
    }
  }

  heading('Alarms');
  // Only BMG's own alarms (named `<project>-…`) count; other workloads in the
  // account (e.g. auto-scaling "AlarmLow" alarms on unrelated tables) are noted, not failed.
  for (const r of [cfg.account.homeRegion, cfg.account.edgeRegion]) {
    const firing =
      (
        await new CloudWatchClient({ region: r }).send(
          new DescribeAlarmsCommand({ StateValue: 'ALARM' }),
        )
      ).MetricAlarms ?? [];
    const { ours, others } = partitionAlarms(
      firing.map((a) => ({ name: a.AlarmName ?? '', reason: a.StateReason ?? '' })),
      cfg.project,
    );
    if (ours.length === 0) ok(`${r}: no BMG alarms firing`);
    for (const a of ours) fail(`${r}: ${a.name}: ${a.reason}`);
    if (others.length > 0) {
      log(`    (${others.length} alarm(s) from other workloads in ${r} ignored)`);
    }
  }
}
