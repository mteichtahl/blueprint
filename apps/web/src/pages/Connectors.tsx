import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  ago,
  finishPendingCallback,
  type ArtistRow,
  type CellState,
  type ConnectorApp,
  type ConnectorCard,
} from '../lib/connectors.ts';
import { Button, Card, DataTable, Field, Notice, Select, Tag } from '../components/ui.tsx';

/** Screens: X-Connectors (Blueprint) and P-Connectors (artist "My connectors"). */

type Msg = { tone: 'success' | 'error' | 'info'; text: string; reauth?: boolean } | null;
const today = () => new Date().toISOString().slice(0, 10);

function useCards(cfg: AppConfig, token: string, path: string) {
  const [cards, setCards] = useState<ConnectorCard[] | null>(null);
  const [artists, setArtists] = useState<ArtistRow[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ connectors: ConnectorCard[]; artists?: ArtistRow[] }>(
        cfg,
        token,
        'GET',
        path,
      );
      setCards(r.connectors);
      setArtists(r.artists ?? []);
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    }
  }, [cfg, token, path]);

  useEffect(() => {
    void (async () => {
      // Back from a vendor's sign-in page: finish connecting first.
      const done = await finishPendingCallback(cfg, token);
      if (done) setMsg({ tone: done.ok ? 'success' : 'error', text: done.message });
      await load();
    })();
  }, [cfg, token, load]);

  /** Runs an action, shows its outcome, reloads. Admin changes may need a fresh sign-in. */
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: 'success', text: ok });
    } catch (e) {
      const text = (e as Error).message;
      setMsg({ tone: 'error', text, reauth: /fresh step-up/.test(text) });
    }
    await load();
  };
  return { cards, artists, msg, setMsg, act };
}

async function startConnect(cfg: AppConfig, token: string, base: string, id: string) {
  const r = await api<{ url?: string }>(cfg, token, 'POST', `${base}/${id}/connect`);
  if (r.url) window.location.assign(r.url);
}

function statusTag(c: ConnectorCard) {
  const s = c.connection?.status;
  if (s === 'connected') return <Tag tone="n">Connected</Tag>;
  if (s === 'needs-reauth') return <Tag tone="k">Sign in again</Tag>;
  if (s === 'error') return <Tag tone="c">Sync problem</Tag>;
  if (!c.available) return <Tag tone="s">Set-up needed</Tag>;
  return <Tag tone="s">Not connected</Tag>;
}

function ApiKeyForm({ onSave, label }: { onSave: (key: string) => Promise<void>; label: string }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onSave(key.trim());
    setBusy(false);
    setKey('');
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => void submit(e)}>
      <Field
        label={label}
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        hint="Humanitix → Account → Advanced → API key. Give it Events, Orders and Tickets read access. It's stored encrypted and never shown again."
        required
        minLength={10}
      />
      <Button type="submit" variant="cta" size="sm" disabled={busy || key.trim().length < 10}>
        Connect
      </Button>
    </form>
  );
}

const SETTING_FOR: Record<string, { field: string; label: string }> = {
  website: { field: 'ga4PropertyId', label: 'Google Analytics property' },
  mailchimp: { field: 'listId', label: 'Audience' },
  meta: { field: 'pageId', label: 'Facebook Page' },
  linkedin: { field: 'organizationId', label: 'Company page' },
};

