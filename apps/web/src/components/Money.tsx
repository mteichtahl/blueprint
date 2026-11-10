import { useState } from 'react';
import { Button, Notice } from './ui.tsx';

/**
 * Tickets sold, takings (tickets and door, plus merchandise) and costs, with
 * profit worked out (rev 7).
 * Costs start with the preset rows; any row can be deleted and more added.
 * All amounts are cents (AUD).
 */

export const PRESET_COSTS = [
  'Venue',
  'Photography',
  'Videography',
  'Content',
  'Support band',
  'Backing band',
] as const;
/** Gigs also start with a Merchandise cost (stock, printing), set against merch sales. */
export const GIG_PRESET_COSTS = [...PRESET_COSTS, 'Merchandise'] as const;
const MERCH = 'Merchandise';

export interface CostRow {
  id: string;
  label: string;
  amountCents: number;
}
export interface MoneyFigures {
  ticketsSold: number;
  /** Ticket and door takings. */
  takingsCents: number;
  /** Merchandise sold at the gig (missing on figures saved before it existed). */
  merchTakingsCents?: number;
  costs: CostRow[];
}

export const defaultMoney = (): MoneyFigures => ({
  ticketsSold: 0,
  takingsCents: 0,
  merchTakingsCents: 0,
  costs: GIG_PRESET_COSTS.map((label, i) => ({ id: `p${i + 1}`, label, amountCents: 0 })),
});

