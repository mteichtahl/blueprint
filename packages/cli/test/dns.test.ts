import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@bmg/config';
import {
  cloudFrontDomainFromOutputs,
  dnsRecords,
  findCertificate,
  relativeName,
} from '../src/lib/dns.ts';

const cfg = parseConfig(
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../bmg.config.example.json'), 'utf8'),
  ),
);
const root = cfg.domain.root;

describe('dns records', () => {
  it('names records relative to the domain', () => {
    expect(relativeName(`artist-beta.${root}.`, root)).toBe('artist-beta');
    expect(relativeName(`_abc.admin.${root}`, root)).toBe('_abc.admin');
    expect(relativeName(root, root)).toBe('@');
  });

  it('lists validation records once each, then both hosts to CloudFront', () => {
    const records = dnsRecords(cfg, 'staging', {
      validation: [
        { name: `_a1.artist-beta.${root}.`, value: '_x1.acm-validations.aws.' },
        { name: `_b2.admin-beta.${root}.`, value: '_y2.acm-validations.aws.' },
        { name: `_a1.artist-beta.${root}.`, value: '_x1.acm-validations.aws.' },
      ],
      cloudFrontDomain: 'd1e03n0k2euijp.cloudfront.net',
    });
    expect(records.map((r) => [r.host, r.value])).toEqual([
      ['_a1.artist-beta', '_x1.acm-validations.aws'],
      ['_b2.admin-beta', '_y2.acm-validations.aws'],
      ['artist-beta', 'd1e03n0k2euijp.cloudfront.net'],
      ['admin-beta', 'd1e03n0k2euijp.cloudfront.net'],
    ]);
  });

  it('uses artist and admin in prod', () => {
    const records = dnsRecords(cfg, 'prod', {
      validation: [],
      cloudFrontDomain: 'dx.cloudfront.net',
    });
    expect(records.map((r) => r.host)).toEqual(['artist', 'admin']);
  });

  it('prefers an issued certificate covering both hosts', () => {
    const hosts = [`artist.${root}`, `admin.${root}`];
    const pick = findCertificate(
      [
        { arn: 'a', domainName: hosts[0]!, sans: [hosts[0]!], status: 'ISSUED' },
        { arn: 'b', domainName: hosts[0]!, sans: hosts, status: 'PENDING_VALIDATION' },
        { arn: 'c', domainName: hosts[0]!, sans: hosts, status: 'ISSUED' },
      ],
      hosts,
    );
    expect(pick?.arn).toBe('c');
  });

  it('finds the CloudFront address in the web stack outputs', () => {
    expect(
      cloudFrontDomainFromOutputs([
        { OutputKey: 'CloudFrontDomain', OutputValue: 'd1.cloudfront.net' },
      ]),
    ).toBe('d1.cloudfront.net');
    expect(
      cloudFrontDomainFromOutputs([
        { OutputKey: 'WebUrl', OutputValue: 'https://d2.cloudfront.net' },
      ]),
    ).toBe('d2.cloudfront.net');
    expect(
      cloudFrontDomainFromOutputs([{ OutputKey: 'WebUrl', OutputValue: `https://artist.${root}` }]),
    ).toBeUndefined();
  });
});
