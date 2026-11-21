import { promises as dnsLookup } from 'node:dns';
import {
  ACMClient,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { configPath, EnvironmentName, names, saveConfig, type BmgConfig } from '@bmg/config';
import { assertAccount, isNotFound, readConfig } from '../lib/aws.ts';
import {
  cloudFrontDomainFromOutputs,
  dnsRecords,
  findCertificate,
  type CertSummary,
  type DnsRecord,
  type ValidationRecord,
} from '../lib/dns.ts';
import {
  executePlan,
  fail,
  heading,
  log,
  ok,
  REPO_ROOT,
  sleep,
  warn,
  type GlobalOptions,
} from '../lib/runtime.ts';

export interface DnsOptions extends GlobalOptions {
  env: string;
  /** Keep checking until the certificate is issued (up to 30 minutes). */
  wait?: boolean;
}

/** CloudFront only takes certificates from us-east-1. */
const acm = (cfg: BmgConfig) => new ACMClient({ region: cfg.account.edgeRegion });

async function listCerts(cfg: BmgConfig): Promise<CertSummary[]> {
  const out: CertSummary[] = [];
  let NextToken: string | undefined;
  do {
    const res = await acm(cfg).send(
      new ListCertificatesCommand({
        CertificateStatuses: ['ISSUED', 'PENDING_VALIDATION'],
        ...(NextToken ? { NextToken } : {}),
      }),
    );
    for (const c of res.CertificateSummaryList ?? []) {
      if (!c.CertificateArn || !c.DomainName) continue;
      out.push({
        arn: c.CertificateArn,
        domainName: c.DomainName,
        sans: c.SubjectAlternativeNameSummaries ?? [c.DomainName],
        status: c.Status ?? '',
      });
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return out;
}

/** The certificate's status and validation records (ACM adds them a few seconds after a request). */
async function describe(cfg: BmgConfig, arn: string) {
  for (let i = 0; i < 10; i++) {
    const c = (await acm(cfg).send(new DescribeCertificateCommand({ CertificateArn: arn })))
      .Certificate;
    const validation: ValidationRecord[] = (c?.DomainValidationOptions ?? [])
      .map((o) => o.ResourceRecord)
      .filter((r): r is NonNullable<typeof r> => !!r?.Name && !!r.Value)
      .map((r) => ({ name: r.Name!, value: r.Value! }));
    const expected = c?.SubjectAlternativeNames?.length ?? 1;
    if (c?.Status === 'ISSUED' || validation.length >= expected) {
      return { status: c?.Status ?? '', validation };
    }
    await sleep(3000);
  }
  throw new Error('ACM has not produced the validation records yet. Re-run in a minute.');
}

async function cloudFrontDomain(cfg: BmgConfig, env: EnvironmentName) {
  try {
    const res = await new CloudFormationClient({ region: cfg.account.homeRegion }).send(
      new DescribeStacksCommand({ StackName: names.envStack(cfg, env, 'web') }),
    );
    return cloudFrontDomainFromOutputs(res.Stacks?.[0]?.Outputs ?? []);
  } catch (err) {
    if (isNotFound(err) || /does not exist/.test((err as Error).message)) return undefined;
    throw err;
  }
}

function printRecords(cfg: BmgConfig, records: DnsRecord[]) {
  log(`\nAdd these at the name server for ${cfg.domain.root} (type CNAME, TTL 300 or "auto"):`);
  for (const r of records) {
    log(`\n  Host:  ${r.host}`);
    log(`         (full name ${r.fqdn})`);
    log(`  Type:  ${r.type}`);
    log(`  Value: ${r.value}`);
    log(`  Why:   ${r.why}`);
  }
  log(
    '\nIf the panel adds the domain itself, enter only the Host part. ' +
      "Some panels want the value with a trailing dot; that's fine either way.",
  );
}

/** Ask ACM (us-east-1) for the certificate and print its validation records. */
export async function dnsCert(opts: DnsOptions): Promise<void> {
  const env = EnvironmentName.parse(opts.env);
  const cfg = readConfig();
  await assertAccount(cfg);
  const hosts = names.webHosts(cfg, env);
  heading(`Certificate for ${hosts.join(' and ')} (${env})`);

  let cert = findCertificate(await listCerts(cfg), hosts);
  if (cert)
    ok(`Found ${cert.status === 'ISSUED' ? 'an issued' : 'a pending'} certificate: ${cert.arn}`);
  else {
    await executePlan(
      `Request the ${env} certificate`,
      [
        {
          description: `ACM (${cfg.account.edgeRegion}): certificate for ${hosts.join(', ')}, validated by DNS`,
          run: async () => {
            const res = await acm(cfg).send(
              new RequestCertificateCommand({
                DomainName: hosts[0]!,
                SubjectAlternativeNames: hosts,
                ValidationMethod: 'DNS',
                // Same request on a re-run returns the same certificate.
                IdempotencyToken: `${cfg.project}${env}web`,
                Tags: [
                  { Key: 'Project', Value: cfg.project },
                  { Key: 'Environment', Value: env },
                ],
              }),
            );
            cert = {
              arn: res.CertificateArn!,
              domainName: hosts[0]!,
              sans: hosts,
              status: 'PENDING_VALIDATION',
            };
            ok(`Requested ${cert.arn}`);
          },
        },
      ],
      opts,
    );
    if (!cert) return;
  }

  const first = await describe(cfg, cert.arn);
  let status = first.status;
  const validation = first.validation;
  if (status !== 'ISSUED') {
    printRecords(cfg, dnsRecords(cfg, env, { validation }));
    if (opts.wait) {
      log('\nWaiting for ACM to see the records (checks every 30 s, up to 30 minutes)…');
      for (let i = 0; i < 60 && status !== 'ISSUED'; i++) {
        await sleep(30_000);
        ({ status } = await describe(cfg, cert.arn));
      }
    }
  }
  if (status !== 'ISSUED') {
    warn(
      `The certificate is ${status}. Add the records above, then run ` +
        `\`npm run blueprint -- dns cert --env ${env} --wait\` again. It usually issues within 5–30 minutes.`,
    );
    return;
  }
  ok('Certificate issued');

  if (cfg.environments[env].certificateArn === cert.arn) {
    ok('bmg.config.json already has it');
  } else {
    await executePlan(
      'Record the certificate',
      [
        {
          description: `bmg.config.json: environments.${env}.certificateArn = ${cert.arn}`,
          run: async () => {
            const next = structuredClone(cfg);
            next.environments[env].certificateArn = cert!.arn;
            saveConfig(next, configPath(REPO_ROOT));
            ok('Saved. Commit it and merge to main; the next deploy attaches the hosts.');
          },
        },
      ],
      opts,
    );
  }
  log(`\nNext: \`npm run blueprint -- dns records --env ${env}\` for the app records.`);
}

/** Print every record the name server needs for an environment (read-only). */
export async function dnsRecordsCmd(opts: DnsOptions): Promise<void> {
  const env = EnvironmentName.parse(opts.env);
  const cfg = readConfig();
  await assertAccount(cfg);
  const hosts = names.webHosts(cfg, env);
  heading(`DNS records for ${env}`);
  const cert = findCertificate(await listCerts(cfg), hosts);
  const validation = cert ? (await describe(cfg, cert.arn)).validation : [];
  if (!cert) warn(`No certificate yet: run \`npm run blueprint -- dns cert --env ${env}\` first.`);
  const cf = await cloudFrontDomain(cfg, env);
  if (!cf)
    warn(
      `${names.envStack(cfg, env, 'web')} isn't deployed yet, so there's no CloudFront address to point at.`,
    );
  printRecords(cfg, dnsRecords(cfg, env, { validation, cloudFrontDomain: cf }));
}

async function cname(name: string): Promise<string[]> {
  try {
    return (await dnsLookup.resolveCname(name)).map((v) => v.replace(/\.$/, '').toLowerCase());
  } catch {
    return [];
  }
}

/** Check the records are live in public DNS and the certificate is issued (read-only). */
export async function dnsCheck(opts: DnsOptions): Promise<void> {
  const env = EnvironmentName.parse(opts.env);
  const cfg = readConfig();
  await assertAccount(cfg);
  const hosts = names.webHosts(cfg, env);
  heading(`DNS check for ${env}`);
  const cert = findCertificate(await listCerts(cfg), hosts);
  const cf = await cloudFrontDomain(cfg, env);
  const records = dnsRecords(cfg, env, {
    validation: cert ? (await describe(cfg, cert.arn)).validation : [],
    cloudFrontDomain: cf,
  });
  let good = true;
  for (const r of records) {
    const found = await cname(r.fqdn);
    if (found.includes(r.value.toLowerCase())) ok(`${r.fqdn} → ${r.value}`);
    else {
      good = false;
      fail(
        `${r.fqdn} should be a CNAME to ${r.value} (${found.length ? 'it points elsewhere' : 'not found'})`,
      );
    }
  }
  (cert?.status === 'ISSUED' ? ok : fail)(`Certificate ${cert?.status ?? 'not requested'}`);
  (cfg.environments[env].certificateArn ? ok : warn)(
    cfg.environments[env].certificateArn
      ? 'bmg.config.json has the certificate'
      : 'bmg.config.json has no certificateArn yet (dns cert saves it once issued)',
  );
  if (!good) process.exitCode = 1;
}
