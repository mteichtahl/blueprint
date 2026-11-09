import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import {
  AgentCoreRuntime,
  AgentRuntimeArtifact,
  Runtime,
  RuntimeAuthorizerConfiguration,
} from 'aws-cdk-lib/aws-bedrockagentcore';
import { CfnGuardrail, CfnGuardrailVersion } from 'aws-cdk-lib/aws-bedrock';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Key, KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';
import { buildSync } from 'esbuild';
import type { EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { REPO_ROOT } from './function.ts';

export interface AiStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
}

/**
 * The assistant (design 10.1, 10.2):
 * - `bmg-<env>-agent`: Blueprint AI on AgentCore Runtime, deployed as code
 *   (Node 22, no container). Only IAM callers can invoke it: in practice the
 *   API's chat function, which has already checked the person and consent.
 * - A Bedrock guardrail (Standard tier through the Australia-only guardrail
 *   profile): prompt attacks, harmful content, definitive legal or financial
 *   advice, and personal details masked in replies.
 * - An HMAC key that signs the single-use "Do it" token for proposed actions.
 */
export class AiStack extends BmgStack {
  readonly runtime: Runtime;
  readonly actionKey: Key;

  constructor(scope: Construct, id: string, props: AiStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const p = `${cfg.project}-${env}`;
    const home = cfg.account.homeRegion;

    // ── Action token key (design 10.2) ──
    this.actionKey = new Key(this, 'ActionKey', {
      alias: `alias/${cfg.project}/${env}/ai-actions`,
      description: `BMG ${env}: signs the single-use token for actions the assistant proposes`,
      keySpec: KeySpec.HMAC_256,
      keyUsage: KeyUsage.GENERATE_VERIFY_MAC,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    acknowledge(
      this.actionKey,
      'HMAC keys do not support automatic rotation; tokens live 60 seconds, so the key can be replaced at any time.',
      'AwsSolutions-KMS5',
    );

    // ── Guardrail (design 10.1): Standard tier through the Sydney-only profile ──
    const guardrailProfile = `arn:aws:bedrock:${home}:${this.account}:guardrail-profile/au.guardrail.v1:0`;
    // The Australia guardrail profile can route each check to Sydney or
    // Melbourne, and ApplyGuardrail must be allowed on the profile in every
    // destination Region, not only the source (Bedrock user guide,
    // "Permissions for using cross-Region inference with Amazon Bedrock Guardrails").
    const AU_REGIONS = ['ap-southeast-2', 'ap-southeast-4'];
    const guardrailProfiles = AU_REGIONS.map(
      (r) => `arn:aws:bedrock:${r}:${this.account}:guardrail-profile/au.guardrail.v1:0`,
    );
    const guardrail = new CfnGuardrail(this, 'Guardrail', {
      name: `${p}-assistant`,
      description: `BMG ${env}: assistant guardrail`,
      blockedInputMessaging:
        "Sorry, I can't help with that. Try asking about your plan, to-dos, gigs or messages.",
      blockedOutputsMessaging:
        "Sorry, I can't answer that. Try rephrasing, or ask the Blueprint team directly.",
      crossRegionConfig: { guardrailProfileArn: guardrailProfile },
      contentPolicyConfig: {
        contentFiltersTierConfig: { tierName: 'STANDARD' },
        filtersConfig: [
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
          { type: 'HATE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'SEXUAL', inputStrength: 'MEDIUM', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
        ],
      },
      topicPolicyConfig: {
        topicsTierConfig: { tierName: 'STANDARD' },
        topicsConfig: [
          {
            name: 'Definitive legal advice',
            type: 'DENY',
            definition:
              'Telling the person what the law requires them to do, or how a contract or dispute will be decided, as if it were certain legal advice.',
            examples: ['Is my management contract legally binding?', 'Can I sue the venue?'],
          },
          {
            name: 'Definitive financial advice',
            type: 'DENY',
            definition:
              'Telling the person which investment, loan or tax position to take, as if it were certain financial advice.',
            examples: ['Should I put my royalties in shares?', 'How should I structure my tax?'],
          },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
          { type: 'AWS_SECRET_KEY', action: 'BLOCK' },
          { type: 'PASSWORD', action: 'BLOCK' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'ADDRESS', action: 'ANONYMIZE' },
        ],
      },
    });
    const guardrailVersion = new CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'Published by the deploy',
    });

    // ── The agent, bundled at synth (esbuild, like the Lambdas) ──
    // AgentCore's NODE_22 runtime only accepts a `.js` entry point, so the ESM
    // bundle is `server.js` beside a package.json that marks it as a module.
    const outDir = join(REPO_ROOT, 'infra', '.agent-build', env);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'package.json'),
      `${JSON.stringify({ name: 'bmg-agent', private: true, type: 'module' }, null, 2)}\n`,
    );
    buildSync({
      entryPoints: [join(REPO_ROOT, 'services/agent/src/server.ts')],
      outfile: join(outDir, 'server.js'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      banner: {
        js: "import { createRequire as __bmgCreateRequire } from 'module'; const require = __bmgCreateRequire(import.meta.url);",
      },
      logLevel: 'error',
    });

    this.runtime = new Runtime(this, 'Agent', {
      runtimeName: `${cfg.project}_${env}_agent`,
      description: `BMG ${env}: Blueprint AI assistant`,
      agentRuntimeArtifact: AgentRuntimeArtifact.fromCodeAsset({
        path: outDir,
        runtime: AgentCoreRuntime.NODE_22,
        entrypoint: ['server.js'],
      }),
      // Only IAM callers (the API's chat function); people never call it directly.
      authorizerConfiguration: RuntimeAuthorizerConfiguration.usingIAM(),
      environmentVariables: {
        NODE_ENV: 'production',
        MODEL_ID: cfg.ai.assistantModelProfile,
        GUARDRAIL_ID: guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: guardrailVersion.attrVersion,
      },
    });

    // The Australia-only profile routes to Sydney and Melbourne (D7).
    const profileArn = `arn:aws:bedrock:${home}:${this.account}:inference-profile/${cfg.ai.assistantModelProfile}`;
    const baseModel = cfg.ai.assistantModelProfile.replace(/^au\./, '');
    const modelArns = AU_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/${baseModel}`);
    this.runtime.addToRolePolicy(
      new PolicyStatement({
        sid: 'InvokeTheAssistantModel',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [profileArn, ...modelArns],
      }),
    );
    this.runtime.addToRolePolicy(
      new PolicyStatement({
        sid: 'ApplyTheGuardrail',
        actions: ['bedrock:ApplyGuardrail'],
        resources: [
          guardrail.attrGuardrailArn,
          `${guardrail.attrGuardrailArn}:*`,
          ...guardrailProfiles,
        ],
      }),
    );
    const part = ['aws', '<AWS::Partition>'];
    const logs = `${this.account}`;
    acknowledge(
      this.runtime,
      'Grants the AgentCore Runtime construct adds itself: its own log groups and streams, X-Ray and CloudWatch metrics (no resource scoping exists), its workload identity, and reading its code bundle from the CDK assets bucket. Model and guardrail access are pinned to single ARNs (the guardrail ARN suffix is its version).',
      'AwsSolutions-IAM5[Resource::*]',
      'AwsSolutions-IAM5[Action::s3:GetBucket*]',
      'AwsSolutions-IAM5[Action::s3:GetObject*]',
      'AwsSolutions-IAM5[Action::s3:List*]',
      'AwsSolutions-IAM5[Resource::<Guardrail.GuardrailArn>:*]',
      `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-${cfg.environments[env].qualifier}-assets-${logs}-${home}/*]`,
      // In CI the stack has a concrete account and region, so the partition renders literally.
      `AwsSolutions-IAM5[Resource::arn:aws:s3:::cdk-${cfg.environments[env].qualifier}-assets-${logs}-${home}/*]`,
      ...part.flatMap((pt) => [
        `AwsSolutions-IAM5[Resource::arn:${pt}:logs:${home}:${logs}:log-group:*]`,
        `AwsSolutions-IAM5[Resource::arn:${pt}:logs:${home}:${logs}:log-group:/aws/bedrock-agentcore/runtimes/*]`,
        `AwsSolutions-IAM5[Resource::arn:${pt}:logs:${home}:${logs}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*]`,
        `AwsSolutions-IAM5[Resource::arn:${pt}:bedrock-agentcore:${home}:${logs}:workload-identity-directory/default/workload-identity/*]`,
      ]),
    );

    new CfnOutput(this, 'AgentRuntimeArn', { value: this.runtime.agentRuntimeArn });
  }
}
