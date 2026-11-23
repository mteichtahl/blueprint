import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AuthFrame } from '../components/Shell.tsx';
import { SearchSelect, type SearchOption } from '../components/SearchSelect.tsx';
import { Button, Card, control, Notice, WaveLoader } from '../components/ui.tsx';
import { loadCaptchaScript, renderCaptcha, sendEnquiry } from '../lib/captcha.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  browserCountry,
  checkPhone,
  COUNTRIES,
  countryByCode,
  PINNED,
  searchCountries,
  type Country,
} from '../lib/countries.ts';

export const ANSWER_MAX = 2000;

const toOption = (c: Country): SearchOption => ({
  id: c.code,
  label: c.name,
  ...(c.dial ? { hint: c.dial } : {}),
  lead: (
    <span className="tag tn min-w-[34px] justify-center !text-[12px]" aria-hidden="true">
      {c.code}
    </span>
  ),
});
const OPTIONS = COUNTRIES.map(toOption);
const PINNED_OPTIONS = PINNED.map(toOption);

export interface ConsultFields {
  name: string;
  email: string;
  country: string;
  phone: string;
  phoneCountry: string;
  aboutMe: string;
  howCanWeHelp: string;
}
export type ConsultErrors = Partial<Record<keyof ConsultFields, string>>;

/** The form's own checks, the same as the server's (services/api/src/enquiries/model.ts). */
export function checkConsult(f: ConsultFields): { errors: ConsultErrors; phone?: string } {
  const errors: ConsultErrors = {};
  const name = f.name.trim();
  if (name.length < 2) errors.name = 'Add your name.';
  else if (name.length > 100) errors.name = 'Keep your name under 100 characters.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim()) || f.email.trim().length > 254)
    errors.email = 'Add an email we can reply to.';
  if (!countryByCode(f.country)) errors.country = 'Choose your country.';
  const phone = checkPhone(f.phone, f.phoneCountry);
  if (phone.error) errors.phone = phone.error;
  if (!f.aboutMe.trim()) errors.aboutMe = 'Tell us a little about yourself.';
  else if (f.aboutMe.length > ANSWER_MAX) errors.aboutMe = 'Keep it under 2,000 characters.';
  if (!f.howCanWeHelp.trim()) errors.howCanWeHelp = 'Tell us how Blueprint can help.';
  else if (f.howCanWeHelp.length > ANSWER_MAX)
    errors.howCanWeHelp = 'Keep it under 2,000 characters.';
  return { errors, ...(phone.e164 ? { phone: phone.e164 } : {}) };
}

