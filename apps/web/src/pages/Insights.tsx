import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  melbourneDay,
  SOURCE_LABEL,
  type AccountInsight,
  type HumanitixEventRow,
  type HumanitixStats,
  type InsightsData,
} from '../lib/connectors.ts';
import { useLive } from '../lib/live.ts';
import {
  Avatar,
  Button,
  Card,
  Chips,
  DataTable,
  Notice,
  Select,
  Tag,
  WaveLoader,
} from '../components/ui.tsx';
import { TicketAnalytics } from '../components/TicketAnalytics.tsx';

/** Screens: X-Insights (Blueprint), the workspace Stats tab and the artist's My stats. */

type Range = '30' | '60' | '90';
const RANGES = [
  { id: '30', label: '30 days' },
  { id: '60', label: '60 days' },
  { id: '90', label: '90 days' },
] as const;
/** Account colours from the canvas: Blueprint navy, then coral and slate. */
const COLOURS = ['#011935', '#D9534F', '#5C6775', '#8E2F2C', '#3E4A59'];
const n = (v: number) => v.toLocaleString('en-AU');
const signed = (v: number) => `${v >= 0 ? '▲' : '▼'} ${n(Math.abs(v))}`;

export function Sparkline({
  values,
  color,
  label,
}: {
  values: number[];
  color: string;
  label: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * 120).toFixed(1)},${(33 - ((v - min) / span) * 30).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      viewBox="0 0 120 36"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className="h-11 w-full"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const splitText = (a: AccountInsight) =>
  [
    ...a.split.map((s) => `${SOURCE_LABEL[s.source] ?? s.source} ${n(s.followers)}`),
    ...(a.spotifyListeners !== undefined ? [`Spotify ${n(a.spotifyListeners)} listeners`] : []),
  ].join(' · ') || 'No numbers yet';

function AccountCard({ a, color, range }: { a: AccountInsight; color: string; range: Range }) {
  return (
    <div className="flex flex-[1_1_260px] flex-col gap-2 rounded-lg border border-input p-4">
      <div className="flex items-center gap-3">
        <Avatar
          name={a.account === 'bmg' ? 'B M G' : a.name}
          artistId={a.account === 'bmg' ? null : a.account}
        />
        <b className="flex-1 text-lg">{a.name}</b>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="t text-[26px]">{n(a.total)}</span>
        <b className="text-sm">
          {signed(a.delta)} in {range} days
        </b>
      </div>
      <Sparkline values={a.series} color={color} label={`${a.name} followers over ${range} days`} />
      <div className="src">{splitText(a)}</div>
    </div>
  );
}

export function Insights({
  cfg,
  token,
  onManage,
}: {
  cfg: AppConfig;
  token: string;
  onManage: () => void;
}) {
  const [range, setRange] = useState<Range>('30');
  const [who, setWho] = useState('all');
  const [data, setData] = useState<InsightsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setData(await api<InsightsData>(cfg, token, 'GET', `/insights?range=${range}`));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [cfg, token, range]);

  if (!data) return error ? <Notice tone="error">{error}</Notice> : <WaveLoader />;
  const w = data.website;
  const maxDay = Math.max(1, ...w.daily.map((d) => d.visits));
  const bmg = data.accounts.find((a) => a.account === 'bmg');
  const shown = who === 'all' ? data.accounts : data.accounts.filter((a) => a.account === who);
  const colourOf = (acc: string) =>
    COLOURS[data.accounts.findIndex((a) => a.account === acc) % COLOURS.length]!;

  return (
    <>
      <Chips
        label="Accounts"
        value={who}
        onChange={setWho}
        options={[
          { id: 'all', label: 'All accounts' },
          ...data.accounts.map((a) => ({ id: a.account, label: a.name })),
        ]}
      />

      {(who === 'all' || who === 'bmg') && (
        <Card
          title={<span className="eyebrow">Website · Squarespace · blueprintmusic.group</span>}
          action={<span className="src">Last 7 days</span>}
        >
          {!data.sources.includes('website') && w.visits === 0 ? (
            <p className="src">
              Connect Squarespace (through Google Analytics) to see website visits.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-7">
                <div>
                  <div className="t text-[34px]">{n(w.visits)}</div>
                  <div className="src">
                    Visits
                    {w.deltaPct !== undefined
                      ? ` · ${w.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(w.deltaPct)}%`
                      : ''}
                  </div>
                </div>
                <div>
                  <div className="t text-[34px]">{n(w.users)}</div>
                  <div className="src">Unique visitors</div>
                </div>
                <div>
                  <div className="t text-[34px]">{n(w.pageViews)}</div>
                  <div className="src">Page views</div>
                </div>
                {data.subscribers !== null && (
                  <div>
                    <div className="t text-[34px]">{n(data.subscribers)}</div>
                    <div className="src">Mailing list subscribers</div>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-7">
                <figure className="m-0 flex flex-[2_1_320px] flex-col gap-2">
                  <div
                    role="img"
                    aria-label={`Daily visits: ${w.daily.map((d) => d.visits).join(', ')}`}
                    className="flex h-[140px] items-end gap-2.5 border-b border-input"
                  >
                    {w.daily.map((d, i) => (
                      <div
                        key={d.date}
                        className="flex-1 rounded-t-sm"
                        style={{
                          height: `${Math.max(2, (d.visits / maxDay) * 100)}%`,
                          background: d.visits === maxDay ? '#011935' : '#5C6775',
                          opacity: i === w.daily.length - 1 ? 0.85 : 1,
                        }}
                      />
                    ))}
                  </div>
                  <div className="src flex justify-between">
                    {w.daily.map((d) => (
                      <span key={d.date}>
                        {new Date(`${d.date}T00:00:00`).toLocaleDateString('en-AU', {
                          weekday: 'short',
                        })}
                      </span>
                    ))}
                  </div>
                  <figcaption className="src">Daily visits</figcaption>
                </figure>
                {w.topPages && w.topPages.length > 0 && (
                  <div className="flex-[1_1_260px]">
                    <DataTable fit>
                      <thead>
                        <tr>
                          <th scope="col">Top pages</th>
                          <th scope="col">Visits</th>
                        </tr>
                      </thead>
                      <tbody>
                        {w.topPages.map((p) => (
                          <tr key={p.page}>
                            <td>{p.page || '(untitled)'}</td>
                            <td>{n(p.visits)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </DataTable>
                  </div>
                )}
                {w.sources && w.sources.length > 0 && (
                  <div className="flex-[1_1_200px]">
                    <DataTable fit>
                      <thead>
                        <tr>
                          <th scope="col">Traffic from</th>
                          <th scope="col">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {w.sources.map((s) => (
                          <tr key={s.source}>
                            <td>{s.source}</td>
                            <td>{s.share}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </DataTable>
                  </div>
                )}
              </div>
            </>
          )}
        </Card>
      )}

      <Card
        title={<span className="eyebrow">Social · combined followers</span>}
        action={
          <Chips label="Sparkline range" value={range} onChange={setRange} options={RANGES} />
        }
      >
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="t text-[30px]">{n(shown.reduce((s, a) => s + a.total, 0))}</span>
          <span className="src">
            {who === 'all' ? 'Blueprint + artists' : shown[0]?.name}
            {who === 'all' && bmg
              ? ` · Blueprint's own: ${n(bmg.total)} of 1,500 goal by 2 Dec`
              : ''}
          </span>
        </div>
        {who === 'all' && data.combined > 0 && (
          <div
            role="img"
            aria-label={`Followers by account: ${data.accounts.map((a) => `${a.name} ${n(a.total)}`).join(', ')}`}
            className="flex h-3 gap-0.5"
          >
            {[...data.accounts]
              .sort((a, b) => b.total - a.total)
              .filter((a) => a.total > 0)
              .map((a) => (
                <div key={a.account} style={{ flex: a.total, background: colourOf(a.account) }} />
              ))}
          </div>
        )}
        <div className="flex flex-wrap gap-5">
          {shown.map((a) => (
            <AccountCard key={a.account} a={a} color={colourOf(a.account)} range={range} />
          ))}
        </div>
      </Card>

      <Card
        title={<span className="eyebrow">Connected sources</span>}
        action={
          <Button size="sm" onClick={onManage}>
            Manage connectors
          </Button>
        }
      >
        <div className="flex flex-wrap gap-2">
          {data.sources.length === 0 && <span className="src">Nothing connected yet.</span>}
          {data.sources.map((s) => (
            <Tag key={s} tone="n">
              {SOURCE_LABEL[s] ?? s}
            </Tag>
          ))}
          <Tag tone="c">Spotify · artists add their own</Tag>
        </div>
      </Card>
    </>
  );
}

/** One artist's followers over 30/60/90 days (workspace Stats tab and the artist's own view). */
export function ArtistStats({
  cfg,
  token,
  artistId,
  name,
  compact = false,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  name: string;
  compact?: boolean;
}) {
  const [range, setRange] = useState<Range>('30');
  const [data, setData] = useState<
    | (Omit<AccountInsight, 'account' | 'name'> & { range: number; humanitix?: HumanitixStats })
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api(cfg, token, 'GET', `/artists/${artistId}/stats?range=${range}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, artistId, range]);
  // A gig linked (or its count synced) elsewhere shows here without a reload.
  const live = useLive(['gigs'], artistId);
  useEffect(() => void load(), [load, live]);
  if (!data) return error ? <Notice tone="error">{error}</Notice> : <WaveLoader />;
  const a: AccountInsight = { ...data, account: artistId, name };
  return (
    <>
      <FollowersCard a={a} name={name} compact={compact} range={range} setRange={setRange} />
      {data.humanitix && (
        <HumanitixCard
          cfg={cfg}
          token={token}
          artistId={artistId}
          hx={data.humanitix}
          range={range}
          onChanged={load}
        />
      )}
    </>
  );
}

function FollowersCard({
  a,
  name,
  compact,
  range,
  setRange,
}: {
  a: AccountInsight;
  name: string;
  compact: boolean;
  range: Range;
  setRange: (r: Range) => void;
}) {
  return (
    <Card
      title={<span className="eyebrow">{compact ? 'My stats' : 'Followers'}</span>}
      action={<Chips label="Range" value={range} onChange={setRange} options={RANGES} />}
    >
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="t text-[30px]">{n(a.total)}</span>
        <b className="text-sm">
          {signed(a.delta)} in {range} days
        </b>
      </div>
      <Sparkline values={a.series} color="#D9534F" label={`${name} followers over ${range} days`} />
      {a.split.length > 0 || a.spotifyListeners !== undefined ? (
        <DataTable fit>
          <thead>
            <tr>
              <th scope="col">Platform</th>
              <th scope="col">Followers</th>
            </tr>
          </thead>
          <tbody>
            {a.split.map((s) => (
              <tr key={s.source}>
                <td>{SOURCE_LABEL[s.source] ?? s.source}</td>
                <td>{n(s.followers)}</td>
              </tr>
            ))}
            {a.spotifyListeners !== undefined && (
              <tr>
                <td>Spotify</td>
                <td>{n(a.spotifyListeners)} monthly listeners</td>
              </tr>
            )}
          </tbody>
        </DataTable>
      ) : (
        <p className="src">No numbers yet. Connect accounts in My connectors to see them here.</p>
      )}
    </Card>
  );
}

const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
const syncedLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-AU', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'not yet';

/**
 * Rev 18: the artist's Humanitix tickets in My stats: tickets sold across
 * upcoming linked gigs, each linked gig's count, and (for the artist) their
 * Humanitix events with an offer to link each one to a gig, or add it as one.
 */
export function HumanitixCard({
  cfg,
  token,
  artistId,
  hx,
  range,
  onChanged,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  hx: HumanitixStats;
  range: Range;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Rev 20: a linked gig's ticket analytics, open in place of the card. */
  const [open, setOpen] = useState<{ gigId: string; title: string } | null>(null);
  const mine = hx.events !== undefined;

  async function run(key: string, done: string, step: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await step();
      // Fetch the counts for what just changed, then show them.
      await api(cfg, token, 'POST', `/artists/${artistId}/connectors/humanitix/sync`).catch(
        () => undefined,
      );
      await onChanged();
      setNote(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const link = (e: HumanitixEventRow, gigId: string, gigTitle: string) =>
    run(e.id, `${e.name} is linked to ${gigTitle}. Its ticket sales come in by themselves.`, () =>
      api(cfg, token, 'PATCH', `/artists/${artistId}/gigs/${gigId}`, {
        humanitixEventId: e.id,
      }),
    );
  const unlink = (gigId: string, title: string) =>
    run(gigId, `${title} isn't linked to Humanitix any more.`, () =>
      api(cfg, token, 'PATCH', `/artists/${artistId}/gigs/${gigId}`, { humanitixEventId: null }),
    );
  const addGig = (e: HumanitixEventRow) =>
    run(e.id, `${e.name} is in your gigs now, linked to Humanitix.`, () =>
      api(cfg, token, 'POST', `/artists/${artistId}/gigs`, {
        title: e.name.slice(0, 120),
        date: melbourneDay(e.startDate),
        status: 'confirmed',
        deal: 'ticketed',
        humanitixEventId: e.id,
      }),
    );

  if (open)
    return (
      <TicketAnalytics
        cfg={cfg}
        token={token}
        target={{ artistId, gigId: open.gigId }}
        isArtist={mine}
        title={open.title}
        back={{ to: 'My stats', onClick: () => setOpen(null) }}
      />
    );
  return (
    <Card
      title={<span className="eyebrow">Tickets · Humanitix</span>}
      action={
        hx.connected ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void run('sync', 'Up to date with Humanitix.', async () => undefined)}
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </Button>
        ) : undefined
      }
    >
      {!hx.connected ? (
        <p className="src m-0">
          {mine
            ? 'Connect Humanitix in My connectors to see ticket sales for your gigs here.'
            : 'Humanitix isn’t connected for this artist yet.'}
        </p>
      ) : (
        <>
          {error && <Notice tone="error">{error}</Notice>}
          {note && <Notice tone="success">{note}</Notice>}
          {hx.lastError && <Notice tone="error">Humanitix: {hx.lastError}</Notice>}
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="t text-[30px]">{n(hx.ticketsSold)}</span>
            <span className="src">
              tickets sold for upcoming gigs · synced {syncedLabel(hx.lastSyncAt)}
            </span>
          </div>
          <Sparkline values={hx.series} color="#011935" label={`Tickets sold over ${range} days`} />
          {hx.gigs.length > 0 ? (
            <DataTable fit label="Gigs on Humanitix">
              <thead>
                <tr>
                  <th scope="col">Gig</th>
                  <th scope="col">Tickets sold</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {hx.gigs.map((g) => (
                  <tr key={g.gigId}>
                    <td>
                      <b>{g.title}</b>
                      <span className="src block">
                        {dayLabel(g.date)}
                        {g.eventName && g.eventName !== g.title ? ` · ${g.eventName}` : ''}
                      </span>
                    </td>
                    <td>{g.ticketsSold === null ? 'Syncing…' : n(g.ticketsSold)}</td>
                    <td>
                      <span className="flex flex-wrap justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Ticket analytics for ${g.title}`}
                          onClick={() => setOpen({ gigId: g.gigId, title: g.title })}
                        >
                          Analytics
                        </Button>
                        {mine && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => void unlink(g.gigId, g.title)}
                          >
                            Unlink
                          </Button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <p className="src m-0">No gigs linked to Humanitix yet.</p>
          )}
          {mine && (
            <HumanitixEvents
              events={hx.events!}
              linkable={hx.linkable ?? []}
              busy={busy}
              onLink={(e, gigId) => {
                const g = (hx.linkable ?? []).find((x) => x.gigId === gigId);
                void link(e, gigId, g?.title ?? 'the gig');
              }}
              onAdd={(e) => void addGig(e)}
            />
          )}
        </>
      )}
    </Card>
  );
}

/** The artist's Humanitix events, each linked to a gig or offering to be. */
function HumanitixEvents({
  events,
  linkable,
  busy,
  onLink,
  onAdd,
}: {
  events: HumanitixEventRow[];
  linkable: { gigId: string; title: string; date: string }[];
  busy: string | null;
  onLink: (e: HumanitixEventRow, gigId: string) => void;
  onAdd: (e: HumanitixEventRow) => void;
}) {
  const [pick, setPick] = useState<Record<string, string>>({});
  if (events.length === 0)
    return <p className="src m-0">No events found in your Humanitix account yet.</p>;
  return (
    <section className="flex flex-col gap-2" aria-label="Your Humanitix events">
      <span className="text-[15px] font-bold">Your Humanitix events</span>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {events.map((e) => {
          const day = melbourneDay(e.startDate);
          const chosen = pick[e.id] ?? e.suggestedGigId ?? '';
          return (
            <li key={e.id} className="flex flex-col gap-2 rounded-lg border border-input p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <b>{e.name}</b>
                {day && <span className="src">{dayLabel(day)}</span>}
                {e.gigId && <Tag tone="s">Linked to {e.gigTitle}</Tag>}
              </div>
              {!e.gigId && (
                <div className="flex flex-wrap items-end gap-2">
                  {linkable.length > 0 && (
                    <>
                      <div className="min-w-[220px] flex-1">
                        <Select
                          label={`Link ${e.name} to a gig`}
                          value={chosen}
                          onChange={(ev) => setPick({ ...pick, [e.id]: ev.target.value })}
                          options={[
                            { value: '', label: 'Pick a gig' },
                            ...linkable.map((g) => ({
                              value: g.gigId,
                              label: `${g.title} · ${dayLabel(g.date)}${g.gigId === e.suggestedGigId ? ' (same day)' : ''}`,
                            })),
                          ]}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="navy"
                        disabled={!chosen || busy !== null}
                        onClick={() => onLink(e, chosen)}
                      >
                        {busy === e.id ? 'Linking…' : 'Link'}
                      </Button>
                    </>
                  )}
                  {day && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => onAdd(e)}
                    >
                      Add as a gig
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