/** "$1,250" or "$1,250.50"; losses as "−$300". */
export const aud = (cents: number) => {
  const abs = Math.abs(cents);
  const s = `$${(abs / 100).toLocaleString('en-AU', {
    minimumFractionDigits: abs % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
  return cents < 0 ? `−${s}` : s;
};

/** "1,250.50" or "$1250" → 125050; blank → 0; anything else → null. */
export function toCents(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '');
  if (t === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
const fromCents = (c: number) => (c ? (c / 100).toFixed(c % 100 ? 2 : 0) : '');

/** Same sums as the API's moneySummary. */
export function summary(m: MoneyFigures) {
  const merch = m.merchTakingsCents ?? 0;
  const costsCents = m.costs.reduce((n, c) => n + c.amountCents, 0);
  const merchCostCents = m.costs
    .filter((c) => c.label.toLowerCase() === MERCH.toLowerCase())
    .reduce((n, c) => n + c.amountCents, 0);
  const totalTakingsCents = m.takingsCents + merch;
  return {
    costsCents,
    merchCostCents,
    totalTakingsCents,
    profitCents: totalTakingsCents - costsCents,
    merchProfitCents: merch - merchCostCents,
    perTicketCents: m.ticketsSold > 0 ? Math.round(m.takingsCents / m.ticketsSold) : null,
  };
}

/** Figures saved before merchandise existed get its cost row (at $0) when opened. */
function withMerchRow(m: MoneyFigures): MoneyFigures {
  if (m.merchTakingsCents !== undefined || m.costs.some((c) => c.label === MERCH)) return m;
  return { ...m, costs: [...m.costs, { id: newRowId(), label: MERCH, amountCents: 0 }] };
}

let rowSeq = 0;
const newRowId = () => `c${Date.now().toString(36)}${(rowSeq++).toString(36)}`;

const cell =
  'min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base shadow-xs outline-none focus:ring-[3px] focus:ring-[rgba(1,25,53,0.22)]';

/** The money editor for a gig: one Save sends the whole set of figures. */
export function MoneyEditor({
  value,
  onSave,
  canEdit = true,
}: {
  value: MoneyFigures | null | undefined;
  onSave: (m: MoneyFigures) => Promise<void>;
  canEdit?: boolean;
}) {
  const start = value ? withMerchRow(value) : defaultMoney();
  const [tickets, setTickets] = useState(start.ticketsSold ? String(start.ticketsSold) : '');
  const [takings, setTakings] = useState(fromCents(start.takingsCents));
  const [merch, setMerch] = useState(fromCents(start.merchTakingsCents ?? 0));
  const [rows, setRows] = useState(
    start.costs.map((c) => ({ id: c.id, label: c.label, amount: fromCents(c.amountCents) })),
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const ticketsN =
    tickets.trim() === '' ? 0 : /^\d+$/.test(tickets.trim()) ? Number(tickets) : null;
  const takingsC = toCents(takings);
  const merchC = toCents(merch);
  const costCents = rows.map((r) => toCents(r.amount));
  const bad =
    ticketsN === null || takingsC === null || merchC === null || costCents.some((c) => c === null);
  const missingLabel = rows.some((r) => !r.label.trim());
  const figures: MoneyFigures | null = bad
    ? null
    : {
        ticketsSold: ticketsN!,
        takingsCents: takingsC!,
        merchTakingsCents: merchC!,
        costs: rows.map((r, i) => ({
          id: r.id,
          label: r.label.trim(),
          amountCents: costCents[i]!,
        })),
      };
  const sum = figures ? summary(figures) : null;

  async function save() {
    if (!figures) return;
    setBusy(true);
    setNote(null);
    try {
      await onSave(figures);
      setNote({ tone: 'success', text: 'Figures saved.' });
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <label className="flex flex-col gap-1.5">
        <span className="text-[15px] font-bold">Tickets sold</span>
        <input
          className={`${cell} max-w-[12rem]`}
          inputMode="numeric"
          disabled={!canEdit}
          value={tickets}
          placeholder="0"
          aria-invalid={ticketsN === null}
          onChange={(e) => setTickets(e.target.value)}
        />
      </label>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-[15px] font-bold">Takings</legend>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="src">Tickets and door ($)</span>
            <input
              className={cell}
              inputMode="decimal"
              disabled={!canEdit}
              value={takings}
              placeholder="0"
              aria-invalid={takingsC === null}
              onChange={(e) => setTakings(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="src">Merchandise sales ($)</span>
            <input
              className={cell}
              inputMode="decimal"
              disabled={!canEdit}
              value={merch}
              placeholder="0"
              aria-invalid={merchC === null}
              onChange={(e) => setMerch(e.target.value)}
            />
          </label>
        </div>
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-[15px] font-bold">Costs</legend>
        {rows.length === 0 && <p className="src m-0">No costs. Add one below.</p>}
        {rows.map((r, i) => (
          <div key={r.id} className="flex items-center gap-2">
            <input
              className={`${cell} flex-[2]`}
              aria-label={`Cost ${i + 1} name`}
              disabled={!canEdit}
              value={r.label}
              placeholder="What was it?"
              onChange={(e) =>
                setRows(rows.map((x) => (x.id === r.id ? { ...x, label: e.target.value } : x)))
              }
            />
            <input
              className={`${cell} flex-1`}
              aria-label={`${r.label || `Cost ${i + 1}`} amount ($)`}
              inputMode="decimal"
              disabled={!canEdit}
              value={r.amount}
              placeholder="$0"
              aria-invalid={costCents[i] === null}
              onChange={(e) =>
                setRows(rows.map((x) => (x.id === r.id ? { ...x, amount: e.target.value } : x)))
              }
            />
            {canEdit && (
              <button
                type="button"
                className="min-h-11 rounded-lg px-2 text-sm font-bold underline"
                aria-label={`Delete ${r.label || 'this cost'}`}
                onClick={() => setRows(rows.filter((x) => x.id !== r.id))}
              >
                Delete
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRows([...rows, { id: newRowId(), label: '', amount: '' }])}
            >
              + Add a cost
            </Button>
            {GIG_PRESET_COSTS.some((p) => !rows.some((r) => r.label === p)) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setRows([
                    ...rows,
                    ...GIG_PRESET_COSTS.filter((p) => !rows.some((r) => r.label === p)).map(
                      (p) => ({
                        id: newRowId(),
                        label: p,
                        amount: '',
                      }),
                    ),
                  ])
                }
              >
                Add back standard costs
              </Button>
            )}
          </div>
        )}
      </fieldset>
      <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg bg-secondary p-3 text-[15px]">
        <dt className="src">Tickets and door</dt>
        <dd className="src m-0 text-right">{takingsC === null ? '—' : aud(takingsC)}</dd>
        <dt className="src">Merchandise</dt>
        <dd className="src m-0 text-right">{merchC === null ? '—' : aud(merchC)}</dd>
        <dt>Total takings</dt>
        <dd className="m-0 text-right">{sum ? aud(sum.totalTakingsCents) : '—'}</dd>
        <dt>Total costs</dt>
        <dd className="m-0 text-right">{sum ? aud(sum.costsCents) : '—'}</dd>
        <dt className="font-bold">Profit</dt>
        <dd
          className={`m-0 text-right font-bold ${sum && sum.profitCents < 0 ? 'text-[#8E2F2C]' : ''}`}
        >
          {sum ? aud(sum.profitCents) : '—'}
          {sum && sum.profitCents < 0 && ' (loss)'}
        </dd>
        {sum && (merchC || sum.merchCostCents) ? (
          <>
            <dt className="src">Merchandise profit (sales − merch cost)</dt>
            <dd
              className={`src m-0 text-right ${sum.merchProfitCents < 0 ? 'text-[#8E2F2C]' : ''}`}
            >
              {aud(sum.merchProfitCents)}
            </dd>
          </>
        ) : null}
        {sum?.perTicketCents != null && (
          <>
            <dt className="src">Ticket takings per ticket</dt>
            <dd className="src m-0 text-right">{aud(sum.perTicketCents)}</dd>
          </>
        )}
      </dl>
      {bad && <Notice tone="error">Use numbers only, like 1250 or 1,250.50.</Notice>}
      {canEdit && (
        <Button variant="navy" disabled={busy || bad || missingLabel} onClick={() => void save()}>
          Save figures
        </Button>
      )}
    </div>
  );
}