function ManagePanel({
  card,
  base,
  cfg,
  token,
  act,
  canAdmin,
}: {
  card: ConnectorCard;
  base: string;
  cfg: AppConfig;
  token: string;
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  canAdmin: boolean;
}) {
  const c = card.connection!;
  const setting = SETTING_FOR[card.id];
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t border-input pt-2">
      {c.lastError && <span className="src text-[#8E2F2C]">{c.lastError}</span>}
      {c.expiresAt && (
        <span className="src">
          Access ends {new Date(c.expiresAt).toLocaleDateString('en-AU')}: sign in again before
          then.
        </span>
      )}
      {setting && (c.choices?.length ?? 0) > 1 && canAdmin && (
        <Select
          label={setting.label}
          value={c.settings?.[setting.field] ?? ''}
          options={c.choices!.map((ch) => ({ value: ch.id, label: ch.label }))}
          onChange={(e) =>
            void act(
              () =>
                api(cfg, token, 'PATCH', `${base}/${card.id}`, { [setting.field]: e.target.value }),
              'Saved',
            )
          }
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void act(() => api(cfg, token, 'POST', `${base}/${card.id}/sync`), 'Synced')
          }
        >
          Sync now
        </Button>
        {canAdmin && card.auth === 'oauth' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act(() => startConnect(cfg, token, base, card.id))}
          >
            Sign in again
          </Button>
        )}
        {canAdmin &&
          (confirm ? (
            <Button
              size="sm"
              variant="cta"
              onClick={() =>
                void act(
                  () => api(cfg, token, 'DELETE', `${base}/${card.id}`),
                  `${card.label} disconnected. Its history stays in the app.`,
                )
              }
            >
              Confirm disconnect
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          ))}
      </div>
    </div>
  );
}

/** Numbers typed in from Spotify for Artists, or from TikTok/LinkedIn until their APIs are approved. */
function ManualEntry({
  cfg,
  token,
  path,
  sources,
  onSaved,
}: {
  cfg: AppConfig;
  token: string;
  path: string;
  sources: { value: string; label: string }[];
  onSaved: (text: string) => void;
}) {
  const [source, setSource] = useState(sources[0]!.value);
  const [date, setDate] = useState(today());
  const [followers, setFollowers] = useState('');
  const [listeners, setListeners] = useState('');
  const [error, setError] = useState<string | null>(null);
  const spotify = source === 'spotify';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const n = (v: string) => (v.trim() === '' ? undefined : Number(v));
    try {
      await api(cfg, token, 'POST', path, {
        source,
        date,
        ...(n(followers) !== undefined ? { followers: n(followers) } : {}),
        ...(spotify && n(listeners) !== undefined ? { listeners: n(listeners) } : {}),
      });
      setFollowers('');
      setListeners('');
      onSaved('Numbers saved');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        {sources.length > 1 && (
          <Select
            label="Account"
            value={source}
            options={sources}
            onChange={(e) => setSource(e.target.value)}
          />
        )}
        <Field
          label="Date"
          type="date"
          value={date}
          max={today()}
          onChange={(e) => setDate(e.target.value)}
          required
        />
        {spotify && (
          <Field
            label="Monthly listeners"
            type="number"
            min={0}
            inputMode="numeric"
            value={listeners}
            onChange={(e) => setListeners(e.target.value)}
          />
        )}
        <Field
          label="Followers"
          type="number"
          min={0}
          inputMode="numeric"
          value={followers}
          onChange={(e) => setFollowers(e.target.value)}
        />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <Button type="submit" size="sm" variant="navy" disabled={!followers && !listeners}>
          Save numbers
        </Button>
      </div>
    </form>
  );
}

// ── Blueprint: Connected apps ─────────────────────────────────────────────
const CELL: Record<CellState, [tone: 'n' | 's' | 'k' | 'c', label: string]> = {
  on: ['n', 'On'],
  off: ['s', 'Not connected'],
  'needs-reauth': ['k', 'Sign in again'],
  error: ['c', 'Sync problem'],
};

