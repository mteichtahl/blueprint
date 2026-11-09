import {
  CloudWatchLogsClient,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  DeleteRepositoryCommand,
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  ECRClient,
} from '@aws-sdk/client-ecr';
import type { BmgConfig } from '@bmg/config';
import { toolingRetainedResources } from './plans.ts';
import type { PlanStep } from './runtime.ts';

async function repositoryExists(ecr: ECRClient, name: string): Promise<boolean> {
  try {
    await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [name] }));
    return true;
  } catch (err) {
    if ((err as Error).name === 'RepositoryNotFoundException') return false;
    throw err;
  }
}

async function existingLogGroups(logs: CloudWatchLogsClient, wanted: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const name of wanted) {
    const groups =
      (await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }))).logGroups ?? [];
    if (groups.some((g) => g.logGroupName === name)) found.push(name);
  }
  return found;
}

/**
 * Plan steps that remove tooling resources a failed first deploy left behind.
 * Call only when the tooling stack does not exist (or is about to be removed),
 * so these resources cannot belong to a live stack. The image repository is
 * removed only while it holds no images; otherwise setup stops and explains.
 */
export async function toolingOrphanCleanup(cfg: BmgConfig): Promise<PlanStep[]> {
  const region = cfg.account.homeRegion;
  const ecr = new ECRClient({ region });
  const logs = new CloudWatchLogsClient({ region });
  const { repository, logGroups } = toolingRetainedResources(cfg);
  const steps: PlanStep[] = [];

  if (await repositoryExists(ecr, repository)) {
    const images =
      (await ecr.send(new DescribeImagesCommand({ repositoryName: repository, maxResults: 1 })))
        .imageDetails ?? [];
    if (images.length > 0) {
      throw new Error(
        `ECR repository ${repository} exists outside any stack and holds images. ` +
          'Delete or rename it yourself, then run `blueprint pipeline deploy` again.',
      );
    }
    steps.push({
      description: `Remove empty ECR repository ${repository} left by a failed first deploy`,
      run: async () => {
        await ecr.send(new DeleteRepositoryCommand({ repositoryName: repository }));
      },
    });
  }

  const groups = await existingLogGroups(logs, logGroups);
  if (groups.length > 0) {
    steps.push({
      description: `Remove log groups left by a failed first deploy: ${groups.join(', ')}`,
      run: async () => {
        for (const logGroupName of groups) {
          await logs.send(new DeleteLogGroupCommand({ logGroupName }));
        }
      },
    });
  }
  return steps;
}
