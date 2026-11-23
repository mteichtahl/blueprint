import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  CreateAPIKeyCommand,
  GetWebACLCommand,
  ListAPIKeysCommand,
  WAFV2Client,
} from '@aws-sdk/client-wafv2';
import { configPath, EnvironmentName, names, saveConfig } from '@bmg/config';
import { assertAccount, readConfig } from '../lib/aws.ts';
import {
  executePlan,
  heading,
  log,
  ok,
  REPO_ROOT,
  warn,
  type GlobalOptions,
} from '../lib/runtime.ts';

export interface EnquiriesOptions extends GlobalOptions {
  env: string;
}

/** The web ACL's CAPTCHA script: its integration address plus jsapi.js. */
export const captchaScriptUrl = (integrationUrl: string) =>
  `${integrationUrl.replace(/\/?$/, '/')}jsapi.js`;

/** True when an existing key covers exactly these addresses (in any order). */
export const sameDomains = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/**
 * The public consultation form's CAPTCHA (rev 21). AWS WAF's CAPTCHA puzzle
 * needs an API key for the app's addresses, and the page needs the web ACL's
 * script address. Neither is a CloudFormation resource, so this makes the key
 * once (or finds it) and records both in bmg.config.json; the next deploy puts
 * them in the app's config.json. The key isn't secret: the page sends it.
 */
export async function enquiriesCaptchaKey(opts: EnquiriesOptions): Promise<void> {
  const env = EnvironmentName.parse(opts.env);
  const cfg = readConfig();
  await assertAccount(cfg);
  const region = cfg.account.homeRegion;
  const domains = [...names.webHosts(cfg, env), cfg.domain.root];
  heading(`CAPTCHA for the consultation form (${env})`);

  const param = await new SSMClient({ region }).send(
    new GetParameterCommand({ Name: names.ssm(cfg, env, 'enquiries/web-acl') }),
  );
  const [name, id] = (param.Parameter?.Value ?? '').split('|');
  if (!name || !id) {
    warn(`Deploy the ${names.envStack(cfg, env, 'enquiries')} stack first.`);
    return;
  }
  const waf = new WAFV2Client({ region });
  const acl = await waf.send(new GetWebACLCommand({ Name: name, Id: id, Scope: 'REGIONAL' }));
  const integration = acl.ApplicationIntegrationURL;
  if (!integration) throw new Error(`The web ACL ${name} has no CAPTCHA integration address yet.`);
  const scriptUrl = captchaScriptUrl(integration);

  const existing = await waf.send(new ListAPIKeysCommand({ Scope: 'REGIONAL', Limit: 100 }));
  let apiKey = existing.APIKeySummaries?.find((k) =>
    sameDomains(k.TokenDomains ?? [], domains),
  )?.APIKey;
  if (apiKey) ok(`Found a key for ${domains.join(', ')}`);
  else {
    await executePlan(
      'Make the CAPTCHA key',
      [
        {
          description: `AWS WAF (${region}): CAPTCHA API key for ${domains.join(', ')}`,
          run: async () => {
            const res = await waf.send(
              new CreateAPIKeyCommand({ Scope: 'REGIONAL', TokenDomains: domains }),
            );
            apiKey = res.APIKey;
            ok('Key made');
          },
        },
      ],
      opts,
    );
    if (!apiKey) return;
  }

  const was = cfg.environments[env].captcha;
  if (was?.apiKey === apiKey && was.scriptUrl === scriptUrl) {
    ok('bmg.config.json already has it');
    return;
  }
  await executePlan(
    'Record the CAPTCHA',
    [
      {
        description: `bmg.config.json: environments.${env}.captcha (script ${scriptUrl})`,
        run: async () => {
          const next = structuredClone(cfg);
          next.environments[env].captcha = { scriptUrl, apiKey: apiKey! };
          saveConfig(next, configPath(REPO_ROOT));
          ok('Saved. Commit it and merge to main; the next deploy turns the CAPTCHA on.');
        },
      },
    ],
    opts,
  );
  log('\nUntil then, the form shows "Bookings open soon" instead of sending.');
}
