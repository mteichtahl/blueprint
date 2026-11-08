import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { Button, Card, Field, Notice } from '../components/ui.tsx';

/**
 * Two-step verification for Google, Apple or Facebook sign-ins (design 6.2).
 * Cognito applies no MFA to them, so the app verifies an authenticator code.
 */
export function StepUp({
  cfg,
  token,
  onVerified,
}: {
  cfg: AppConfig;
  token: string;
  onVerified: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const secret = uri ? new URL(uri).searchParams.get('secret') : null;

  async function setup() {
    setError(null);
    try {
      const res = await api<{ otpauthUri: string }>(cfg, token, 'POST', '/step-up/totp/setup', {});
      setUri(res.otpauthUri);
    } catch (e) {
      // 409: an authenticator is already set up; go straight to the code.
      if (e instanceof ApiError && e.status === 409) setUri('');
      else setError((e as Error).message);
    }
  }

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await api(cfg, token, 'POST', '/step-up/totp/verify', { code });
      onVerified();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card title="Two-step verification" className="w-full max-w-md space-y-4">
        <p className="text-sm text-muted-foreground">
          You signed in with a social account. Confirm it's you with a 6-digit code from an
          authenticator app.
        </p>
        {uri === null && (
          <div className="flex gap-2">
            <Button onClick={setup}>Set up an authenticator</Button>
            <Button variant="ghost" onClick={() => setUri('')}>
              I already have one
            </Button>
          </div>
        )}
        {uri && secret && (
          <div className="space-y-2 rounded-md bg-secondary p-3 text-sm">
            <p>
              On your phone,{' '}
              <a className="font-semibold underline" href={uri}>
                open this in your authenticator
              </a>
              , or add this key by hand:
            </p>
            <code className="block break-all font-mono text-xs">{secret}</code>
          </div>
        )}
        {uri !== null && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <Field
              label="6-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
            <Button type="submit" variant="cta" disabled={busy || code.length !== 6}>
              Verify
            </Button>
          </form>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </Card>
    </main>
  );
}
