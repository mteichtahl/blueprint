import { resolve } from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { acknowledge } from './common.ts';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');

export interface BmgFunctionProps {
  /** Path of the handler file, relative to the repo root (e.g. services/identity/src/triggers/x.ts). */
  readonly entry: string;
  readonly description: string;
  readonly environment?: Record<string, string>;
  readonly timeout?: Duration;
  readonly memorySize?: number;
  /** Production keeps logs longer. */
  readonly prod: boolean;
}

/**
 * Standard BMG Lambda: Node.js 24 on Graviton, bundled with esbuild as ESM,
 * X-Ray tracing on, and its own log group with a fixed retention. Personal
 * data is never logged (handlers use structured logs with ids only).
 *
 * Each function gets its own role with only the log and trace permissions it
 * needs (no AWS managed policies); callers add data permissions explicitly.
 */
export class BmgFunction extends NodejsFunction {
  constructor(scope: Construct, id: string, props: BmgFunctionProps) {
    const logGroup = new LogGroup(scope, `${id}Logs`, {
      retention: props.prod ? RetentionDays.ONE_YEAR : RetentionDays.ONE_MONTH,
      removalPolicy: props.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const role = new Role(scope, `${id}Role`, {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: props.description,
    });
    role.addToPolicy(
      new PolicyStatement({
        sid: 'WriteOwnLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroup.logGroupArn}:*`],
      }),
    );
    super(scope, id, {
      role,
      entry: resolve(REPO_ROOT, props.entry),
      handler: 'handler',
      description: props.description,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(10),
      tracing: Tracing.ACTIVE,
      logGroup,
      projectRoot: REPO_ROOT,
      depsLockFilePath: resolve(REPO_ROOT, 'package-lock.json'),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ...props.environment,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node24',
        sourceMap: true,
        minify: true,
        // The Lambda runtime provides the AWS SDK v3.
        externalModules: ['@aws-sdk/*'],
        // ESM bundles need a `require` shim for any CommonJS dependency.
        banner:
          "import { createRequire as __bmgCreateRequire } from 'module'; const require = __bmgCreateRequire(import.meta.url);",
      },
    });
    acknowledge(
      role,
      "Log streams are created at run time inside this function's own log group; X-Ray PutTraceSegments has no resource-level permissions.",
      'AwsSolutions-IAM5[Resource::<' +
        (this.stack.getLogicalId(logGroup.node.defaultChild as never) as string) +
        '.Arn>:*]',
      'AwsSolutions-IAM5[Resource::*]',
    );
  }
}
