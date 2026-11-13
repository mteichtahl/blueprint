import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  filterRows,
  KIND_LABEL,
  ticketRows,
  ticketTotals,
  whenLabel,
  type TicketEvent,
  type TicketFilter,
  type TicketGig,
  type TicketRow,
} from '../lib/tickets.ts';
import { aud } from './Money.tsx';
import { Bar, Card, Chips, DataTable, DateBlock, RowCard, Tag, WaveLoader } from './ui.tsx';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'events', label: 'Events & workshops' },
  { id: 'gigs', label: 'Artist gigs' },
] as const;

const pct = (n: number, d: number) => (d > 0 ? Math.min(100, (n / d) * 100) : 0);
const soldText = (r: TicketRow) =>
  r.of ? `${r.sold} / ${r.of}${r.ofLabel === 'capacity' ? ' cap.' : ''}` : `${r.sold} sold`;
const kindTone = (r: TicketRow) => (r.kind === 'gig' ? 's' : r.kind === 'workshop' ? 'c' : 'n');

/**
 * Studio HQ "Tickets": what's selling for upcoming events, workshops and the
 * gigs artists share with Blueprint. A row opens the event or the gig page.
 */
export function TicketTracker({
  cfg,
  token,
  artistNames,
  onOpenEvent,
  onOpenGig,
  onNavigate,
}: {
  cfg: AppConfig;
  token: string;
  artistNames: Record<string, string>;
  onOpenEvent: (eventId: string) => void;
  onOpenGig: (gig: TicketGig) => void;
  onNavigate: (view: 'events' | 'gigs') => void;
}) {
  const [data, setData] = useState<{
    events: TicketEvent[];
    gigs: TicketGig[];
    capacity: Record<string, number>;
  } | null>(null);
  const [filter, setFilter] = useState<TicketFilter>('all');

  useEffect(() => {
    let live = true;
    void Promise.all([
      api<{ events: TicketEvent[] }>(cfg, token, 'GET', '/events').catch(() => ({ events: [] })),
      api<{ gigs: TicketGig[] }>(cfg, token, 'GET', '/gigs?filter=upcoming').catch(() => ({
        gigs: [],
      })),
      api<{ venues: { venueId: string; capacity: number }[] }>(cfg, token, 'GET', '/venues').catch(
        () => ({ venues: [] }),
      ),
    ]).then(([e, g, v]) => {
      if (!live) return;
      setData({
        events: e.events,
        gigs: g.gigs,
        capacity: Object.fromEntries(v.venues.map((x) => [x.venueId, x.capacity])),
      });
    });
    return () => {
      live = false;
    };
  }, [cfg, token]);

  const today = new Date().toISOString().slice(0, 10);
  const all = data
    ? ticketRows({
        events: data.events,
        gigs: data.gigs,
        artistNames,
        venueCapacity: data.capacity,
        today,
      })
    : [];
  const rows = filterRows(all, filter);
  const totals = ticketTotals(rows);
  const open = (r: TicketRow) => {
    if (r.eventId) return onOpenEvent(r.eventId);
    const gig = data?.gigs.find((g) => g.gigId === r.gigId);
    if (gig) onOpenGig(gig);
  };
  const shown = rows.slice(0, 6);

  return (
    <Card
      className="flex-[1_1_100%]"
      title="Tickets"
      action={
        <Chips label="Show tickets for" value={filter} onChange={setFilter} options={FILTERS} />
      }
      footer={
        <span className="flex w-full flex-wrap">
          <button type="button" className="flex-1" onClick={() => onNavigate('events')}>
            Events &amp; workshops
          </button>
          <button type="button" className="flex-1" onClick={() => onNavigate('gigs')}>
            Artist gigs
          </button>
        </span>
      }
    >
      {data === null ? (
        <WaveLoader />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="tile">
              <span className="src">Tickets sold</span>
              <b className="t text-xl">{totals.sold.toLocaleString('en-AU')}</b>
            </div>
            <div className="tile">
              <span className="src">Ticket takings</span>
              <b className="t text-xl">{aud(totals.takingsCents)}</b>
            </div>
            <div className="tile">
              <span className="src">Behind target</span>
              <b className={`t text-xl ${totals.behind ? 'text-accent' : ''}`}>{totals.behind}</b>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="src">
              {filter === 'gigs'
                ? 'No ticketed artist gigs coming up.'
                : filter === 'events'
                  ? 'No events or workshops coming up.'
                  : 'Nothing on sale right now.'}
            </p>
          ) : (
            <DataTable
              label="Tickets"
              cards={shown.map((r) => (
                <RowCard
                  key={r.id}
                  accent={r.behind}
                  lead={<DateBlock date={r.date} />}
                  title={r.title}
                  status={<Tag tone={kindTone(r)}>{KIND_LABEL[r.kind]}</Tag>}
                  sub={`${r.who} · ${whenLabel(r)} · ${soldText(r)}`}
                  tags={
                    <>
                      {r.behind && <Tag tone="k">Behind</Tag>}
                      {r.takingsCents > 0 && <Tag tone="s">{aud(r.takingsCents)}</Tag>}
                      {r.source === 'humanitix' && <Tag tone="s">Humanitix</Tag>}
                    </>
                  }
                  onOpen={() => open(r)}
                />
              ))}
            >
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col">Type</th>
                  <th scope="col">Sold</th>
                  <th scope="col">Takings</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={r.id}
                    className={`cursor-pointer ${r.behind ? 'bg-[#FFF7F6] dark:bg-[#3a1f1e]' : ''}`}
                    onClick={() => open(r)}
                  >
                    <td>
                      {whenLabel(r)}
                      {r.daysAway > 14 ? null : (
                        <span className="src block">
                          {new Date(`${r.date}T00:00:00`).toLocaleDateString('en-AU', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'short',
                          })}
                        </span>
                      )}
                    </td>
                    <td>
                      <button type="button" className="text-left font-bold">
                        {r.title}
                      </button>
                      <span className="src block">{r.who}</span>
                    </td>
                    <td>
                      <Tag tone={kindTone(r)}>{KIND_LABEL[r.kind]}</Tag>
                    </td>
                    <td className="min-w-36">
                      <span className="flex items-center gap-2 text-sm">
                        <b className="flex-1">{soldText(r)}</b>
                        {r.behind && <Tag tone="k">Behind</Tag>}
                      </span>
                      {r.of > 0 && (
                        <Bar pct={pct(r.sold, r.of)} color={r.behind ? '#D9534F' : '#011935'} />
                      )}
                    </td>
                    <td>{r.takingsCents ? aud(r.takingsCents) : '—'}</td>
                    <td>{r.source === 'humanitix' ? 'Humanitix' : 'Typed in'}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          {rows.length > shown.length && (
            <p className="src">
              {rows.length - shown.length} more coming up. Open Events &amp; workshops or Artist
              gigs to see them all.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
