import { useEffect, useState } from 'react';
import { api, type Me } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import type { Preferences } from '../lib/notifications.ts';
import { disablePush, enablePush, pushSupported } from '../lib/push.ts';
import type { Theme } from '../components/Shell.tsx';
import { Button, Card, Field, Notice } from '../components/ui.tsx';

/**
 * Profile & preferences (screens doc): notifications (in app, push, email),
 * quiet hours, appearance and sign-out. Contact details, socials and
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
  onJobTitle,
  compact = false,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  userName: string;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onSignOut: () => void;
  onJobTitle?: (t: string) => void;
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
      <AboutYou cfg={cfg} token={token} me={me} userName={userName} onJobTitle={onJobTitle} />
      <Card className="flex-[1_1_320px] self-stretch" title="Notifications">
        {!prefs ? (
          <p className="src">Loading…</p>
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

/** Name and job title. Artists are always "Artist"; Blueprint people set their own. */
function AboutYou({
  cfg,
  token,
  me,
  userName,
  onJobTitle,
}: {
  cfg: AppConfig;
  token: string;
  me: Me;
  userName: string;
  onJobTitle?: ((t: string) => void) | undefined;
}) {
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