/** A label, its control, and its error (or hint) under it, tied together for screen readers. */
function Row({
  id,
  label,
  error,
  hint,
  counter,
  children,
}: {
  id: string;
  label: ReactNode;
  error?: string | undefined;
  hint?: string;
  counter?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[15px] font-bold">
        {label}
      </label>
      {children}
      <span className="flex items-start justify-between gap-3">
        {error ? (
          <span id={`${id}-error`} className="text-sm font-bold text-[#B5403C]">
            {error}
          </span>
        ) : (
          <span id={`${id}-hint`} className="src">
            {hint}
          </span>
        )}
        {counter && (
          <span className="src flex-none" aria-hidden="true">
            {counter}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The public consultation form (/consult, rev 21): no account needed. A
 * request goes to the Blueprint team, who are all told and one of whom picks
 * it up. An AWS WAF CAPTCHA keeps bots out; a hidden field and a minimum time
 * on the page catch the rest.
 */
export function Consult({ cfg }: { cfg: Partial<AppConfig> }) {
  const startedAt = useRef(Date.now());
  const [f, setF] = useState<ConsultFields>(() => {
    const c = browserCountry();
    return {
      name: '',
      email: '',
      country: c,
      phone: '',
      phoneCountry: c,
      aboutMe: '',
      howCanWeHelp: '',
    };
  });
  // The calling code follows the country until someone picks one themselves.
  const [phoneCountryPicked, setPhoneCountryPicked] = useState(false);
  // People never see this field; bots fill it in.
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<ConsultErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(
    /^\/consult\/thanks\/?$/.test(window.location.pathname) ? '' : null,
  );

  const captcha = cfg.captcha;
  const [captchaState, setCaptchaState] = useState<'loading' | 'ready' | 'solved' | 'error'>(
    'loading',
  );
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const showPuzzle = () => {
    if (!captcha || !box.current) return;
    setCaptchaState('ready');
    renderCaptcha(
      box.current,
      captcha.apiKey,
      () => {
        setCaptchaState('solved');
        setCaptchaError(null);
      },
      (msg) => {
        setCaptchaState('error');
        setCaptchaError(msg);
      },
    );
  };
  useEffect(() => {
    if (!captcha || done !== null) return;
    let gone = false;
    loadCaptchaScript(captcha.scriptUrl)
      .then(() => !gone && showPuzzle())
      .catch((e: Error) => {
        if (gone) return;
        setCaptchaState('error');
        setCaptchaError(e.message);
      });
    return () => {
      gone = true;
    };
    // showPuzzle only reads refs and the config.
  }, [captcha?.scriptUrl, captcha?.apiKey, done]);

  const set = <K extends keyof ConsultFields>(k: K, v: ConsultFields[K]) => {
    setF((was) => ({ ...was, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const dialOptions = useMemo(
    () =>
      COUNTRIES.filter((c) => c.dial).map((c) => ({
        value: c.code,
        label: `${c.name} ${c.dial}`,
      })),
    [],
  );
  const dial = countryByCode(f.phoneCountry)?.dial ?? '';

  const describedBy = (k: keyof ConsultFields) => (errors[k] ? `${k}-error` : `${k}-hint`);

  if (done !== null) {
    return (
      <AuthFrame
        eyebrow="Consultation"
        title={done ? `Thanks, ${done}` : 'Thanks'}
        sub="We’ve got your request."
        ribbon="REQUEST SENT ★ BLUEPRINT MUSIC GROUP"
      >
        <Card title="What happens next">
          <ol className="m-0 flex flex-col gap-2 pl-5 text-[16px] leading-snug" role="status">
            <li>Someone from the Blueprint team reads it and picks it up.</li>
            <li>They’ll get back to you by email within 2 business days.</li>
            <li>
              We’ve sent a short confirmation to your inbox. Can’t see it? Check your spam folder.
            </li>
          </ol>
          <div className="mt-4 flex flex-col gap-2">
            <a
              href="https://blueprintmusic.group"
              className="inline-flex min-h-[50px] items-center justify-center rounded-full border-2 border-[#011935] bg-pop px-5 font-title text-[15px] font-extrabold tracking-[.03em] text-pop-foreground uppercase shadow-[3px_3px_0_#011935]"
            >
              Back to blueprintmusic.group
            </a>
            <a href="https://www.instagram.com/blueprintmusic.group/" className="src text-center">
              Follow @blueprintmusic.group
            </a>
          </div>
        </Card>
      </AuthFrame>
    );
  }

  const submit = async () => {
    const { errors: found, phone } = checkConsult(f);
    setErrors(found);
    setProblem(null);
    const first = (Object.keys(found) as (keyof ConsultFields)[])[0];
    if (first) {
      // The country is a button; everything else focuses by its id.
      (first === 'country'
        ? document.querySelector<HTMLElement>('[aria-haspopup="listbox"]')
        : document.getElementById(first === 'phoneCountry' ? 'phone' : first)
      )?.focus();
      return;
    }
    if (captcha && captchaState !== 'solved') {
      setCaptchaError('Do the quick check first.');
      box.current?.focus();
      return;
    }
    setBusy(true);
    const res = await sendEnquiry({
      name: f.name.trim(),
      email: f.email.trim(),
      country: f.country,
      ...(phone ? { phone } : {}),
      aboutMe: f.aboutMe.trim(),
      howCanWeHelp: f.howCanWeHelp.trim(),
      ...(website ? { website } : {}),
      elapsedMs: Date.now() - startedAt.current,
    });
    setBusy(false);
    if (res.ok) {
      window.history.pushState({}, '', '/consult/thanks');
      setDone(res.firstName ?? f.name.trim().split(/\s+/)[0] ?? '');
      window.scrollTo?.(0, 0);
      return;
    }
    setProblem(res.message);
    if (res.captcha) {
      setCaptchaState('loading');
      showPuzzle();
    }
  };

  return (
    <AuthFrame
      eyebrow="Blueprint Music Group"
      title="Book a consultation"
      sub="Tell us where you’re at and we’ll be in touch within 2 business days."
      ribbon="BOOK A CONSULT ★ BLUEPRINT MUSIC GROUP"
    >
      <Card>
        <form
          noValidate
          className="flex flex-col gap-4"
          aria-label="Book a consultation"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Row id="name" label="Your name" error={errors.name}>
            <input
              id="name"
              className={control}
              autoComplete="name"
              maxLength={100}
              required
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy('name')}
              value={f.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Row>
          <Row id="email" label="Email" error={errors.email}>
            <input
              id="email"
              className={control}
              type="email"
              inputMode="email"
              autoComplete="email"
              maxLength={254}
              required
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={describedBy('email')}
              value={f.email}
              onChange={(e) => set('email', e.target.value)}
            />
          </Row>
          <SearchSelect
            label="Country"
            value={f.country}
            options={OPTIONS}
            pinned={PINNED_OPTIONS}
            placeholder="Choose your country"
            searchLabel="Search countries"
            search={(q) => searchCountries(q).map(toOption)}
            emptyText={(q) => `No country matches “${q}”.`}
            error={errors.country ?? null}
            required
            onChange={(code) => {
              set('country', code);
              if (!phoneCountryPicked && countryByCode(code)?.dial) set('phoneCountry', code);
            }}
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="phone" className="text-[15px] font-bold">
              Mobile / cell <span className="font-semibold text-muted-foreground">(optional)</span>
            </label>
            <div className="flex gap-2">
              <select
                aria-label={`Calling code, ${countryByCode(f.phoneCountry)?.name ?? ''} ${dial}`}
                className={`${control} !w-[104px] flex-none appearance-none text-center`}
                value={f.phoneCountry}
                onChange={(e) => {
                  setPhoneCountryPicked(true);
                  set('phoneCountry', e.target.value);
                }}
              >
                {dialOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.value === f.phoneCountry ? dial : o.label}
                  </option>
                ))}
              </select>
              <input
                id="phone"
                className={control}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                maxLength={20}
                aria-invalid={errors.phone ? true : undefined}
                aria-describedby={describedBy('phone')}
                value={f.phone}
                onChange={(e) => set('phone', e.target.value)}
              />
            </div>
            {errors.phone ? (
              <span id="phone-error" className="text-sm font-bold text-[#B5403C]">
                {errors.phone}
              </span>
            ) : (
              <span id="phone-hint" className="src">
                Only if you’d like a call or a text.
              </span>
            )}
          </div>
          <Row
            id="aboutMe"
            label="Tell us about yourself"
            error={errors.aboutMe}
            hint="Your music, where you’re at, links to your work."
            counter={`${f.aboutMe.length.toLocaleString('en-AU')} / 2,000`}
          >
            <textarea
              id="aboutMe"
              className={`${control} min-h-32 py-2.5`}
              maxLength={ANSWER_MAX}
              required
              aria-invalid={errors.aboutMe ? true : undefined}
              aria-describedby={describedBy('aboutMe')}
              value={f.aboutMe}
              onChange={(e) => set('aboutMe', e.target.value)}
            />
          </Row>
          <Row
            id="howCanWeHelp"
            label="How can BMG help?"
            error={errors.howCanWeHelp}
            hint="What you’d like a hand with: a release, gigs, your plan, the business side."
            counter={`${f.howCanWeHelp.length.toLocaleString('en-AU')} / 2,000`}
          >
            <textarea
              id="howCanWeHelp"
              className={`${control} min-h-32 py-2.5`}
              maxLength={ANSWER_MAX}
              required
              aria-invalid={errors.howCanWeHelp ? true : undefined}
              aria-describedby={describedBy('howCanWeHelp')}
              value={f.howCanWeHelp}
              onChange={(e) => set('howCanWeHelp', e.target.value)}
            />
          </Row>
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

          {captcha ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[15px] font-bold">Quick check that you’re a person</span>
              <div className="min-h-16 rounded-[14px] border-2 border-dashed border-input p-2">
                {captchaState === 'loading' && <WaveLoader size={40} label="Loading the check" />}
                {/* The CAPTCHA script draws the puzzle in here; React leaves it alone. */}
                <div ref={box} tabIndex={-1} className="outline-none" />
              </div>
              {captchaState === 'solved' && (
                <span className="text-sm font-bold text-[#1F6F4A]" role="status">
                  Thanks, that’s done.
                </span>
              )}
              {captchaError && (
                <span className="text-sm font-bold text-[#B5403C]" role="alert">
                  {captchaError}
                </span>
              )}
            </div>
          ) : (
            <Notice>The form isn’t taking requests just yet. Please try again soon.</Notice>
          )}

          {problem && <Notice tone="error">{problem}</Notice>}
          <Button
            type="submit"
            variant="cta"
            className="min-h-[50px] w-full"
            disabled={busy || !captcha}
          >
            {busy ? 'Sending…' : 'Send request'}
          </Button>
          <p className="src m-0">
            Blueprint Music Group collects these details to reply to your request. Only the
            Blueprint team sees them. We keep them for up to 2 years, then delete them. Blueprint’s
            Privacy Policy says more.
          </p>
        </form>
      </Card>
      <p className="src text-center">
        Already with Blueprint?{' '}
        <a href="/" className="font-bold underline">
          Sign in
        </a>
      </p>
    </AuthFrame>
  );
}
