import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@bmg/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captchaScriptUrl, sameDomains } from '../src/commands/enquiries.ts';

/** `blueprint enquiries captcha-key` (rev 21). */
describe('the consultation form’s CAPTCHA key', () => {
  it('builds the script address from the web ACL’s integration address', () => {
    expect(captchaScriptUrl('https://abc.ap-southeast-2.captcha-sdk.awswaf.com/abc/')).toBe(
      'https://abc.ap-southeast-2.captcha-sdk.awswaf.com/abc/jsapi.js',
    );
    expect(captchaScriptUrl('https://abc.ap-southeast-2.captcha-sdk.awswaf.com/abc')).toBe(
      'https://abc.ap-southeast-2.captcha-sdk.awswaf.com/abc/jsapi.js',
    );
  });

  it('reuses a key made for the same addresses, in any order', () => {
    expect(sameDomains(['a.x', 'b.x'], ['b.x', 'a.x'])).toBe(true);
    expect(sameDomains(['a.x'], ['a.x', 'b.x'])).toBe(false);
  });

  it('records only a real CAPTCHA script address in bmg.config.json', () => {
    const base = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../../bmg.config.example.json'), 'utf8'),
    );
    const withCaptcha = (scriptUrl: string) => {
      const c = structuredClone(base);
      c.environments.staging.captcha = { scriptUrl, apiKey: 'k'.repeat(40) };
      return c;
    };
    expect(() =>
      parseConfig(withCaptcha('https://abc.ap-southeast-2.captcha-sdk.awswaf.com/abc/jsapi.js')),
    ).not.toThrow();
    expect(() => parseConfig(withCaptcha('https://evil.example/jsapi.js'))).toThrow();
  });
});

describe('blueprint enquiries captcha-key', () => {
  it('takes the script address from AWS WAF’s API keys, makes the key once and records both', async () => {
    vi.resetModules();
    const calls: string[] = [];
    let keys: { TokenDomains: string[]; APIKey: string }[] = [];
    const saved: unknown[] = [];
    const cfg = parseConfig(
      JSON.parse(
        readFileSync(resolve(import.meta.dirname, '../../../bmg.config.example.json'), 'utf8'),
      ),
    );
    vi.doMock('../src/lib/aws.ts', () => ({
      readConfig: () => structuredClone(cfg),
      assertAccount: async () => undefined,
    }));
    vi.doMock('@bmg/config', async (orig) => ({
      ...(await orig<typeof import('@bmg/config')>()),
      saveConfig: (c: unknown) => saved.push(c),
    }));
    vi.doMock('@aws-sdk/client-ssm', async (orig) => ({
      ...(await orig<typeof import('@aws-sdk/client-ssm')>()),
      SSMClient: class {
        async send() {
          return { Parameter: { Value: 'bmg-staging-enquiries|abc' } };
        }
      },
    }));
    vi.doMock('@aws-sdk/client-wafv2', async (orig) => ({
      ...(await orig<typeof import('@aws-sdk/client-wafv2')>()),
      WAFV2Client: class {
        async send(cmd: { constructor: { name: string }; input: { TokenDomains?: string[] } }) {
          calls.push(cmd.constructor.name);
          switch (cmd.constructor.name) {
            // No integration address here: the web ACL has no Bot or Fraud Control.
            case 'GetWebACLCommand':
              return { WebACL: {} };
            case 'ListAPIKeysCommand':
              return {
                APIKeySummaries: keys,
                ApplicationIntegrationURL:
                  'https://abc123.ap-southeast-2.captcha-sdk.awswaf.com/abc123/',
              };
            case 'CreateAPIKeyCommand':
              keys = [{ TokenDomains: cmd.input.TokenDomains!, APIKey: 'k'.repeat(40) }];
              return { APIKey: 'k'.repeat(40) };
          }
          return {};
        }
      },
    }));
    const { enquiriesCaptchaKey } = await import('../src/commands/enquiries.ts');
    await enquiriesCaptchaKey({ env: 'staging', yes: true } as never);
    expect(calls.filter((c) => c === 'CreateAPIKeyCommand')).toHaveLength(1);
    expect(saved).toHaveLength(1);
    const staging = (saved[0] as typeof cfg).environments.staging;
    expect(staging.captcha).toEqual({
      scriptUrl: 'https://abc123.ap-southeast-2.captcha-sdk.awswaf.com/abc123/jsapi.js',
      apiKey: 'k'.repeat(40),
    });
    expect(() => parseConfig(saved[0])).not.toThrow();
  });
});
