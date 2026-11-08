import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  AccountRecovery,
  CfnManagedLoginBranding,
  CfnUserPool,
  CfnUserPoolGroup,
  ClientAttributes,
  FeaturePlan,
  LambdaVersion,
  ManagedLoginVersion,
  Mfa,
  OAuthScope,
  PasskeyUserVerification,
  StandardThreatProtectionMode,
  StringAttribute,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
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
 * - one public web client: authorization code + PKCE, 15-minute access tokens,
 *   30-day rotating refresh tokens;
 * - pre token generation V2 adds `role`, `artistId` and `mfa_level`.
 */
export class IdentityStack extends BmgStack {
  readonly userPool: UserPool;
  readonly webClient: UserPoolClient;
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
        actions: ['dynamodb:PutItem'],
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
      lambdaTriggers: { preSignUp, postConfirmation },
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

    const appOrigin = `https://${names.host(cfg, env, 'app')}`;
    const devOrigins = prod ? [] : ['http://localhost:5173'];
    this.webClient = this.userPool.addClient('Web', {
      userPoolClientName: `${cfg.project}-${env}-web`,
      generateSecret: false,
      authFlows: { user: true, userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [appOrigin, ...devOrigins].map((o) => `${o}/auth/callback`),
        logoutUrls: [appOrigin, ...devOrigins].map((o) => `${o}/signed-out`),
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      refreshTokenRotationGracePeriod: Duration.seconds(10),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      readAttributes: new ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes('artistId'),
      writeAttributes: new ClientAttributes().withStandardAttributes({ email: true }),
    });

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    // Managed login v2 needs a style per client; BMG branding is applied in Phase 6.
    new CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.webClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    const params: Record<string, string> = {
      'identity/user-pool-id': this.userPool.userPoolId,
      'identity/user-pool-arn': this.userPool.userPoolArn,
      'identity/web-client-id': this.webClient.userPoolClientId,
      'identity/login-domain': loginHost,
      'identity/issuer': `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
    };
    for (const [key, value] of Object.entries(params)) {
      new StringParameter(this, key.replace(/\W/g, '-'), {
        parameterName: names.ssm(cfg, env, key),
        stringValue: value,
      });
    }
    // The API used to import this client's id. Keep the export for one release
    // so deploying this stack first doesn't fail while the API still imports it;
    // remove this line (and the client) once the API reads the web stack's client.
    this.exportValue(this.webClient.userPoolClientId);
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
