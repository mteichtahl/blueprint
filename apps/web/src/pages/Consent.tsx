import { useState } from 'react';
import { api, TERMS_VERSION } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { AuthFrame } from '../components/Shell.tsx';
import { Button, Notice, Tag } from '../components/ui.tsx';

/**
 * First sign-in, "Before you start" (screens doc; design F1 step 4): the
 * terms are required, and artists must actively choose AI on or off. Nothing
 * is pre-selected and Continue stays disabled until both are done. Both
 * choices are recorded in the consent ledger.
 */
export function Consent({
  cfg,
  token,
  isArtist,
  firstName,
  onDone,
}: {
  cfg: AppConfig;
  token: string;
  isArtist: boolean;
  firstName: string;
  onDone: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [ai, setAi] = useState<boolean | null>(isArtist ? null : true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = accepted && ai !== null;

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
    <AuthFrame
      eyebrow="First sign-in"
      title={`Before you start, ${firstName}`}
      sub={
        isArtist
          ? "Two quick things. You'll only see this once."
          : "One quick thing. You'll only see this once."
      }
    >
      <section className="card gap-2">
        <div className="flex items-center">
          <b className="flex-1 text-[17px]">1 · Terms &amp; conditions</b>
          <Tag tone="c">Required</Tag>
        </div>
        <ul className="m-0 flex flex-col gap-0.5 pl-[18px] text-sm leading-normal">
          <li>Your music, lyrics and artwork stay yours.</li>
          <li>Only you and the Blueprint team see your workspace.</li>
          <li>You can download or delete your data at any time. It is stored in Australia.</li>
        </ul>
        <label className="flex min-h-11 items-center gap-3 border-t border-[#E6E9ED] pt-1.5">
          <input
            className="chk"
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span className="flex-1 font-bold">
            I accept the Terms and Privacy Policy{' '}
            <span className="src">(version {TERMS_VERSION})</span>
          </span>
        </label>
      </section>

      {isArtist && (
        <section className="card gap-2">
          <div className="flex items-center">
            <b className="flex-1 text-[17px]">2 · AI assistance</b>
            <Tag tone="s">Your choice</Tag>
          </div>
          <p className="m-0 text-sm leading-normal">
            If you opt in, the Blueprint Assistant can answer questions and draft actions from your
            chats, files, to-dos, gigs and stats. Your news may also be included in the auto-drafted
            newsletter.
          </p>
          <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
            <legend className="sr-only">AI assistance</legend>
            {(
              [
                [true, 'Yes, opt in'],
                [false, 'No thanks'],
              ] as const
            ).map(([value, label]) => (
              <label
                key={label}
                className={`flex min-h-12 items-center gap-2 rounded-lg border px-2.5 ${ai === value ? 'border-primary' : 'border-input'}`}
              >
                <input
                  className="chk"
                  type="radio"
                  name="ai"
                  checked={ai === value}
                  onChange={() => setAi(value)}
                />
                <b>{label}</b>
              </label>
            ))}
          </fieldset>
          {ai === false && (
            <div
              role="status"
              className="rounded-lg bg-[#E6E9ED] px-3 py-2.5 text-sm leading-normal text-[#011935]"
            >
              The assistant won't appear for you, and <b>none of your account or data</b> will be
              used by any AI feature, including Blueprint's own. Everything else works the same.
            </div>
          )}
          {ai === true && (
            <div
              role="status"
              className="rounded-lg bg-[#FBE3E2] px-3 py-2.5 text-sm leading-normal text-[#8E2F2C]"
            >
              The assistant only uses your own data, and always asks before it sends or changes
              anything.
            </div>
          )}
          <span className="src">
            You can change this any time in Profile. If you opt out later, your data is removed from
            AI features within 24 hours.
          </span>
        </section>
      )}

      <Button
        variant={ready ? 'cta' : 'default'}
        className="min-h-[52px] w-full"
        disabled={!ready || busy}
        onClick={save}
      >
        Continue
      </Button>
      {!ready && (
        <p className="src m-0 text-center">
          {isArtist
            ? 'Accept the terms and choose an AI option to continue'
            : 'Accept the terms to continue'}
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </AuthFrame>
  );
}