export function BmgConnectors({
  cfg,
  token,
  isAdmin,
  onReauth,
}: {
  cfg: AppConfig;
  token: string;
  isAdmin: boolean;
  onReauth: () => void;
}) {
  const { cards, artists, msg, setMsg, act } = useCards(cfg, token, '/connectors');
  const [open, setOpen] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  if (!cards)
    return msg ? <Notice tone="error">{msg.text}</Notice> : <p className="src">Loading…</p>;
  const meta = cards.find((c) => c.id === 'meta');
  const viaMeta = (src: 'instagram' | 'facebook') =>
    meta?.connection?.accounts?.some((a) => a.source === src) ?? false;

  return (
    <>
      {msg && (
        <div className="flex flex-wrap items-center gap-3">
          <Notice tone={msg.tone}>{msg.text}</Notice>
          {msg.reauth && (
            <Button size="sm" variant="ghost" onClick={onReauth}>
              Sign in again
            </Button>
          )}
        </div>
      )}
      <Card title={<span className="eyebrow">Blueprint's accounts</span>}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
          {cards.map((c) => (
            <div key={c.id} className="flex flex-col gap-1.5 rounded-lg border border-input p-3.5">
              <div className="flex items-center gap-3">
                <b className="flex-1 text-lg">{c.label}</b>
                {statusTag(c)}
              </div>
              <span className="src">{c.blurb}</span>
              {c.connection && (
                <span className="src">
                  {[c.connection.account, ago(c.connection.lastSyncAt)].filter(Boolean).join(' · ')}
                </span>
              )}
              {!c.connection && !c.available && (
                <span className="src">
                  {isAdmin
                    ? `Register the ${APP_NAMES[providerOf(c.id)] ?? 'vendor'} app below under Connector apps first.`
                    : 'An admin needs to register this app first.'}
                </span>
              )}
              {c.connection ? (
                <button
                  type="button"
                  className="self-start font-bold underline decoration-cta underline-offset-[3px]"
                  aria-expanded={open === c.id}
                  onClick={() => setOpen(open === c.id ? null : c.id)}
                >
                  Manage
                </button>
              ) : isAdmin && c.available && c.auth === 'oauth' ? (
                <Button
                  size="sm"
                  variant="cta"
                  className="self-start"
                  onClick={() => void act(() => startConnect(cfg, token, '/connectors', c.id))}
                >
                  Connect
                </Button>
              ) : isAdmin && c.auth === 'apiKey' ? (
                open === c.id ? (
                  <ApiKeyForm
                    label={`${c.label} API key`}
                    onSave={(apiKey) =>
                      act(
                        () => api(cfg, token, 'POST', `/connectors/${c.id}/connect`, { apiKey }),
                        `${c.label} is connected. Link the Mixer Night to its Humanitix event on the Events page.`,
                      )
                    }
                  />
                ) : (
                  <Button
                    size="sm"
                    variant="cta"
                    className="self-start"
                    onClick={() => setOpen(c.id)}
                  >
                    Connect
                  </Button>
                )
              ) : null}
              {c.connection && open === c.id && (
                <ManagePanel
                  card={c}
                  base="/connectors"
                  cfg={cfg}
                  token={token}
                  act={act}
                  canAdmin={isAdmin}
                />
              )}
            </div>
          ))}
          {(['instagram', 'facebook'] as const).map((src) => (
            <div key={src} className="flex flex-col gap-1.5 rounded-lg border border-input p-3.5">
              <div className="flex items-center gap-3">
                <b className="flex-1 text-lg">{src === 'instagram' ? 'Instagram' : 'Facebook'}</b>
                {viaMeta(src) ? <Tag tone="n">Connected</Tag> : <Tag tone="s">Not connected</Tag>}
              </div>
              <span className="src">
                {src === 'instagram'
                  ? 'Followers, reach, top posts'
                  : 'Page followers, event reach'}
              </span>
              <span className="src">
                {viaMeta(src)
                  ? `${meta?.connection?.account ?? ''} · via Meta`
                  : 'Connect Meta Business Suite to add it'}
              </span>
            </div>
          ))}
          <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-[#5C6775] p-3.5">
            <div className="flex items-center gap-3">
              <b className="flex-1 text-lg">Spotify</b>
              <Tag tone="c">Artists only</Tag>
            </div>
            <span className="src">
              Monthly listeners and followers per artist (Spotify for Artists)
            </span>
            <span className="src">
              Each artist adds their own numbers: Spotify's API no longer shares followers with apps
              like this one.
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-input pt-3">
          <button
            type="button"
            className="self-start font-bold underline decoration-cta underline-offset-[3px]"
            aria-expanded={manual}
            onClick={() => setManual(!manual)}
          >
            Enter numbers by hand
          </button>
          {manual && (
            <ManualEntry
              cfg={cfg}
              token={token}
              path="/stats"
              sources={[
                { value: 'tiktok', label: 'TikTok' },
                { value: 'linkedin', label: 'LinkedIn' },
                { value: 'instagram', label: 'Instagram' },
                { value: 'facebook', label: 'Facebook' },
              ]}
              onSaved={(text) => setMsg({ tone: 'success', text })}
            />
          )}
        </div>
      </Card>
      {isAdmin && <ConnectorApps cfg={cfg} token={token} onChanged={() => act(async () => {})} />}

      <Card
        title={<span className="eyebrow">Artists' own connectors</span>}
        action={
          <span className="src">
            Artists connect these in their app. Blueprint sees the stats, never their passwords or
            messages.
          </span>
        }
      >
        {artists.length === 0 ? (
          <p className="src">No artists yet.</p>
        ) : (
          <DataTable>
            <thead>
              <tr>
                <th scope="col">Artist</th>
                <th scope="col">Instagram</th>
                <th scope="col">Facebook</th>
                <th scope="col">TikTok</th>
                <th scope="col">Spotify</th>
                <th scope="col">Google Calendar</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {artists.map((a) => (
                <tr key={a.artistId}>
                  <td>
                    <b>{a.displayName}</b>
                  </td>
                  {(['instagram', 'facebook', 'tiktok', 'spotify', 'gcal'] as const).map((k) => (
                    <td key={k}>
                      <Tag tone={CELL[a.cells[k]][0]}>{CELL[a.cells[k]][1]}</Tag>
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="font-bold underline decoration-cta underline-offset-[3px]"
                      onClick={() =>
                        void act(
                          () => api(cfg, token, 'POST', `/artists/${a.artistId}/connectors/remind`),
                          `Reminder sent to ${a.displayName}`,
                        )
                      }
                    >
                      Send reminder
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </>
  );
}

const APP_NAMES: Record<string, string> = {
  google: 'Google',
  meta: 'Meta',
  mailchimp: 'Mailchimp',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
};

/**
 * Admins register the vendor OAuth apps here: where to create each one, the
 * redirect address to give it, and its id and secret. The secret is stored
 * encrypted and never shown again.
 */
function ConnectorApps({
  cfg,
  token,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  onChanged: () => Promise<void>;
}) {
  const [apps, setApps] = useState<ConnectorApp[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  useEffect(() => {
    void api<{ apps: ConnectorApp[] }>(cfg, token, 'GET', '/connectors/apps')
      .then((r) => setApps(r.apps))
      .catch((e: Error) => setMsg({ tone: 'error', text: e.message }));
  }, [cfg, token]);

  const run = async (fn: () => Promise<{ apps: ConnectorApp[] }>, ok: string) => {
    setMsg(null);
    try {
      setApps((await fn()).apps);
      setOpen(null);
      setMsg({ tone: 'success', text: ok });
      await onChanged();
    } catch (e) {
      const text = (e as Error).message;
      setMsg({ tone: 'error', text, reauth: /fresh step-up/.test(text) });
    }
  };

  return (
    <Card title={<span className="eyebrow">Connector apps</span>}>
      <p className="src mb-3">
        Each connector signs in through an app Blueprint registers with the vendor. Create the app
        on the vendor's site, give it the redirect address shown, then paste its id and secret here.
      </p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!apps ? (
        !msg && <p className="src">Loading…</p>
      ) : (
        <div className="flex flex-col divide-y divide-input">
          {apps.map((a) => (
            <div key={a.provider} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <b className="text-lg">{APP_NAMES[a.provider]}</b>
                {a.configured ? <Tag tone="n">Registered</Tag> : <Tag tone="s">Not set up</Tag>}
                <span className="src flex-1">{a.usedBy.join(', ')}</span>
                <Button
                  size="sm"
                  variant={a.configured ? 'default' : 'cta'}
                  aria-expanded={open === a.provider}
                  onClick={() => setOpen(open === a.provider ? null : a.provider)}
                >
                  {open === a.provider ? 'Close' : a.configured ? 'Change' : 'Set up'}
                </Button>
              </div>
              {a.configured && (
                <span className="src">
                  {a.idLabel} {a.clientIdHint}
                  {a.updatedAt ? ` · updated ${ago(a.updatedAt)}` : ''}
                </span>
              )}
              {open === a.provider && (
                <AppForm
                  app={a}
                  onSave={(creds) =>
                    run(
                      () =>
                        api<{ apps: ConnectorApp[] }>(
                          cfg,
                          token,
                          'PUT',
                          `/connectors/apps/${a.provider}`,
                          creds,
                        ),
                      `${APP_NAMES[a.provider]} is registered. You can connect ${a.usedBy.join(', ')} now.`,
                    )
                  }
                  onRemove={
                    a.configured
                      ? () =>
                          run(
                            () =>
                              api<{ apps: ConnectorApp[] }>(
                                cfg,
                                token,
                                'DELETE',
                                `/connectors/apps/${a.provider}`,
                              ),
                            `${APP_NAMES[a.provider]} app removed. Existing connections keep working until their sign-in expires.`,
                          )
                      : undefined
                  }
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AppForm({
  app,
  onSave,
  onRemove,
}: {
  app: ConnectorApp;
  onSave: (creds: { clientId: string; clientSecret: string }) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const ready = clientId.trim().length >= 4 && clientSecret.trim().length >= 8;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onSave({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
    setBusy(false);
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-input p-3.5"
      onSubmit={(e) => void submit(e)}
    >
      <div className="flex flex-col gap-1">
        <b>{app.name}</b>
        <ol className="src list-decimal pl-5">
          {app.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <a
          className="self-start font-bold underline decoration-cta underline-offset-[3px]"
          href={app.where}
          target="_blank"
          rel="noreferrer"
        >
          Open the {APP_NAMES[app.provider]} developer console
        </a>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Redirect address</span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-secondary px-2 py-1.5 text-sm">
            {app.redirectUri}
          </code>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              void navigator.clipboard?.writeText(app.redirectUri).then(() => setCopied(true))
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
      <Field
        label={app.idLabel}
        autoComplete="off"
        spellCheck={false}
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        placeholder={app.configured ? `Current: ${app.clientIdHint ?? ''}` : undefined}
        required
      />
      <Field
        label={app.secretLabel}
        type="password"
        autoComplete="new-password"
        value={clientSecret}
        onChange={(e) => setClientSecret(e.target.value)}
        hint="Stored encrypted and never shown again. To change it, paste both again."
        required
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="cta" size="sm" disabled={busy || !ready}>
          {app.configured ? 'Save new details' : 'Save'}
        </Button>
        {onRemove &&
          (confirm ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onRemove().finally(() => setBusy(false));
              }}
            >
              Click again to remove
            </Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          ))}
      </div>
    </form>
  );
}

const providerOf = (id: string) =>
  ({ website: 'google', google: 'google', youtube: 'google', gcal: 'google' })[id] ?? id;

// ── Artist: My connectors ───────────────────────────────────────────────
const ARTIST_ROWS = [
  { key: 'instagram', id: 'meta', label: 'Instagram', blurb: 'Followers, reach' },
  { key: 'tiktok', id: 'tiktok', label: 'TikTok', blurb: 'Followers, views' },
  { key: 'spotify', id: 'spotify', label: 'Spotify for Artists', blurb: 'Listeners, followers' },
  {
    key: 'gcal',
    id: 'gcal',
    label: 'Google Calendar',
    blurb: 'Gigs and sessions in your calendar',
  },
  { key: 'facebook', id: 'meta', label: 'Facebook', blurb: 'Page followers, event reach' },
  { key: 'youtube', id: 'youtube', label: 'YouTube', blurb: 'Subscribers, views' },
  {
    key: 'humanitix',
    id: 'humanitix',
    label: 'Humanitix',
    blurb: 'Tickets for gigs you run yourself',
  },
] as const;

export function MyConnectors({
  cfg,
  token,
  artistId,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
}) {
  const base = `/artists/${artistId}/connectors`;
  const { cards, msg, setMsg, act } = useCards(cfg, token, base);
  const [open, setOpen] = useState<string | null>(null);
  if (!cards)
    return msg ? <Notice tone="error">{msg.text}</Notice> : <p className="src">Loading…</p>;
  const byId = new Map(cards.map((c) => [c.id, c]));

  return (
    <>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="rounded-lg border border-input bg-card px-3 py-0.5">
        {ARTIST_ROWS.map((row, i) => {
          const card = byId.get(row.id);
          if (!card) return null;
          const conn = card.connection;
          const on =
            row.id === 'meta'
              ? !!conn?.accounts?.some((a) => a.source === row.key)
              : row.id === 'spotify'
                ? card.manualLatest !== undefined
                : conn?.status === 'connected';
          const sub =
            row.id === 'spotify' && card.manualLatest
              ? `${card.manualLatest.listeners.toLocaleString('en-AU')} monthly listeners`
              : conn?.account && row.id !== 'meta'
                ? `${conn.account} · ${row.blurb.toLowerCase()}`
                : row.blurb;
          const expanded = open === row.key;
          return (
            <div
              key={row.key}
              className={`li flex-col !items-stretch ${i === ARTIST_ROWS.length - 1 ? '!border-0' : ''}`}
            >
              <div className="flex min-h-[42px] items-center gap-3">
                <span className="flex-1">
                  <b className="block">{row.label}</b>
                  <span className="src">{sub}</span>
                </span>
                {conn?.status === 'needs-reauth' ? (
                  <Button
                    size="sm"
                    variant="cta"
                    onClick={() => void act(() => startConnect(cfg, token, base, card.id))}
                  >
                    Sign in again
                  </Button>
                ) : on ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : row.key)}
                  >
                    <Tag tone="n">On</Tag>
                  </button>
                ) : card.auth === 'oauth' && !card.available ? (
                  <Tag tone="s">Coming soon</Tag>
                ) : (
                  <Button
                    size="sm"
                    variant={row.key === 'facebook' || row.key === 'instagram' ? 'cta' : 'default'}
                    onClick={() =>
                      card.auth === 'oauth'
                        ? void act(() => startConnect(cfg, token, base, card.id))
                        : setOpen(expanded ? null : row.key)
                    }
                  >
                    {row.id === 'spotify' ? 'Add numbers' : 'Connect'}
                  </Button>
                )}
              </div>
              {expanded && row.id === 'spotify' && (
                <div className="pb-3">
                  <ManualEntry
                    cfg={cfg}
                    token={token}
                    path={`/artists/${artistId}/stats`}
                    sources={[{ value: 'spotify', label: 'Spotify' }]}
                    onSaved={(text) => {
                      setOpen(null);
                      void act(async () => undefined, text);
                    }}
                  />
                  <span className="src">
                    From Spotify for Artists → Audience. Update it every week or two.
                  </span>
                </div>
              )}
              {expanded && row.id === 'humanitix' && !conn && (
                <div className="pb-3">
                  <ApiKeyForm
                    label="Humanitix API key"
                    onSave={(apiKey) =>
                      act(
                        () => api(cfg, token, 'POST', `${base}/humanitix/connect`, { apiKey }),
                        'Humanitix is connected',
                      )
                    }
                  />
                  <span className="src">
                    Put your Humanitix event link in each gig's ticket link to count its sales.
                  </span>
                </div>
              )}
              {expanded && conn && (
                <div className="pb-3">
                  <ManagePanel
                    card={{ ...card, label: row.label }}
                    base={base}
                    cfg={cfg}
                    token={token}
                    act={act}
                    canAdmin
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <span className="src">Disconnect any time. Your stats history stays in the app.</span>
      {msg?.tone === 'success' && (
        <button type="button" className="src self-start underline" onClick={() => setMsg(null)}>
          Dismiss
        </button>
      )}
    </>
  );
}
