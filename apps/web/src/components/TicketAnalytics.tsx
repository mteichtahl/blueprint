import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  analyticsCsv,
  analyticsPath,
  dollars,
  pct,
  salesCurve,
  statusLabel,
  syncPath,
  type AnalyticsResponse,
  type AnalyticsTarget,
  type TicketAnalytics as Analytics,
} from '../lib/ticketAnalytics.ts';
import { BackLink } from './patterns.tsx';
import { Bar, Button, Card, Notice, Tag, WaveLoader } from './ui.tsx';

/**
 * Rev 20: the Ticket analytics page for a gig or Blueprint event linked to
 * Humanitix (canvas: "Humanitix · Ticket analytics"). Headline tiles, where
 * the money goes, sales over time against the usual pace, ticket types, and
 * the breakdowns. Every chart has its figures in text or a table as well.
 */
export function TicketAnalytics({
  cfg,
  token,
  target,
  isArtist,
  title,
  back,
}: {
  cfg: AppConfig;
  token: string;
  target: AnalyticsTarget;
  isArtist: boolean;
  /** The gig's or event's name in the app, until the figures arrive. */
  title: string;
  back: { to: string; onClick: () => void };
}) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sync' | 'share' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<AnalyticsResponse>(cfg, token, 'GET', analyticsPath(target)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, target]);
  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setBusy('sync');
    setNote(null);
    setError(null);
    try {
      setData(await api<AnalyticsResponse>(cfg, token, 'POST', syncPath(target, isArtist)));
      setNote('Up to date with Humanitix.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function share(on: boolean) {
    if (!('gigId' in target)) return;
    setBusy('share');
    setError(null);
    try {
      await api(cfg, token, 'PATCH', `/artists/${target.artistId}/gigs/${target.gigId}`, {
        shareTicketAnalytics: on,
      });
      setNote(
        on
          ? 'Blueprint can see these ticket analytics.'
          : 'Blueprint now sees tickets sold and takings only.',
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function download(a: Analytics) {
    const blob = new Blob([analyticsCsv(a)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${a.name.replace(/[^\w -]+/g, '').trim() || 'ticket-analytics'} - tickets.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const a = data?.analytics;
  return (
    <Card
      title={<span className="eyebrow">Ticket analytics · Humanitix</span>}
      action={<BackLink to={back.to} onClick={back.onClick} />}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
          <h3 className="poster text-[34px] leading-[.9] [overflow-wrap:anywhere]">
            {a?.name ?? title}
          </h3>
          {a && (
            <span className="flex flex-wrap items-center gap-2">
              <Tag tone={a.status === 'finished' ? 's' : a.status === 'sold-out' ? 'k' : 'n'}>
                {statusLabel(a.status)}
              </Tag>
              {a.startDate && <span className="src">{when(a.startDate)}</span>}
            </span>
          )}
        </div>
        {a && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="src">Synced {ago(a.syncedAt)}</span>
            {data?.canSync && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void sync()}
              >
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </Button>
            )}
            {!a.limited && (
              <Button size="sm" variant="ghost" onClick={() => download(a)}>
                Export CSV
              </Button>
            )}
          </div>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="success">{note}</Notice>}
      {data?.lastError && <Notice tone="error">Humanitix: {data.lastError}</Notice>}
      {!data && !error && <WaveLoader label="Loading ticket analytics" />}
      {data && !data.connected && (
        <p className="src m-0">
          {isArtist
            ? 'Connect Humanitix in My connectors to see ticket analytics.'
            : 'Humanitix isn’t connected for this account.'}
        </p>
      )}
      {data?.connected && data.pending && (
        <div className="flex flex-col items-start gap-2">
          <p className="m-0">Linked to Humanitix. The figures come in with the next sync.</p>
          {data.canSync && (
            <Button size="sm" variant="cta" disabled={busy !== null} onClick={() => void sync()}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </Button>
          )}
        </div>
      )}
      {a && <Body a={a} />}
      {data?.canShare && (
        <label className="flex items-center gap-3 border-t border-input pt-4">
          <input
            type="checkbox"
            className="size-5"
            checked={data.shared !== false}
            disabled={busy !== null}
            onChange={(e) => void share(e.target.checked)}
          />
          <span>
            <b>Share ticket analytics with Blueprint</b>
            <span className="src block">
              Off: Blueprint sees tickets sold and takings only. Buyer names and emails are never
              kept in the app.
            </span>
          </span>
        </label>
      )}
    </Card>
  );
}

// ── The page body ──────────────────────────────────────────────────────────
function Body({ a }: { a: Analytics }) {
  const n = (x: number) => x.toLocaleString('en-AU');
  if (a.limited)
    return (
      <>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
          <Tile
            label="Tickets sold"
            value={n(a.sold)}
            sub={a.capacity ? `of ${n(a.capacity)}` : undefined}
          />
          <Tile label="Revenue · net" value={dollars(a.money.netCents)} tone="navy" />
        </div>
        <p className="src m-0">
          The artist keeps the rest of this gig’s ticket analytics to themselves.
        </p>
      </>
    );
  const m = a.money;
  return (
    <>
      {a.highlights.length > 0 && (
        <section
          aria-label="Highlights"
          className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 rounded-[24px] bg-primary p-4 text-primary-foreground shadow-[5px_5px_0_#E8726E]"
        >
          {a.highlights.map((h) => (
            <div key={h.label}>
              <span className="eyebrow !text-[#F2A3A0]">★ {h.label}</span>
              <p className="m-0 mt-1 text-[17px] leading-snug">{h.text}</p>
            </div>
          ))}
        </section>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <Tile
          label="Tickets sold"
          value={n(a.sold)}
          sub={a.capacity ? `of ${n(a.capacity)} · ${pct(a.sold, a.capacity)}% sold` : undefined}
          tone="accent"
        >
          {a.capacity ? <Bar pct={pct(a.sold, a.capacity)} /> : null}
        </Tile>
        <Tile
          label="Revenue · net to you"
          value={dollars(m.netCents)}
          sub="after fees, discounts and refunds"
          tone="navy"
        />
        <Tile label="Gross sales" value={dollars(m.grossCents)} sub="what buyers paid" />
        <Tile
          label="Avg ticket"
          value={a.avgTicketCents === null ? '—' : dollars(a.avgTicketCents)}
          sub="after discounts"
        />
        <Tile
          label="Refunds"
          value={dollars(a.refunds.cents)}
          sub={`${n(a.refunds.tickets)} tickets · ${n(a.refunds.orders)} orders`}
          tone={a.refunds.cents > 0 ? 'coral' : undefined}
        />
        <Tile
          label="Checked in"
          value={a.checkedIn === null ? '—' : n(a.checkedIn)}
          sub={
            a.checkedIn === null
              ? 'shows once doors open'
              : `${pct(a.checkedIn, a.sold)}% of sold · ${n(Math.max(0, a.sold - a.checkedIn))} no-shows`
          }
          tone={a.checkedIn === null ? 'dim' : undefined}
        />
      </div>

      <Section title="Sales over time">
        <SalesChart a={a} />
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Where the money goes">
          <Waterfall a={a} />
        </Section>
        <Section title="Ticket types">
          <table className="w-full text-[15px]">
            <thead>
              <tr className="text-left">
                <th scope="col" className="eyebrow py-2">
                  Type
                </th>
                <th scope="col" className="eyebrow py-2">
                  Sold
                </th>
                <th scope="col" className="eyebrow py-2 text-right">
                  Revenue
                </th>
              </tr>
            </thead>
            <tbody>
              {a.ticketTypes.map((t) => (
                <tr key={t.id} className="border-t border-dashed border-input">
                  <td className="py-2.5 pr-2">
                    <b>{t.name}</b> · {dollars(t.priceCents)}
                    {t.soldOut && (
                      <Tag tone="k" className="ml-1.5">
                        Sold out
                      </Tag>
                    )}
                  </td>
                  <td className="w-[40%] py-2.5 pr-2">
                    {t.quantity ? <Bar pct={pct(t.sold, t.quantity)} /> : null}
                    <span className="src">
                      {n(t.sold)}
                      {t.quantity ? ` / ${n(t.quantity)}` : ''}
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-bold">{dollars(t.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Section title="When people buy">
          <Heatmap heat={a.heat} />
        </Section>
        <Section title="How they paid">
          <Split
            label="How tickets were paid for"
            parts={a.payment.map((p) => ({ label: p.label, n: p.tickets }))}
          />
          <p className="src m-0">
            Online <b>{n(a.channels.online)}</b> · At the door <b>{n(a.channels.manual)}</b>
          </p>
        </Section>
        <Section title="Orders">
          <div className="flex flex-wrap gap-5">
            <Big label="Orders" value={n(a.orders.count)} />
            <Big
              label="Avg order"
              value={a.orders.avgCents === null ? '—' : dollars(a.orders.avgCents)}
            />
          </div>
          <Bars
            label="Tickets per order"
            rows={[
              { label: '1', n: a.orders.sizes.one },
              { label: '2', n: a.orders.sizes.two },
              { label: '3–4', n: a.orders.sizes.threeFour },
              { label: '5+', n: a.orders.sizes.fivePlus },
            ]}
          />
          {a.orders.biggest && (
            <p className="src m-0">
              Biggest: {a.orders.biggest.tickets} tickets, {dollars(a.orders.biggest.cents)}.
            </p>
          )}
        </Section>
        <Section title="How far ahead">
          <Bars
            label="How far ahead tickets were bought"
            rows={[
              { label: 'Same day', n: a.leadTime.sameDay },
              { label: '1–3 days', n: a.leadTime.d1to3 },
              { label: '4–7 days', n: a.leadTime.d4to7 },
              { label: '1–2 weeks', n: a.leadTime.w1to2 },
              { label: '2+ weeks', n: a.leadTime.w2plus },
            ]}
          />
        </Section>
        <Section title="Discount codes">
          {a.codes.length === 0 ? (
            <p className="src m-0">No discount codes used.</p>
          ) : (
            a.codes.map((c) => (
              <div
                key={c.code}
                className="flex flex-col gap-1 border-b border-dashed border-input pb-2"
              >
                <b>{c.code}</b>
                <span className="src">
                  {n(c.orders)} orders · {n(c.tickets)} tickets · {dollars(-c.discountCents)} off ·
                  brought in {dollars(c.revenueCents)}
                </span>
              </div>
            ))
          )}
          {a.autoDiscountCents > 0 && (
            <p className="src m-0">Automatic discounts: {dollars(-a.autoDiscountCents)}.</p>
          )}
        </Section>
        <Section title="Fans">
          <div className="flex flex-wrap gap-5">
            {a.repeatFans && (
              <Big
                label="Repeat fans"
                value={`${pct(a.repeatFans.fans, a.repeatFans.of)}%`}
                sub={`${n(a.repeatFans.fans)} of ${n(a.repeatFans.of)} buyers came before`}
              />
            )}
            <Big
              label="Mailing list"
              value={`${pct(a.mailingList.optedIn, a.mailingList.of)}%`}
              sub="of buyers opted in"
            />
          </div>
          <p className="src m-0">Matched privately: no names or emails are kept.</p>
        </Section>
        {a.arrivals.length > 0 && (
          <Section title="Arrivals">
            <Bars
              label="Arrivals every 15 minutes"
              rows={a.arrivals.map((x) => ({ label: x.at, n: x.n }))}
            />
          </Section>
        )}
      </div>
    </>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5 rounded-[24px] border-2 border-foreground bg-card p-4 shadow-[5px_5px_0_var(--color-foreground,#011935)]">
      <h3 className="poster text-[20px] leading-none">{title}</h3>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
  children,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  tone?: 'navy' | 'accent' | 'coral' | 'dim' | undefined;
  children?: ReactNode;
}) {
  const look = {
    navy: 'bg-primary text-primary-foreground border-primary shadow-[5px_5px_0_#E8726E]',
    accent: 'bg-[#C9B8FF] text-[#011935] border-[#011935] shadow-[5px_5px_0_#011935]',
    coral: 'bg-card border-[#B5403C] shadow-[5px_5px_0_#B5403C]',
    dim: 'bg-secondary border-dashed border-input',
    plain: 'bg-card border-foreground shadow-[5px_5px_0_#011935]',
  }[tone ?? 'plain'];
  return (
    <div className={`flex flex-col gap-1 rounded-[24px] border-2 p-3.5 ${look}`}>
      <span className="font-['Lexend_Exa'] text-[10px] font-bold tracking-[.2em] uppercase">
        {label}
      </span>
      <span
        className={`poster text-[36px] leading-none ${tone === 'coral' ? 'text-[#B5403C]' : ''}`}
      >
        {value}
      </span>
      {children}
      {sub && <span className="text-sm opacity-80">{sub}</span>}
    </div>
  );
}

function Big({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <span className="font-['Lexend_Exa'] text-[10px] font-bold tracking-[.2em] uppercase">
        {label}
      </span>
      <div className="poster text-[34px] leading-none">{value}</div>
      {sub && <span className="src">{sub}</span>}
    </div>
  );
}

/** Horizontal bars with the number beside each; the list is the accessible version. */
function Bars({ label, rows }: { label: string; rows: { label: string; n: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[76px_1fr_40px] items-center gap-2 text-sm">
          <span>{r.label}</span>
          <span className="h-3.5 rounded-full bg-secondary">
            <span
              className="block h-full rounded-full bg-[#C9B8FF]"
              style={{ width: `${(r.n / max) * 100}%` }}
            />
          </span>
          <b className="text-right">{r.n.toLocaleString('en-AU')}</b>
        </li>
      ))}
    </ul>
  );
}

const SPLIT_COLOURS = ['#011935', '#C9B8FF', '#E8726E', '#E7D6AA', '#5C6775', '#9FD8FF', '#B5403C'];
function Split({ label, parts }: { label: string; parts: { label: string; n: number }[] }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return <p className="src m-0">No sales yet.</p>;
  return (
    <>
      <div
        aria-hidden="true"
        className="flex h-6 overflow-hidden rounded-full border-2 border-foreground"
      >
        {parts.map((p, i) => (
          <span
            key={p.label}
            style={{ flex: p.n, background: SPLIT_COLOURS[i % SPLIT_COLOURS.length] }}
          />
        ))}
      </div>
      <ul aria-label={label} className="m-0 flex list-none flex-col p-0">
        {parts.map((p, i) => (
          <li
            key={p.label}
            className="flex items-center gap-2 border-b border-dashed border-input py-1.5 text-[15px]"
          >
            <span
              aria-hidden="true"
              className="size-3 rounded-sm"
              style={{ background: SPLIT_COLOURS[i % SPLIT_COLOURS.length] }}
            />
            <span className="flex-1">{p.label}</span>
            <b>
              {p.n.toLocaleString('en-AU')} · {pct(p.n, total)}%
            </b>
          </li>
        ))}
      </ul>
    </>
  );
}

function Waterfall({ a }: { a: Analytics }) {
  const m = a.money;
  const top = Math.max(1, m.ticketSalesCents);
  const rows: { label: string; cents: number; minus?: boolean; total?: boolean }[] = [
    { label: 'Ticket sales', cents: m.ticketSalesCents },
    { label: 'Discounts', cents: m.discountsCents, minus: true },
    { label: 'Humanitix fees (absorbed)', cents: m.absorbedFeesCents, minus: true },
    { label: 'Refunds', cents: m.refundsCents, minus: true },
    ...(m.otherCents ? [{ label: 'Other adjustments', cents: -m.otherCents, minus: true }] : []),
    { label: 'Net to you', cents: m.netCents, total: true },
  ];
  return (
    <>
      <ul aria-label="Where the money goes" className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((r) => (
          <li
            key={r.label}
            className="grid grid-cols-[minmax(120px,170px)_1fr_auto] items-center gap-2 text-[15px]"
          >
            <span className={r.total ? 'font-extrabold' : ''}>{r.label}</span>
            <span className="h-5">
              <span
                className={`block h-full rounded-md ${r.total ? 'border-2 border-foreground bg-[#C9B8FF]' : r.minus ? 'bg-[#E8726E]' : 'bg-primary'}`}
                style={{ width: `${Math.max(r.cents ? 2 : 0, (Math.abs(r.cents) / top) * 100)}%` }}
              />
            </span>
            <b className={r.minus && r.cents ? 'text-[#B5403C]' : ''}>
              {r.minus && r.cents > 0 ? '−' : ''}
              {dollars(Math.abs(r.cents))}
            </b>
          </li>
        ))}
      </ul>
      <p className="src m-0">
        Buyers also paid {dollars(m.passedOnFeesCents)} in booking fees, passed on to them (not your
        money).
        {m.donationsCents ? ` Donations and tips: ${dollars(m.donationsCents)}.` : ''}
      </p>
    </>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SLOTS = ['Morning', 'Afternoon', '5–8 pm', 'Late'];
function Heatmap({ heat }: { heat: number[][] }) {
  const max = Math.max(1, ...heat.flat());
  let best = { d: -1, s: -1, n: 0 };
  heat.forEach((row, d) =>
    row.forEach((v, s) => {
      if (v > best.n) best = { d, s, n: v };
    }),
  );
  return (
    <>
      <table className="w-full border-separate border-spacing-1 text-xs">
        <caption className="sr-only">Tickets sold by weekday and time of day (Melbourne)</caption>
        <thead>
          <tr>
            <td />
            {SLOTS.map((s) => (
              <th key={s} scope="col" className="font-normal">
                {s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAYS.map((day, d) => (
            <tr key={day}>
              <th scope="row" className="text-left font-normal">
                {day}
              </th>
              {SLOTS.map((s, i) => {
                const v = heat[d]?.[i] ?? 0;
                return (
                  <td
                    key={s}
                    className="h-6 rounded-[5px]"
                    style={{ background: `rgba(1,25,53,${0.06 + (v / max) * 0.94})` }}
                  >
                    <span className="sr-only">{v}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {best.n > 0 && (
        <p className="m-0 text-[15px]">
          Busiest:{' '}
          <b>
            {DAYS[best.d]}, {SLOTS[best.s]!.toLowerCase()}
          </b>{' '}
          (Melbourne time).
        </p>
      )}
    </>
  );
}

function SalesChart({ a }: { a: Analytics }) {
  const c = salesCurve(a);
  const W = 760;
  const H = 200;
  const total = c.days.length - 1 || 1;
  const top = Math.max(1, a.capacity ?? 0, ...c.sold, ...(c.usual ?? []));
  const x = (i: number) => (i / total) * W;
  const y = (v: number) => H - (v / top) * (H - 20);
  const maxDaily = Math.max(1, ...c.daily);
  const line = (vals: number[]) =>
    vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const todayX = x(c.from - c.today);
  const summary = a.pace
    ? `${a.sold} sold vs ${a.pace.usualNow} usual at this point`
    : `${a.sold} sold`;
  return (
    <>
      <svg
        viewBox={`-6 -6 ${W + 12} ${H + 12}`}
        className="h-[220px] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Tickets sold over time: ${summary}`}
      >
        <line x1="0" y1={H} x2={W} y2={H} stroke="#C9C2B4" strokeDasharray="3 5" />
        <g fill="#C9B8FF">
          {c.daily.map((n, i) => {
            const h = (n / maxDaily) * 60;
            return n ? (
              <rect
                key={i}
                x={x(i) + 1}
                y={H - h}
                width={Math.max(3, W / total - 4)}
                height={h}
                rx="2"
              />
            ) : null;
          })}
        </g>
        {c.usual && (
          <path
            d={line(c.usual)}
            fill="none"
            stroke="#011935"
            strokeWidth="3"
            strokeDasharray="6 6"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={line(c.sold)}
          fill="none"
          stroke="#B5403C"
          strokeWidth="4"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {a.status !== 'finished' && (
          <line
            x1={todayX}
            y1="0"
            x2={todayX}
            y2={H}
            stroke="#B5403C"
            strokeDasharray="2 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="src flex justify-between">
        <span>{c.from} days out</span>
        {a.status !== 'finished' && a.daysOut !== null && (
          <b className="text-[#B5403C]">Today · {a.daysOut} days out</b>
        )}
        <span>Show day</span>
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <Legend colour="#B5403C">Tickets sold</Legend>
        {c.usual && (
          <Legend colour="#011935" dashed>
            Your usual pace ({a.pace!.events} earlier event{a.pace!.events === 1 ? '' : 's'})
          </Legend>
        )}
        <Legend colour="#C9B8FF" box>
          Sold that day
        </Legend>
      </div>
      {a.pace && (
        <Tag tone="c" className="w-fit">
          {summary}
        </Tag>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-bold">Table view</summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left">
              <th scope="col">Day</th>
              <th scope="col">Tickets</th>
            </tr>
          </thead>
          <tbody>
            {a.daily.map((d) => (
              <tr key={d.day}>
                <td>
                  {new Date(`${d.day}T12:00:00Z`).toLocaleDateString('en-AU', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'UTC',
                  })}
                </td>
                <td>{d.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function Legend({
  colour,
  dashed,
  box,
  children,
}: {
  colour: string;
  dashed?: boolean;
  box?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="22" height="12" aria-hidden="true">
        {box ? (
          <rect x="5" y="0" width="12" height="12" rx="2" fill={colour} />
        ) : (
          <line
            x1="0"
            y1="6"
            x2="22"
            y2="6"
            stroke={colour}
            strokeWidth="4"
            strokeDasharray={dashed ? '4 4' : undefined}
          />
        )}
      </svg>
      {children}
    </span>
  );
}

function when(iso: string) {
  return new Date(iso).toLocaleString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Australia/Melbourne',
  });
}

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24
    ? `${h} hr ago`
    : new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}
