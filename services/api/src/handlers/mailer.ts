import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { SQSEvent } from 'aws-lambda';
import nodemailer from 'nodemailer';
import { emailText, type Draft } from '../notifications/model.ts';

const secrets = new SecretsManagerClient({});
const ssm = new SSMClient({});
let appUrl: string | undefined;

/** The web app's address, from the web stack's SSM parameter (it deploys after this one). */
async function webUrl(): Promise<string> {
  if (appUrl) return appUrl;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: process.env.APP_URL_PARAM }));
    appUrl = res.Parameter?.Value ?? '';
  } catch {
    appUrl = '';
  }
  return appUrl;
}

interface SmtpSecret {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
}

let smtp: SmtpSecret | null | undefined;

/** The Gmail credentials from `blueprint email setup`; null until that has run. */
async function credentials(): Promise<SmtpSecret | null> {
  if (smtp !== undefined) return smtp;
  try {
    const res = await secrets.send(
      new GetSecretValueCommand({ SecretId: process.env.SMTP_SECRET_ID }),
    );
    smtp = JSON.parse(res.SecretString ?? 'null') as SmtpSecret | null;
  } catch (err) {
    if ((err as Error).name !== 'ResourceNotFoundException') throw err;
    smtp = null;
  }
  return smtp;
}

/**
 * Sends notification emails as the configured sender through Gmail SMTP
 * (design 7.4). One at a time (reserved concurrency 1) to stay well inside
 * Gmail's sending limits; failures go back to the queue and then its DLQ.
 * Addresses and contents are never logged.
 */
export async function handler(event: SQSEvent) {
  const creds = await credentials();
  if (!creds) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'mail.notConfigured', dropped: event.Records.length }),
    );
    return;
  }
  const transport = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    requireTLS: !creds.secure,
    auth: { user: creds.username, pass: creds.password },
  });
  try {
    for (const record of event.Records) {
      const { to, draft } = JSON.parse(record.body) as { to: string; draft: Draft };
      const mail = emailText(draft, await webUrl());
      await transport.sendMail({ from: creds.from, to, ...mail });
    }
    console.log(JSON.stringify({ level: 'info', event: 'mail.sent', count: event.Records.length }));
  } finally {
    transport.close();
  }
}
