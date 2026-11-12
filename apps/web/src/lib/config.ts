/** Runtime settings written into config.json by the web stack at deploy time. */
export interface AppConfig {
  /** Cognito's domain: social sign-in goes through it (never its own sign-in pages). */
  loginDomain?: string;
  clientId: string;
  region: string;
  userPoolId: string;
  apiBase: string;
  /** AppSync Events domains for realtime inbox nudges (absent in older deploys). */
  realtime?: { http: string; ws: string };
  /** Social sign-in providers turned on (Cognito names: Google, SignInWithApple, Facebook). */
  socialProviders?: string[];
  /** Text-message codes are on as a second factor. */
  smsMfa?: boolean;
}

let cached: AppConfig | undefined;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load app settings');
  cached = (await res.json()) as AppConfig;
  if (!cached.clientId || !cached.userPoolId) throw new Error('App settings are incomplete');
  return cached;
}
