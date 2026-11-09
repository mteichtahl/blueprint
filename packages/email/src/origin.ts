import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

let cached: Promise<string> | undefined;

/**
 * The web app's origin for links and the logo. The web stack publishes it in
 * SSM (`/<project>/<env>/web/url`, the CloudFront address until DNS moves),
 * and it is created after the stacks that send email, so it's read at run
 * time (APP_URL_PARAM), falling back to APP_ORIGIN.
 */
export function appOrigin(): Promise<string> {
  cached ??= (async () => {
    const fallback = process.env.APP_ORIGIN ?? '';
    const param = process.env.APP_URL_PARAM;
    if (!param) return fallback;
    try {
      const res = await new SSMClient({}).send(new GetParameterCommand({ Name: param }));
      return res.Parameter?.Value || fallback;
    } catch {
      return fallback;
    }
  })();
  return cached;
}
