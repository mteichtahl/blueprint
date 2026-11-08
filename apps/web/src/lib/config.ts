/** Runtime settings written into config.json by the web stack at deploy time. */
export interface AppConfig {
  loginDomain: string;
  clientId: string;
  region: string;
  userPoolId: string;
  apiBase: string;
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
