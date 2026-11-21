import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  melbourneTime,
  pickerRows,
  type HumanitixEvent,
  type PickerRow,
} from '../lib/connectors.ts';

/**
 * Rev 19: pick a Humanitix event on the gig form (New gig and Edit gig).
 * Artists pick from their own Humanitix events; Blueprint picks from
 * Blueprint's own. Events on the gig's date come first, an event already on
 * another gig can't be picked, and Refresh fetches the list again.
 */

interface Listed {
  connected: boolean;
  events: HumanitixEvent[];
  syncedAt?: string | null;
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });

export function eventWhen(e: Pick<HumanitixEvent, 'startDate' | 'endDate'>): string {
  if (!e.startDate) return 'No date';
  const d = new Date(e.startDate);
  if (Number.isNaN(d.getTime())) return 'No date';
  const day = d.toLocaleDateString('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const start = melbourneTime(e.startDate);
  const end = melbourneTime(e.endDate);
  return [day, start && end ? `${start}–${end}` : start].filter(Boolean).join(' · ');
}

export function HumanitixPicker({
  cfg,
  token,
  artistId,
  isArtist,
  gigId,
  gigDate,
  value,
  lockedToArtist,
  onPick,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isArtist: boolean;
  gigId?: string;
  gigDate?: string;
  /** The linked event id, if any. */
  value: string | null;
  /** Blueprint editing a gig linked to the artist's own account: shown, not changeable. */
  lockedToArtist?: boolean;
  onPick: (e: HumanitixEvent | null) => void;
}) {
  const [listed, setListed] = useState<Listed | null>(null);
  const [gigs, setGigs] = useState<
    { gigId: string; title: string; status?: string; humanitixEventId?: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openList, setOpenList] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const label = isArtist ? 'Humanitix event' : "Humanitix event (Blueprint's account)";

  const load = useCallback(async () => {
    if (lockedToArtist) return;
    try {
      const [l, g] = await Promise.all([
        api<Listed>(
          cfg,
          token,
          'GET',
          isArtist
            ? `/connectors/humanitix/events?artistId=${encodeURIComponent(artistId)}`
            : '/connectors/humanitix/events',
        ),
        api<{ gigs: typeof gigs }>(cfg, token, 'GET', `/artists/${artistId}/gigs`),
      ]);
      setListed({
        connected: l.connected !== false,
        events: l.events ?? [],
        syncedAt: l.syncedAt ?? null,
      });
      setGigs(g.gigs ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, artistId, isArtist, lockedToArtist]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpenList(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function refresh() {
    setBusy(true);
    try {
      // The artist's list is kept by the sync; Blueprint's is fetched live.
      if (isArtist) await api(cfg, token, 'POST', `/artists/${artistId}/connectors/humanitix/sync`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (lockedToArtist) {
    return (
      <div className="flex flex-col gap-1.5 col-span-2">
        <span className="text-[15px] font-bold">Humanitix event</span>
        <span className="src">
          Linked to a Humanitix event in the artist’s own account. Only the artist can change it.
        </span>
      </div>
    );
  }

  if (listed && !listed.connected) {
    return (
      <div className="flex flex-col gap-1.5 col-span-2">
        <span className="text-[15px] font-bold">{label}</span>
        <span className="src">
          {isArtist
            ? 'Connect Humanitix in My connectors to pick an event here.'
            : 'Connect Blueprint’s Humanitix in Connectors to pick an event here.'}
        </span>
      </div>
    );
  }

  const { upcoming, past } = pickerRows(listed?.events ?? [], {
    ...(gigId ? { gigId } : {}),
    ...(gigDate ? { gigDate } : {}),
    today: today(),
    q,
    gigs,
  });
  const picked = value ? (listed?.events ?? []).find((e) => e.id === value) : undefined;

  const row = (r: PickerRow) => (
    <li key={r.id}>
      <button
        type="button"
        disabled={!!r.linkedTo}
        className="flex w-full flex-col items-start rounded-md px-2.5 py-2 text-left hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
        onClick={() => {
          onPick(r);
          setOpenList(false);
          setQ('');
        }}
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <b>{r.name}</b>
          {r.sameDay && (
            <span className="rounded bg-cta px-1.5 text-xs font-bold text-white">Same day</span>
          )}
        </span>
        <span className="src">
          {[eventWhen(r), r.venue, r.linkedTo ? `Linked to ${r.linkedTo}` : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
      </button>
    </li>
  );

  return (
    <div className="relative flex flex-col gap-1.5 col-span-2" ref={box}>
      <span className="text-[15px] font-bold">{label}</span>
      {error && <span className="text-sm text-cta">{error}</span>}
      {value ? (
        <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg border border-input bg-white px-3 py-1.5">
          <span className="flex flex-1 flex-col">
            <b>{picked?.name ?? 'Linked Humanitix event'}</b>
            {picked && (
              <span className="src">
                {[eventWhen(picked), picked.venue].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
          <button
            type="button"
            className="text-sm underline"
            aria-label="Change Humanitix event"
            onClick={() => {
              onPick(null);
              setOpenList(true);
            }}
          >
            Change
          </button>
          <button
            type="button"
            className="text-sm underline"
            aria-label="Remove Humanitix event"
            onClick={() => onPick(null)}
          >
            Remove
          </button>
        </div>
      ) : (
        <input
          className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base shadow-xs"
          type="search"
          aria-label={label}
          placeholder={listed ? 'Search Humanitix events…' : 'Loading Humanitix events…'}
          value={q}
          onFocus={() => setOpenList(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpenList(true);
          }}
        />
      )}
      {openList && !value && (
        <ul
          aria-label="Humanitix events"
          className="absolute top-full z-20 m-0 mt-1 flex max-h-80 w-full list-none flex-col overflow-auto rounded-lg border border-input bg-card p-1 shadow-md"
        >
          <li>
            <button
              type="button"
              className="w-full rounded-md px-2.5 py-2 text-left hover:bg-secondary"
              onClick={() => {
                onPick(null);
                setOpenList(false);
              }}
            >
              None
            </button>
          </li>
          {upcoming.map(row)}
          {listed && upcoming.length === 0 && (
            <li className="src px-2.5 py-2">
              {q ? `No upcoming event matches “${q}”.` : 'No upcoming Humanitix events.'}
            </li>
          )}
          {past.length > 0 && (
            <li>
              <button
                type="button"
                aria-expanded={showPast}
                className="w-full rounded-md px-2.5 py-2 text-left text-sm font-bold hover:bg-secondary"
                onClick={() => setShowPast(!showPast)}
              >
                {showPast ? '▾' : '▸'} Past events ({past.length})
              </button>
            </li>
          )}
          {showPast && past.map(row)}
          <li className="flex items-center gap-2 border-t border-input px-2.5 py-2">
            <span className="src flex-1">
              {listed?.syncedAt
                ? `Last updated ${new Date(listed.syncedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
                : 'Not synced yet'}
            </span>
            <button
              type="button"
              className="text-sm font-bold text-cta underline"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
