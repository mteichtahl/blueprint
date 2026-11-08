import { promises as dns } from 'node:dns';
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { password } from '@inquirer/prompts';
import nodemailer from 'nodemailer';
import { EnvironmentName, names } from '@bmg/config';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import { evaluateMailDns, smtpSecretPayload, type SmtpSecret } from '../lib/plans.ts';
import { executePlan, fail, heading, log, ok, type GlobalOptions } from '../lib/runtime.ts';

export interface EmailSetupOptions extends GlobalOptions {
  env: string;
  /** Send a test message to this address after verifying the login. */
  testTo?: string;
}

async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

export async function checkMailDns(domain: string): Promise<void> {
  heading(`Email DNS for ${domain}`);
  const found = evaluateMailDns(
    await txt(domain),
    await txt(`google._domainkey.${domain}`),
    await txt(`_dmarc.${domain}`),
  );
  (found.spf ? ok : fail)('SPF includes _spf.google.com');
  (found.dkim ? ok : fail)(
    'DKIM at google._domainkey (Admin console → Apps → Google Workspace → Gmail → Authenticate email)',
  );
  (found.dmarc ? ok : fail)('DMARC at _dmarc (start with p=quarantine)');
}

/** Log in to Gmail SMTP and optionally send a test message. Throws on failure. */
export async function verifySmtp(secret: SmtpSecret, testTo?: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: secret.host,
    port: secret.port,
    secure: secret.secure,
    requireTLS: !secret.secure,
    auth: { user: secret.username, pass: secret.password },
    tls: { minVersion: 'TLSv1.2' },
  });
  try {
    await transport.verify();
    ok(`Signed in to ${secret.host}:${secret.port} as ${secret.username}`);
    if (testTo) {
      const info = await transport.sendMail({
        from: secret.from,
        to: testTo,
        subject: 'BMG App: email is set up',
        text: 'This is a test message from the BMG setup CLI. App email is now sent through Gmail.',
      });
      ok(`Test email sent to ${testTo} (message id ${info.messageId})`);
    }
  } finally {
    transport.close();
  }
}

/**
 * `bmg email setup`: app email goes out through Gmail SMTP as the configured
 * sender (design 7.4). No Google Cloud project is involved. The Gmail app
 * password is stored only in Secrets Manager (bmg/<env>/gmail-smtp), encrypted
 * with that environment's platform key, and is never printed or logged.
 */
export async function emailSetup(opts: EmailSetupOptions): Promise<void> {
  const cfg = readConfig();
  await assertAccount(cfg);
  const env = EnvironmentName.parse(opts.env);
  const secretId = names.smtpSecret(cfg, env);

  log(
    `Sender: ${cfg.email.senderAddress}. Before continuing, sign in to Gmail as that account and:\n` +
      '  1. Turn on 2-Step Verification (myaccount.google.com → Security).\n' +
      '  2. Create an app password named "BMG App" (myaccount.google.com/apppasswords).\n' +
      '     If the page is missing, a Workspace admin must allow 2-Step Verification for the account.',
  );
  const secret = smtpSecretPayload(
    cfg,
    await password({ message: `Gmail app password for ${cfg.email.senderAddress}`, mask: '*' }),
  );

  // Prove the credentials work before storing them.
  await verifySmtp(secret);

  const client = new SecretsManagerClient({ region: cfg.account.homeRegion });
  let exists = true;
  try {
    await client.send(new DescribeSecretCommand({ SecretId: secretId }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    exists = false;
  }

  await executePlan(
    `Gmail SMTP for ${env}`,
    [
      {
        description: `${exists ? 'Update' : 'Create'} ${secretId} (host, port, sender, app password) under alias/${cfg.project}/${env}/platform`,
        run: async () => {
          const value = JSON.stringify(secret);
          if (exists) {
            await client.send(
              new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
            );
          } else {
            await client.send(
              new CreateSecretCommand({
                Name: secretId,
                SecretString: value,
                KmsKeyId: `alias/${cfg.project}/${env}/platform`,
                Description: `Gmail SMTP credentials for BMG ${env} app email`,
                Tags: [{ Key: 'bmg:env', Value: env }],
              }),
            );
          }
        },
      },
      ...(opts.testTo
        ? [
            {
              description: `Send a test email to ${opts.testTo}`,
              run: () => verifySmtp(secret, opts.testTo),
            },
          ]
        : []),
    ],
    opts,
  );
  await checkMailDns(cfg.email.domain);
}
