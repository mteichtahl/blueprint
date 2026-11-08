import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import type { AppConfig } from './config.ts';

let manager: UserManager | undefined;

/**
 * Cognito sign-in with the authorization code flow + PKCE (design 6.1). The
 * client has no secret. Tokens stay in session storage, so closing the tab
 * signs out; the strict CSP limits what scripts can run on the page.
 */
export function auth(cfg: AppConfig): UserManager {
  manager ??= new UserManager({
    authority: `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`,
    client_id: cfg.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
  });
  return manager;
}

export async function currentUser(cfg: AppConfig): Promise<User | null> {
  const user = await auth(cfg).getUser();
  return user && !user.expired ? user : null;
}

/** Cognito's logout endpoint clears its own session too, then returns to /signed-out. */
export async function signOut(cfg: AppConfig): Promise<void> {
  await auth(cfg).removeUser();
  const back = encodeURIComponent(`${window.location.origin}/signed-out`);
  window.location.assign(
    `https://${cfg.loginDomain}/logout?client_id=${cfg.clientId}&logout_uri=${back}`,
  );
}
