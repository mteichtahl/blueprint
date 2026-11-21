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

/**
 * The address for the Blueprint team (team invites, their notification
 * emails): ADMIN_ORIGIN, e.g. https://admin.blueprintmusic.group. While the
 * app is still on its *.cloudfront.net address (no certificate yet) the admin
 * host doesn't answer, so this is the same as appOrigin().
 */
export async function adminOrigin(): Promise<string> {
  return pickAdminOrigin(await appOrigin(), process.env.ADMIN_ORIGIN);
}

/** appOrigin() until the custom hosts are live, then the admin host. */
export function pickAdminOrigin(app: string, admin: string | undefined): string {
  if (!admin || !app || app.includes('.cloudfront.net')) return app;
  return admin.replace(/\/$/, '');
}
