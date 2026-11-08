import { randomBytes } from 'node:crypto';
import { EC2Client, EnableEbsEncryptionByDefaultCommand } from '@aws-sdk/client-ec2';
import {
  AddUserToGroupCommand,
  CreateLoginProfileCommand,
  CreateUserCommand,
  GetUserCommand,
  IAMClient,
  UpdateAccountPasswordPolicyCommand,
} from '@aws-sdk/client-iam';
import { PutPublicAccessBlockCommand, S3ControlClient } from '@aws-sdk/client-s3-control';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import { accountStacks, deployArgs } from '../lib/plans.ts';
import {
  cdk,
  executePlan,
  log,
  ok,
  warn,
  type GlobalOptions,
  type PlanStep,
} from '../lib/runtime.ts';
import { envBootstrapSteps } from './bootstrap.ts';
import { detectExistingServices } from './doctor.ts';

export interface AccountSetupOptions extends GlobalOptions {
  /** IAM user names to create in the bmg-admins group (e.g. marc,kyra). */
  users?: string;
}

/** `bmg account setup`: apply the guardrails in design section 4.2. */
export async function accountSetup(opts: AccountSetupOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const iam = new IAMClient({ region: cfg.account.homeRegion });
  const existing = await detectExistingServices(cfg);
  const skip = {
    guardDuty: existing.guardDuty,
    securityHub: existing.securityHub,
    config: existing.config,
  };
  for (const [svc, on] of Object.entries(skip)) {
    if (on)
      warn(`${svc} is already enabled in this account; the guardrails stack will not create it.`);
  }

  const users = (opts.users ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const steps: PlanStep[] = [
    {
      description: 'Block all S3 public access at the account level',
      run: async () => {
        await new S3ControlClient({ region: cfg.account.homeRegion }).send(
          new PutPublicAccessBlockCommand({
            AccountId: cfg.account.id,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          }),
        );
      },
    },
    {
      description:
        'Set the IAM password policy (14+ chars, all character types, no reuse of last 24)',
      run: async () => {
        await iam.send(
          new UpdateAccountPasswordPolicyCommand({
            MinimumPasswordLength: 14,
            RequireSymbols: true,
            RequireNumbers: true,
            RequireUppercaseCharacters: true,
            RequireLowercaseCharacters: true,
            AllowUsersToChangePassword: true,
            PasswordReusePrevention: 24,
            MaxPasswordAge: 365,
          }),
        );
      },
    },
    ...[...new Set([cfg.account.homeRegion, cfg.account.backupRegion, cfg.account.edgeRegion])].map(
      (region): PlanStep => ({
        description: `Turn on EBS encryption by default in ${region}`,
        run: async () => {
          await new EC2Client({ region }).send(new EnableEbsEncryptionByDefaultCommand({}));
        },
      }),
    ),
    {
      description: `Deploy ${accountStacks(cfg).join(' and ')} (boundary, CloudTrail, GuardDuty, Security Hub, Config, admin roles, root alarm, budget)`,
      run: async () => {
        await cdk(deployArgs(accountStacks(cfg), skip));
      },
    },
    ...envBootstrapSteps(cfg),
    ...users.map((user): PlanStep => ({
      description: `Create IAM user ${user} in ${cfg.project}-admins (console only, MFA required, temporary password)`,
      run: async () => {
        try {
          await iam.send(new GetUserCommand({ UserName: user }));
          ok(`${user} already exists`);
        } catch (err) {
          if (!isNotFound(err)) throw err;
          await iam.send(
            new CreateUserCommand({ UserName: user, Tags: [{ Key: 'bmg:role', Value: 'admin' }] }),
          );
          const temp = `${randomBytes(12).toString('base64url')}#Aa1`;
          await iam.send(
            new CreateLoginProfileCommand({
              UserName: user,
              Password: temp,
              PasswordResetRequired: true,
            }),
          );
          // Shown once on screen, never written to the log file.
          console.log(`    Temporary console password for ${user}: ${temp}`);
        }
        await iam.send(
          new AddUserToGroupCommand({ UserName: user, GroupName: `${cfg.project}-admins` }),
        );
      },
    })),
  ];

  await executePlan(`Account guardrails for ${cfg.account.id}`, steps, opts);
  log(
    '\nNext: each admin signs in, sets a new password, registers MFA (passkey or hardware key),\n' +
      `then uses the ${cfg.project}-admin / ${cfg.project}-readonly roles. Root: add hardware MFA and delete any root access keys.`,
  );
}
