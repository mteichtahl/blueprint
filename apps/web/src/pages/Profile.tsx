import { useCallback, useEffect, useState } from 'react';
import {
  api,
  MAX_OPEN_LIMIT,
  needsFreshSignIn,
  type ArtistSummary,
  type ArtistTodosSettings,
  type Me,
} from '../lib/api.ts';
import {
  setPhone as setPhoneNumber,
  setSmsMfa,
  smsStatus,
  toE164,
  verifyPhone,
} from '../lib/cognito.ts';
import type { AppConfig } from '../lib/config.ts';
import type { Preferences } from '../lib/notifications.ts';
import { disablePush, enablePush, pushSupported } from '../lib/push.ts';
import type { Theme } from '../components/Shell.tsx';
import { ProfilePicture } from '../components/ProfilePicture.tsx';
import { Button, Card, Field, Notice, WaveLoader } from '../components/ui.tsx';

/**
 * Profile & preferences (screens doc): notifications (in app, push, email),
 * quiet hours, appearance and sign-out, plus the profile picture. Contact details, socials and
 * security arrive with the next profile release.
 */
export function Profile({
  cfg,
  token,
  me,
  userName,
  theme,
  onTheme,
  onSignOut,
  onReauth,
  onJobTitle,
  onAvatar,
  compact = false,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  userName: string;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onSignOut: () => void;
  /** A fresh sign-in, for making recovery codes. */
  onReauth?: () => void;
  onJobTitle?: (t: string) => void;
  onAvatar?: (avatar: string | null) => void;
  compact?: boolean;
}) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    api<Preferences>(cfg, token, 'GET', '/preferences')
      .then(setPrefs)
      .catch((e) => setMsg({ tone: 'error', text: (e as Error).message }));
  }, [cfg, token]);

  async function save(next: Preferences) {
    setPrefs(next);
    try {
      await api(cfg, token, 'PUT', '/preferences', next);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    }
  }

  const row = 'flex min-h-12 items-center gap-3 border-b border-[#EDF0F3] py-2 last:border-0';
  return (
    <div className={`flex flex-wrap items-start gap-5 ${compact ? 'flex-col' : ''}`}>
      <AboutYou
        cfg={cfg}
        token={token}
        me={me}
        userName={userName}
        onJobTitle={onJobTitle}
        onAvatar={onAvatar}
      />
      <Card className="flex-[1_1_320px] self-stretch" title="Notifications">
        {!prefs ? (
          <WaveLoader />
        ) : (
          <div className="flex flex-col">
            <label className={row}>
              <span className="flex-1">
                <b className="block">In the app</b>
                <span className="src">The bell, always on</span>
              </span>
              <input className="switch" type="checkbox" checked disabled />
            </label>
            <label className={row}>
              <span className="flex-1">
                <b className="block">Email</b>
                <span className="src">Feedback, priority changes, new messages and uploads</span>
              </span>
              <input
                className="switch"
                type="checkbox"
                checked={prefs.email}
                onChange={(e) => void save({ ...prefs, email: e.target.checked })}
              />
            </label>
            <label className={row}>
              <span className="flex-1">
                <b className="block">Push on this device</b>
                <span className="src">
                  {pushSupported()
                    ? 'Alerts even when the app is closed'
                    : 'On iPhone, add Blueprint to your Home Screen first (Share → Add to Home Screen)'}
                </span>
              </span>
              <input
                className="switch"
                type="checkbox"
                checked={prefs.push}
                disabled={!pushSupported()}
                onChange={(e) => {
                  const on = e.target.checked;
                  void (on ? enablePush(cfg, token) : disablePush(cfg, token))
                    .then(() => save({ ...prefs, push: on }))
                    .catch((err) => setMsg({ tone: 'error', text: (err as Error).message }));
                }}
              />
            </label>
            <div className={row}>
              <span className="flex-1">
                <b className="block">Quiet hours</b>
                <span className="src">No email in this window (Melbourne time)</span>
              </span>
              <input
                className="switch"
                type="checkbox"
                aria-label="Quiet hours"
                checked={!!prefs.quietHours}
                onChange={(e) =>
                  void save({
                    ...prefs,
                    quietHours: e.target.checked ? { start: '22:00', end: '07:00' } : null,
                  })
                }
              />
            </div>
            {prefs.quietHours && (
              <div className="flex items-center gap-2 pt-2 text-[15px]">
                <label className="flex items-center gap-2">
                  From
                  <input
                    type="time"
                    className="h-9 rounded-lg border border-input bg-white px-2"
                    value={prefs.quietHours.start}
                    onChange={(e) =>
                      e.target.value &&
                      void save({
                        ...prefs,
                        quietHours: { ...prefs.quietHours!, start: e.target.value },
                      })
                    }
                  />
                </label>
                <label className="flex items-center gap-2">
                  to
                  <input
                    type="time"
                    className="h-9 rounded-lg border border-input bg-white px-2"
                    value={prefs.quietHours.end}
                    onChange={(e) =>
                      e.target.value &&
                      void save({
                        ...prefs,
                        quietHours: { ...prefs.quietHours!, end: e.target.value },
                      })
                    }
                  />
                </label>
              </div>
            )}
          </div>
        )}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </Card>
      {me.role !== 'artist' && me.artistTodos && (
        <ArtistTodosCard cfg={cfg} token={token} initial={me.artistTodos} />
      )}
      <Security cfg={cfg} token={token} {...(onReauth ? { onReauth } : {})} />
      <Card className="flex-[1_1_280px] self-stretch" title="Account">
        <div className="flex flex-col gap-1 text-[15px]">
          <b>{userName}</b>
          <span className="src">
            {me.role === 'artist' ? 'Artist' : me.role === 'bmg-admin' ? 'BMG admin' : 'BMG staff'}{' '}
            · two-step verification on · AI {me.consent?.aiOptIn ? 'on' : 'off'}
          </span>
        </div>
        <div>
          <span className="mb-1.5 block text-[15px] font-bold">Appearance</span>
          <div
            role="group"
            aria-label="Appearance"
            className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1"
          >
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={theme === t}
                onClick={() => onTheme(t)}
                className={`min-h-[34px] rounded-md text-sm font-bold capitalize ${theme === t ? 'bg-card shadow-xs' : 'text-muted-foreground'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <Button variant="ghost" onClick={onSignOut}>
          Sign out
        </Button>
      </Card>
    </div>
  );
}

/**
 * Security: recovery codes (for when the authenticator is lost) and, where
 * they're on, text-message codes as a second way to get a code.
 */
function Security({
  cfg,
  token,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  onReauth?: () => void;
}) {
  const [info, setInfo] = useState<{ left: number; createdAt: string | null } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    api<{ left: number; createdAt: string | null }>(cfg, token, 'GET', '/access/recovery-codes')
      .then(setInfo)
      .catch(() => setInfo({ left: 0, createdAt: null }));
  }, [cfg, token]);

  async function make() {
    setMsg(null);
    setFresh(false);
    try {
      const r = await api<{ codes: string[]; createdAt: string }>(
        cfg,
        token,
        'POST',
        '/access/recovery-codes',
        {},
      );
      setCodes(r.codes);
      setInfo({ left: r.codes.length, createdAt: r.createdAt });
    } catch (e) {
      if (needsFreshSignIn(e)) setFresh(true);
      else setMsg({ tone: 'error', text: (e as Error).message });
    }
  }

  return (
    <Card className="flex-[1_1_320px] self-stretch" title="Security">
      <div className="flex flex-col gap-2">
        <b className="text-[15px]">Recovery codes</b>
        <span className="src">
          {info === null
            ? '…'
            : info.createdAt
              ? `${info.left} of 10 left · made ${new Date(info.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`
              : 'None yet. Make some now, in case you lose your phone.'}
        </span>
        {codes ? (
          <div className="flex flex-col gap-2 rounded-lg border-2 border-[#D9534F] p-3">
            <span className="text-[15px] font-bold">
              Save these now. They won’t be shown again.
            </span>
            <ul
              className="m-0 grid list-none grid-cols-2 gap-1 p-0 font-mono text-[15px]"
              aria-label="Your recovery codes"
            >
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <span className="src">
              Each code works once, with your email, if you can’t use your authenticator. Your
              password is still needed.
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(codes.join('\n'))
                    .then(() => setMsg({ tone: 'success', text: 'Copied.' }))
                    .catch(() => setMsg({ tone: 'error', text: 'Couldn’t copy. Write them down.' }))
                }
              >
                Copy codes
              </Button>
              <Button size="sm" variant="navy" onClick={() => setCodes(null)}>
                I’ve saved them
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="self-start" onClick={() => void make()}>
            {info?.createdAt ? 'Make new codes' : 'Make recovery codes'}
          </Button>
        )}
        {info?.createdAt && !codes && (
          <span className="src">Making new codes stops the old ones working.</span>
        )}
        {fresh && (
          <Notice tone="error">
            This needs a recent sign-in.{' '}
            {onReauth && (
              <button type="button" className="font-bold underline" onClick={onReauth}>
                Sign in again
              </button>
            )}
          </Notice>
        )}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
      {cfg.smsMfa && <TextCodes cfg={cfg} token={token} />}
    </Card>
  );
}

/** Text-message codes: add a number, confirm it with a texted code, then turn them on. */
function TextCodes({ cfg, token }: { cfg: AppConfig; token: string }) {
  const [state, setState] = useState<{
    phone: string | null;
    verified: boolean;
    on: boolean;
  } | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const load = useCallback(
    () =>
      smsStatus(cfg, token)
        .then((st) => {
          setState(st);
          setPhone(st.phone ?? '');
        })
        .catch(() => setState({ phone: null, verified: false, on: false })),
    [cfg, token],
  );
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: done });
      await load();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const e164 = toE164(phone);
  return (
    <div className="flex flex-col gap-2 border-t border-input pt-3">
      <b className="text-[15px]">Text-message codes</b>
      <span className="src">A second way to get your code if your authenticator isn’t handy.</span>
      {state === null ? null : state.verified && state.phone === e164 && !sent ? (
        <label className="flex min-h-11 items-center gap-3">
          <span className="flex-1">
            Text codes to <b>{state.phone}</b>
          </span>
          <input
            className="switch"
            type="checkbox"
            checked={state.on}
            disabled={busy}
            onChange={(ev) =>
              void act(
                () => setSmsMfa(cfg, token, ev.target.checked),
                ev.target.checked ? 'Text codes are on.' : 'Text codes are off.',
              )
            }
          />
        </label>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Field
              label="Mobile number"
              type="tel"
              autoComplete="tel"
              placeholder="0412 345 678"
              value={phone}
              onChange={(ev) => setPhone(ev.target.value)}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !e164}
              onClick={() =>
                void act(async () => {
                  await setPhoneNumber(cfg, token, e164!);
                  setSent(true);
                }, 'We’ve texted you a code.')
              }
            >
              Text me a code
            </Button>
          </div>
          {phone && !e164 && (
            <span className="src">Use an Australian mobile (04…) or a number starting with +.</span>
          )}
          {sent && (
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Code from the text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ''))}
              />
              <Button
                size="sm"
                variant="navy"
                disabled={busy || code.length !== 6}
                onClick={() =>
                  void act(async () => {
                    await verifyPhone(cfg, token, code);
                    await setSmsMfa(cfg, token, true);
                    setSent(false);
                    setCode('');
                  }, 'Number confirmed. Text codes are on.')
                }
              >
                Confirm
              </Button>
            </div>
          )}
        </>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

/** Name and job title. Artists are always "Artist"; Blueprint people set their own. */
function AboutYou({
  cfg,
  token,
  me,
  userName,
  onJobTitle,
  onAvatar,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  userName: string;
  onJobTitle?: ((t: string) => void) | undefined;
  onAvatar?: ((avatar: string | null) => void) | undefined;
}) {
  const [avatar, setAvatar] = useState(me.avatar ?? null);
  const isArtist = me.role === 'artist';
  const [title, setTitle] = useState(me.jobTitle ?? '');
  const [saved, setSaved] = useState(me.jobTitle ?? '');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  async function save() {
    try {
      const res = await api<{ jobTitle: string }>(cfg, token, 'PATCH', '/me', {
        jobTitle: title,
      });
      setSaved(res.jobTitle);
      setTitle(res.jobTitle);
      onJobTitle?.(res.jobTitle);
      setMsg({ tone: 'success', text: 'Job title saved.' });
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    }
  }
  return (
    <Card className="flex-[1_1_100%]" title="About you">
      <ProfilePicture
        cfg={cfg}
        token={token}
        userName={userName}
        artistId={me.artistId}
        avatar={avatar}
        onChange={(a) => {
          setAvatar(a);
          onAvatar?.(a);
        }}
      />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className="m-0">
        <b>{userName}</b>
      </p>
      {isArtist ? (
        <p className="m-0">
          Job title: <b>Artist</b>
          <span className="src block">Every artist's job title is Artist.</span>
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-[1_1_260px]">
            <Field
              label="Job title"
              value={title}
              maxLength={80}
              placeholder="e.g. Founder & Director"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <Button variant="navy" disabled={title.trim() === saved} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

const clampMax = (n: number) => Math.min(MAX_OPEN_LIMIT, Math.max(1, Math.round(n) || 1));

/**
 * Rev 15, Blueprint only: To-dos from artists. Artists can send the person who
 * owns their plan a to-do; this turns that on or off and caps how many each
 * artist can have open at once (with a different cap for some artists, e.g.
 * during a release week). It only limits: there's no minimum.
 */
export function ArtistTodosCard({
  cfg,
  token,
  initial,
  save: saveTo,
  title = 'To-dos from artists',
}: {
  cfg: AppConfig;
  token: string;
  initial: ArtistTodosSettings;
  /** Where to save (default: your own profile). Admins use it from Access & permissions. */
  save?: (next: ArtistTodosSettings) => Promise<void>;
  title?: string;
}) {
  const [s, setS] = useState(initial);
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [adding, setAdding] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    api<{ artists: ArtistSummary[] }>(cfg, token, 'GET', '/artists')
      .then((r) => setArtists(r.artists))
      .catch(() => setArtists([]));
  }, [cfg, token]);
  const name = (id: string) => artists.find((a) => a.artistId === id)?.displayName ?? 'Artist';

  async function save(next: ArtistTodosSettings) {
    setS(next);
    try {
      if (saveTo) await saveTo(next);
      else await api(cfg, token, 'PATCH', '/me', { artistTodos: next });
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    }
  }
  const setOne = (id: string, n: number | null) => {
    const perArtist = { ...s.perArtist };
    if (n === null) delete perArtist[id];
    else perArtist[id] = clampMax(n);
    void save({ ...s, perArtist });
  };
  const row = 'flex min-h-12 items-center gap-3 border-b border-[#EDF0F3] py-2 last:border-0';
  const others = artists.filter((a) => !(a.artistId in s.perArtist));

  return (
    <Card className="flex-[1_1_320px] self-stretch" title={title}>
      <div className="flex flex-col">
        <label className={row}>
          <span className="flex-1">
            <b className="block">Allow artists to send me to-dos</b>
            <span className="src">From the artists whose plans you own</span>
          </span>
          <input
            className="switch"
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => void save({ ...s, enabled: e.target.checked })}
          />
        </label>
        {s.enabled && (
          <>
            <label className={row}>
              <span className="flex-1">
                <b className="block">Maximum open to-dos per artist</b>
                <span className="src">
                  Artists can have up to {s.maxOpenPerArtist} open to-do
                  {s.maxOpenPerArtist === 1 ? '' : 's'} for you at a time.
                </span>
              </span>
              <input
                type="number"
                min={1}
                max={MAX_OPEN_LIMIT}
                className="h-9 w-20 rounded-lg border border-input bg-white px-2"
                value={s.maxOpenPerArtist}
                onChange={(e) => setS({ ...s, maxOpenPerArtist: clampMax(Number(e.target.value)) })}
                onBlur={() => void save(s)}
              />
            </label>
            <div className="flex flex-col gap-2 pt-2">
              <b className="text-[15px]">A different maximum for some artists</b>
              <span className="src">For example during a release week.</span>
              {Object.entries(s.perArtist).map(([id, n]) => (
                <div key={id} className="flex items-center gap-2 text-[15px]">
                  <span className="flex-1">{name(id)}</span>
                  <input
                    type="number"
                    aria-label={`Maximum for ${name(id)}`}
                    min={1}
                    max={MAX_OPEN_LIMIT}
                    className="h-9 w-20 rounded-lg border border-input bg-white px-2"
                    defaultValue={n}
                    onBlur={(e) => setOne(id, Number(e.target.value))}
                  />
                  <Button size="sm" variant="ghost" onClick={() => setOne(id, null)}>
                    Remove
                  </Button>
                </div>
              ))}
              {others.length > 0 && (
                <div className="flex items-center gap-2">
                  <label className="flex-1">
                    <span className="sr-only">Artist</span>
                    <select
                      className="dd w-full"
                      value={adding}
                      onChange={(e) => setAdding(e.target.value)}
                    >
                      <option value="">Choose an artist</option>
                      {others.map((a) => (
                        <option key={a.artistId} value={a.artistId}>
                          {a.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="navy"
                    disabled={!adding}
                    onClick={() => {
                      setOne(adding, s.maxOpenPerArtist);
                      setAdding('');
                    }}
                  >
                    Add
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </Card>
  );
}
