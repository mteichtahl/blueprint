import { names, type BmgConfig, type EnvironmentName } from '@bmg/config';

/** One record to add at the domain's name server (docs/dns.md). */
export interface DnsRecord {
  /** Full name, e.g. artist-beta.blueprintmusic.group */
  fqdn: string;
  /** The same name relative to the domain, as most DNS panels want it (e.g. artist-beta). */
  host: string;
  type: 'CNAME';
  value: string;
  why: string;
}

/** A certificate as ACM lists it (only the fields we use). */
export interface CertSummary {
  arn: string;
  domainName: string;
  sans: string[];
  status: string;
}

/** ACM's DNS validation records, one per name on the certificate. */
export interface ValidationRecord {
  name: string;
  value: string;
}

const trimDot = (s: string) => s.replace(/\.$/, '');

/** `artist-beta.blueprintmusic.group` → `artist-beta`; the root itself → `@`. */
export function relativeName(fqdn: string, root: string): string {
  const name = trimDot(fqdn).toLowerCase();
  const zone = trimDot(root).toLowerCase();
  if (name === zone) return '@';
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

/**
 * The certificate already requested for this environment's two hosts, if
 * any: the artist host as its name and both hosts covered. Issued ones win
 * over pending ones; failed, revoked or expired ones are ignored.
 */
export function findCertificate(certs: CertSummary[], hosts: string[]): CertSummary | undefined {
  const usable = certs.filter(
    (c) =>
      c.domainName === hosts[0] &&
      hosts.every((h) => c.sans.includes(h)) &&
      ['ISSUED', 'PENDING_VALIDATION'].includes(c.status),
  );
  return usable.find((c) => c.status === 'ISSUED') ?? usable[0];
}

/**
 * Every record the name server needs for one environment: the certificate's
 * validation CNAMEs (keep them; ACM renews with them) and the two app hosts
 * pointing at the CloudFront distribution.
 */
export function dnsRecords(
  cfg: BmgConfig,
  env: EnvironmentName,
  input: { validation: ValidationRecord[]; cloudFrontDomain?: string | undefined },
): DnsRecord[] {
  const root = cfg.domain.root;
  const seen = new Set<string>();
  const validation = input.validation
    .filter((v) => !seen.has(v.name) && seen.add(v.name))
    .map((v): DnsRecord => ({
      fqdn: trimDot(v.name),
      host: relativeName(v.name, root),
      type: 'CNAME',
      value: trimDot(v.value),
      why: 'proves to AWS you own the name (certificate); keep it for renewals',
    }));
  const app = input.cloudFrontDomain
    ? names.webHosts(cfg, env).map((h, i): DnsRecord => ({
        fqdn: h,
        host: relativeName(h, root),
        type: 'CNAME',
        value: trimDot(input.cloudFrontDomain!),
        why: i === 0 ? 'the app for artists' : 'the app for the Blueprint team',
      }))
    : [];
  return [...validation, ...app];
}

/** The CloudFront host out of the web stack's outputs (new output first, then WebUrl). */
export function cloudFrontDomainFromOutputs(
  outputs: Array<{ OutputKey?: string | undefined; OutputValue?: string | undefined }>,
): string | undefined {
  const get = (k: string) => outputs.find((o) => o.OutputKey === k)?.OutputValue;
  const direct = get('CloudFrontDomain');
  if (direct) return direct;
  const url = get('WebUrl');
  const host = url ? new URL(url).hostname : undefined;
  return host?.endsWith('.cloudfront.net') ? host : undefined;
}
