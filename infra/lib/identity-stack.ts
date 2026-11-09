import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  AccountRecovery,
  CfnUserPool,
  CfnUserPoolGroup,
  FeaturePlan,
  LambdaVersion,
  ManagedLoginVersion,
  Mfa,
  PasskeyUserVerification,
  StandardThreatProtectionMode,
  StringAttribute,
  UserPool,
  UserPoolDomain,
  UserPoolOperation,
} from 'aws-cdk-lib/aws-cognito';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { names, USER_GROUPS, type EnvironmentName } from '@bmg/config';
import { acknowledge, BmgStack, type BmgStackProps } from './common.ts';
import { BmgFunction } from './function.ts';

export interface IdentityStackProps extends Omit<BmgStackProps, 'envTag' | 'qualifier'> {
  readonly envName: EnvironmentName;
  readonly platformKey: IKey;
  readonly mainTable: ITable;
}

/** Group precedence: lower wins in Cognito's `cognito:preferred_role`. */
const PRECEDENCE: Record<(typeof USER_GROUPS)[number], number> = {
  'bmg-admin': 0,
  'bmg-staff': 10,
  artist: 20,
};

/**
 * Cognito for one environment (design 6.1):
 * - invite-only (no self sign-up); the pre sign-up trigger checks invites for social sign-in;
 * - sign in with a passkey or email + password, MFA required (authenticator app,
 *   or a passkey with user verification, which counts as two factors);
 * - the web client lives in the web stack, whose callback is the CloudFront address;
 * - pre token generation V2 adds `role`, `artistId` and `mfa_level`;
 * - the custom message trigger sends every Cognito email in the BMG layout.
 */
export class IdentityStack extends BmgStack {
  readonly userPool: UserPool;
  readonly domain: UserPoolDomain;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    const env = props.envName;
    super(scope, id, {
      ...props,
      qualifier: props.config.environments[env].qualifier,
      envTag: env,
    });
    const cfg = props.config;
    const prod = env === 'prod';
    const plan = cfg.environments[env].cognitoPlan;
    const domainPrefix = names.cognitoDomainPrefix(cfg, env);
    const loginHost = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;

    const fnEnv = { MAIN_TABLE: props.mainTable.tableName };
    const preSignUp = new BmgFunction(this, 'PreSignUp', {
      entry: 'services/identity/src/triggers/pre-sign-up.ts',
      description: 'Cognito pre sign-up: invite-only',
      environment: fnEnv,
      prod,
    });
    const postConfirmation = new BmgFunction(this, 'PostConfirmation', {
      entry: 'services/identity/src/triggers/post-confirmation.ts',
      description: 'Cognito post confirmation: create the profile record',
      environment: fnEnv,
      prod,
    });
    const preToken = new BmgFunction(this, 'PreTokenGeneration', {
      entry: 'services/identity/src/triggers/pre-token-generation.ts',
      description: 'Cognito pre token generation V2: role, artistId and mfa_level claims',
      prod,
    });
    // Brands every Cognito email (design: all email carries the BMG look). The
    // app origin is read from SSM at run time: the web stack is created later.
    const webUrlParam = names.ssm(cfg, env, 'web/url');
    const customMessage = new BmgFunction(this, 'CustomMessage', {
      entry: 'services/identity/src/triggers/custom-message.ts',
      description: 'Cognito custom message: BMG-branded emails',
      environment: {
        APP_URL_PARAM: webUrlParam,
        APP_ORIGIN: `https://${names.host(cfg, env, 'app')}`,
      },
      prod,
    });
    customMessage.addToRolePolicy(
      new PolicyStatement({
        sid: 'ReadAppUrl',
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${webUrlParam}`],
      }),
    );
    // Table-level ARNs only (no index/* wildcard): these triggers never query indexes.
    preSignUp.addToRolePolicy(
      new PolicyStatement({
        sid: 'ReadInvites',
        actions: ['dynamodb:GetItem'],
        resources: [props.mainTable.tableArn],
      }),
    );
    postConfirmation.addToRolePolicy(
      new PolicyStatement({
        sid: 'CreateProfile',
        // UpdateItem merges the artist contact record (ARTIST#id / CONTACT).
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [props.mainTable.tableArn],
      }),
    );
    props.platformKey.grant(preSignUp, 'kms:Decrypt');
    props.platformKey.grant(postConfirmation, 'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey');

    this.userPool = new UserPool(this, 'Users', {
      userPoolName: `${cfg.project}-${env}`,
      featurePlan: plan === 'PLUS' ? FeaturePlan.PLUS : FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      keepOriginal: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // Set once by the invite flow; users can never change it (not writable by the client either).
      customAttributes: { artistId: new StringAttribute({ mutable: false, maxLen: 40 }) },
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false, email: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      signInPolicy: { allowedFirstAuthFactors: { password: true, passkey: true } },
      // No explicit relying party id: Cognito binds passkeys to the pool's own
      // login domain. Naming the prefix domain here fails, because the domain
      // is created after the pool.
      passkeyUserVerification: PasskeyUserVerification.REQUIRED,
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      ...(plan === 'PLUS'
        ? { standardThreatProtectionMode: StandardThreatProtectionMode.FULL_FUNCTION }
        : {}),
      userInvitation: {
        emailSubject: 'Your Blueprint Music Group sign-in',
        emailBody:
          'Hi, Blueprint Music Group has set up your account.<br><br>Email: {username}<br>Temporary password: {####}<br><br>You will be asked to set your own password and an authenticator app the first time you sign in.',
      },
      lambdaTriggers: { preSignUp, postConfirmation, customMessage },
    });
    this.userPool.addTrigger(
      UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preToken,
      LambdaVersion.V2_0,
    );
    // A passkey with user verification satisfies required MFA on its own (design 6.1).
    (this.userPool.node.defaultChild as CfnUserPool).webAuthnFactorConfiguration =
      'MULTI_FACTOR_WITH_USER_VERIFICATION';

    for (const group of USER_GROUPS) {
      new CfnUserPoolGroup(this, `Group-${group}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: group,
        precedence: PRECEDENCE[group],
        description: `BMG ${group}. Membership is set only by the API or the bmg CLI.`,
      });
    }

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    const params: Record<string, string> = {
      'identity/user-pool-id': this.userPool.userPoolId,
      'identity/user-pool-arn': this.userPool.userPoolArn,
      'identity/login-domain': loginHost,
      'identity/issuer': `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
    };
    for (const [key, value] of Object.entries(params)) {
      new StringParameter(this, key.replace(/\W/g, '-'), {
        parameterName: names.ssm(cfg, env, key),
        stringValue: value,
      });
    }
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'LoginDomain', { value: loginHost });

    if (plan !== 'PLUS') {
      acknowledge(
        this.userPool,
        'Threat protection needs the Plus plan; staging uses Essentials by decision D3.',
        'AwsSolutions-COG3',
        'AwsSolutions-COG8',
      );
    }
  }
}
