import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { SOURCE_LABEL, type AccountInsight, type InsightsData } from '../lib/connectors.ts';
import { Avatar, Button, Card, Chips, DataTable, Notice, Tag } from '../components/ui.tsx';

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
        <Avatar name={a.account === 'bmg' ? 'B M G' : a.name} />
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

  if (!data) return error ? <Notice tone="error">{error}</Notice> : <p className="src">Loading…</p>;
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
    (Omit<AccountInsight, 'account' | 'name'> & { range: number }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        setData(await api(cfg, token, 'GET', `/artists/${artistId}/stats?range=${range}`));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [cfg, token, artistId, range]);
  if (!data) return error ? <Notice tone="error">{error}</Notice> : <p className="src">Loading…</p>;
  const a: AccountInsight = { ...data, account: artistId, name };
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
