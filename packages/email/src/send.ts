import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import nodemailer, { type Transporter } from 'nodemailer';
import type { RenderedEmail } from './layout.ts';

/** Shape stored by `blueprint email setup` in Secrets Manager (bmg/<env>/gmail-smtp). */
export interface SmtpSecret {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
}

let cached: Promise<{ transport: Transporter; from: string; sender: string }> | undefined;

async function load(secretId: string) {
  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) throw new Error('SMTP secret has no value');
  const s = JSON.parse(res.SecretString) as SmtpSecret;
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    requireTLS: !s.secure,
    auth: { user: s.username, pass: s.password },
    tls: { minVersion: 'TLSv1.2' },
    pool: true,
    maxConnections: 2,
  });
  return { transport, from: s.from, sender: s.username };
}

/** One SMTP transport per Lambda container; the secret id comes from SMTP_SECRET_ID. */
function mailer() {
  const secretId = process.env.SMTP_SECRET_ID;
  if (!secretId) throw new Error('SMTP_SECRET_ID is not set');
  cached ??= load(secretId).catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}

/** The address app email is sent from (the Gmail account in the secret). */
export async function senderAddress(): Promise<string> {
  return (await mailer()).sender;
}

/** Sends a rendered email (HTML with a plain-text alternative) through Gmail SMTP. */
export async function sendMail(to: string, email: RenderedEmail): Promise<{ messageId: string }> {
  const { transport, from } = await mailer();
  const info = await transport.sendMail({
    from,
    to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  return { messageId: info.messageId };
}
