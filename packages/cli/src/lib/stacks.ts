import {
  CloudFormationClient,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { fail, log, sleep } from './runtime.ts';

export interface StackRef {
  name: string;
  region: string;
}

async function stackStatus(
  client: CloudFormationClient,
  name: string,
): Promise<string | undefined> {
  try {
    return (await client.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]
      ?.StackStatus;
  } catch (err) {
    if (/does not exist/.test((err as Error).message)) return undefined;
    throw err;
  }
}

/** True for statuses where CloudFormation will not accept a new update yet. */
export function isBusy(status: string | undefined): boolean {
  return !!status && status.endsWith('_IN_PROGRESS');
}

/**
 * Wait until CloudFormation has finished whatever it is doing to a stack
 * (e.g. UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS after a failed update),
 * so a new deploy is not rejected.
 */
export async function waitUntilIdle(stacks: StackRef[], timeoutMs = 30 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const s of stacks) {
    const client = new CloudFormationClient({ region: s.region });
    let status = await stackStatus(client, s.name);
    if (isBusy(status)) log(`  … ${s.name} is ${status}; waiting for CloudFormation to finish`);
    while (isBusy(status)) {
      if (Date.now() > deadline) throw new Error(`${s.name} is still ${status} after waiting`);
      await sleep(15_000);
      status = await stackStatus(client, s.name);
    }
  }
}

/** Print the most recent FAILED events for each stack: the real reason a deploy failed. */
export async function printFailureReasons(stacks: StackRef[], limit = 8): Promise<void> {
  for (const s of stacks) {
    const client = new CloudFormationClient({ region: s.region });
    try {
      const events =
        (await client.send(new DescribeStackEventsCommand({ StackName: s.name }))).StackEvents ??
        [];
      const failed = events
        .filter((e) => e.ResourceStatus?.endsWith('_FAILED') && e.ResourceStatusReason)
        .filter(
          (e) =>
            !/Resource update cancelled|Resource creation cancelled/.test(
              e.ResourceStatusReason ?? '',
            ),
        )
        .slice(0, limit);
      if (failed.length === 0) continue;
      log(`\nWhy ${s.name} failed (most recent first):`);
      for (const e of failed) {
        fail(`${e.LogicalResourceId} (${e.ResourceType}): ${e.ResourceStatusReason}`);
      }
    } catch {
      // The stack may not exist; nothing to explain.
    }
  }
}

/** Run a deploy step with wait-before and explain-after. */
export async function deployWithDiagnostics(
  stacks: StackRef[],
  deploy: () => Promise<unknown>,
): Promise<void> {
  await waitUntilIdle(stacks);
  try {
    await deploy();
  } catch (err) {
    await printFailureReasons(stacks);
    throw err;
  }
}
