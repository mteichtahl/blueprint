#!/usr/bin/env node
/**
 * AWS credentials for a GitHub deploy job (security review H1).
 *
 * A CodeBuild runner's own role can't deploy: a workflow on any branch can ask
 * for any runner by its label. Instead the job asks GitHub for its OIDC token
 * and swaps it for the target's deploy role (`bmg-github-deploy-<target>`).
 * That role only trusts tokens whose subject is the matching GitHub
 * environment, which GitHub only issues to a job that declared the
 * environment and passed its rules (production: v* tags and an approval).
 *
 * Usage (a step in a job with `permissions: id-token: write`):
 *   node tools/ci/aws-oidc.mjs staging|prod
 *
 * The credentials go to $GITHUB_ENV (masked) for the job's later steps, so the
 * AWS SDKs and the CDK pick them up ahead of the runner's own role. No AWS CLI
 * is needed: AssumeRoleWithWebIdentity is an unsigned STS call.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { URL, URLSearchParams } from 'node:url';

const AUDIENCE = 'sts.amazonaws.com';
const SESSION_SECONDS = 7200; // the deploy roles' maximum session

const target = process.argv[2];
if (target !== 'staging' && target !== 'prod') {
  console.error('Usage: node tools/ci/aws-oidc.mjs staging|prod');
  process.exit(2);
}

const need = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(
      `::error::${name} is not set. Give this job \`permissions: id-token: write\` and run it on GitHub Actions.`,
    );
    process.exit(1);
  }
  return v;
};

const config = JSON.parse(
  readFileSync(resolve(process.env.BMG_CONFIG ?? 'bmg.config.json'), 'utf8'),
);
const region = config.account.homeRegion;
const roleArn = `arn:aws:iam::${config.account.id}:role/${config.project}-github-deploy-${target}`;

const tokenUrl = new URL(need('ACTIONS_ID_TOKEN_REQUEST_URL'));
tokenUrl.searchParams.set('audience', AUDIENCE);
const tokenRes = await fetch(tokenUrl, {
  headers: { authorization: `Bearer ${need('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}` },
});
if (!tokenRes.ok) {
  console.error(`::error::GitHub refused the OIDC token request (HTTP ${tokenRes.status}).`);
  process.exit(1);
}
const { value: token } = await tokenRes.json();

const sts = new URL(`https://sts.${region}.amazonaws.com/`);
sts.search = new URLSearchParams({
  Action: 'AssumeRoleWithWebIdentity',
  Version: '2011-06-15',
  RoleArn: roleArn,
  RoleSessionName: `github-${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`,
  DurationSeconds: String(SESSION_SECONDS),
  WebIdentityToken: token,
}).toString();
const stsRes = await fetch(sts, { method: 'POST', headers: { accept: 'application/xml' } });
const xml = await stsRes.text();
const field = (name) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1];
if (!stsRes.ok) {
  const message = field('Message') ?? `HTTP ${stsRes.status}`;
  console.error(`::error::AWS refused ${roleArn}: ${message}`);
  console.error(
    'Deploy jobs must declare their GitHub environment (staging or production) and pass its rules.',
  );
  process.exit(1);
}

const creds = {
  AWS_ACCESS_KEY_ID: field('AccessKeyId'),
  AWS_SECRET_ACCESS_KEY: field('SecretAccessKey'),
  AWS_SESSION_TOKEN: field('SessionToken'),
};
if (Object.values(creds).some((v) => !v)) {
  console.error('::error::STS answered without credentials.');
  process.exit(1);
}
for (const v of Object.values(creds)) console.log(`::add-mask::${v}`);
const lines = Object.entries({ ...creds, AWS_REGION: region, AWS_DEFAULT_REGION: region }).map(
  ([k, v]) => `${k}=${v}`,
);
appendFileSync(need('GITHUB_ENV'), `${lines.join('\n')}\n`);
console.log(`Using ${roleArn} until ${field('Expiration')}.`);
