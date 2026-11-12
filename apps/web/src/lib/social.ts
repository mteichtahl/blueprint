import type { AppConfig } from './config.ts';
import type { Tokens } from './cognito.ts';

/**
 * Social sign-in (design D2): Google, Apple or Facebook through Cognito's
 * OAuth endpoints with PKCE. The button sends people straight to the
 * provider (`identity_provider`), never to a Cognito page, and back to
 * /auth/callback, where the code is swapped for tokens. The API then asks for
 * the app's own two-step check (step-up), because Cognito applies no MFA to
 * social sign-ins.
 */

export const SOCIAL_LABEL: Record<string, string> = {
  Google: 'Google',
  SignInWithApple: 'Apple',
  Facebook: 'Facebook',
};

const KEY = 'bmg.social';
const CALLBACK = '/auth/callback';

interface Pending {
  provider: string;
  verifier: string;
  state: string;
  /** The account was just linked and this is the automatic second try. */
  retried?: boolean;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** The providers this deploy offers, in a fixed order. */
export function socialProviders(cfg: AppConfig): string[] {
  const on = new Set(cfg.socialProviders ?? []);
  return cfg.loginDomain ? ['Google', 'SignInWithApple', 'Facebook'].filter((p) => on.has(p)) : [];
}

/** Sends the browser to the provider. */
export async function startSocial(cfg: AppConfig, provider: string, retried = false) {
  const verifier = random(48);
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const state = random(16);
  const pending: Pending = { provider, verifier, state, ...(retried ? { retried } : {}) };
  sessionStorage.setItem(KEY, JSON.stringify(pending));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: `${window.location.origin}${CALLBACK}`,
    identity_provider: provider,
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.assign(`https://${cfg.loginDomain}/oauth2/authorize?${q.toString()}`);
}

export const isSocialCallback = (url: URL) => url.pathname === CALLBACK;

/** Plain words for what came back instead of a code. */
export function socialError(description: string | null, provider: string): string {
  const who = SOCIAL_LABEL[provider] ?? 'that account';
  if (description && /invitation only/i.test(description)) {
    return `There’s no Blueprint account for that ${who} email. Sign in with the email Blueprint invited you with, or ask Blueprint to invite that address.`;
  }
  return `Signing in with ${who} didn’t work. Try again, or use your email and password.`;
}

/**
 * Finishes a social sign-in on /auth/callback: the tokens, or `redirecting`
 * when the account was just linked and it's signing in once more, or an
 * error in plain words.
 */
export async function finishSocial(
  cfg: AppConfig,
  url: URL,
): Promise<{ tokens: Tokens } | { redirecting: true } | { error: string }> {
  const raw = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  const pending = raw ? (JSON.parse(raw) as Pending) : undefined;
  if (!pending) return { error: 'That sign-in link has expired. Try again.' };
  const description = url.searchParams.get('error_description');
  if (url.searchParams.get('error')) {
    // A first social sign-in links to the person's account, then stops once; go again.
    if (description?.includes('BMG_LINKED') && !pending.retried) {
      await startSocial(cfg, pending.provider, true);
      return { redirecting: true };
    }
    return { error: socialError(description, pending.provider) };
  }
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== pending.state) {
    return { error: 'That sign-in didn’t match. Try again.' };
  }
  const res = await fetch(`https://${cfg.loginDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code,
      redirect_uri: `${window.location.origin}${CALLBACK}`,
      code_verifier: pending.verifier,
    }).toString(),
  });
  if (!res.ok) return { error: socialError(null, pending.provider) };
  const t = (await res.json()) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    tokens: {
      AccessToken: t.access_token,
      IdToken: t.id_token,
      ...(t.refresh_token ? { RefreshToken: t.refresh_token } : {}),
      ExpiresIn: t.expires_in,
    },
  };
}
