import { describe, expect, it } from 'vitest';
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
