import { useState } from 'react';
import { api, TERMS_VERSION } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { Button, Card, Notice } from '../components/ui.tsx';

/**
 * First sign-in: terms acceptance and an explicit AI choice (screens doc,
 * "Before you start"; design F1 step 4). Both are recorded in the consent ledger.
 */
export function Consent({
  cfg,
  token,
  isArtist,
  onDone,
}: {
  cfg: AppConfig;
  token: string;
  isArtist: boolean;
  onDone: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [ai, setAi] = useState<boolean | null>(isArtist ? null : true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(cfg, token, 'POST', '/consent', { termsVersion: TERMS_VERSION, aiOptIn: ai });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card title="Before you start" className="w-full max-w-lg space-y-5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>
            I accept Blueprint Music Group's Terms and Privacy Policy (version {TERMS_VERSION}). My
            data is stored in Australia.
          </span>
        </label>
        {isArtist && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">AI assistance</legend>
            <label className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
              <input
                type="radio"
                name="ai"
                className="mt-1"
                checked={ai === true}
                onChange={() => setAi(true)}
              />
              <span>
                <strong>Turn AI on.</strong> Your uploads are added to your own private AI knowledge
                base so the assistant can answer questions and draft actions for your OK. Other
                artists never see it. You can turn it off any time, and it's deleted within an hour.
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
              <input
                type="radio"
                name="ai"
                className="mt-1"
                checked={ai === false}
                onChange={() => setAi(false)}
              />
              <span>
                <strong>Keep AI off.</strong> Nothing of yours is indexed, retrieved or sent to the
                AI provider, including when Blueprint staff use AI.
              </span>
            </label>
          </fieldset>
        )}
        <Button variant="cta" disabled={!accepted || ai === null || busy} onClick={save}>
          Continue
        </Button>
        {error && <Notice tone="error">{error}</Notice>}
      </Card>
    </main>
  );
}
