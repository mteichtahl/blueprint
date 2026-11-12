import { useState } from 'react';
import { AuthFrame } from '../components/Shell.tsx';
import { Button, Card, Field, Notice } from '../components/ui.tsx';
import { postPublic } from '../lib/publicApi.ts';

/**
 * The public newsletter sign-up page (/newsletter): no account needed. The
 * address goes to Blueprint's Mailchimp audience as "pending", so Mailchimp
 * emails a link to confirm it (double opt-in) before anything is sent.
 */
export function NewsletterSignup() {
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  // People never see this field; bots fill it in, and the server refuses them.
  const [website, setWebsite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <AuthFrame
      eyebrow="Newsletter"
      title="Join Our Mailing List"
      sub="News from Blueprint and our artists, industry events and opportunities, once a week."
    >
      <Card>
        {done ? (
          <div className="flex flex-col gap-2" role="status">
            <h2 className="t m-0 text-[22px]">Check your inbox</h2>
            <p className="m-0 text-[15px]">
              We’ve sent an email to <b>{email}</b>. Open the link in it to confirm your address,
              and you’re on the list.
            </p>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              postPublic('/public/newsletter', {
                email: email.trim(),
                ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
                consent,
                ...(website ? { website } : {}),
              })
                .then(() => setDone(true))
                .catch((err: Error) => setError(err.message))
                .finally(() => setBusy(false));
            }}
          >
            <Field
              label="First name (optional)"
              autoComplete="given-name"
              maxLength={60}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div className="absolute -left-[9999px]" aria-hidden="true">
              <label>
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </label>
            </div>
            <label className="flex items-start gap-2.5 text-[15px]">
              <input
                className="chk mt-0.5"
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                Yes, send me Blueprint’s newsletter. I can unsubscribe at any time from the link in
                every email.
              </span>
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <Button
              type="submit"
              variant="cta"
              className="min-h-[50px] w-full"
              disabled={busy || !email.trim() || !consent}
            >
              {busy ? 'Signing you up…' : 'Sign me up'}
            </Button>
            <span className="src">
              We only use your email for the newsletter. It’s kept in Mailchimp, which sends it.
            </span>
          </form>
        )}
      </Card>
    </AuthFrame>
  );
}
