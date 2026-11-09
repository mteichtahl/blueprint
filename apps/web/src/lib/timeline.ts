/**
 * Plan timeline (Gantt) layout, kept free of React so the plan screen and the
 * PDF export draw the same thing. Dates are 'YYYY-MM-DD'; x is in pixels.
 */

export type Zoom = 'week' | 'month' | 'quarter';
export const PX_PER_DAY: Record<Zoom, number> = { week: 22, month: 6, quarter: 2.2 };

interface PhaseIn {
  id: string;
  name: string;
  start?: string;
  end?: string;
  milestones: { id: string; title: string; done: boolean; due?: string }[];
}

export interface TimelineRow {
  kind: 'phase' | 'milestone';
  id: string;
  label: string;
  phaseIndex: number;
  /** Phases: the bar. */
  x1?: number;
  x2?: number;
  /** Milestones: the diamond. */
  x?: number;
  done?: boolean;
  /** Not drawn on the chart: no dates yet. */
  unscheduled: boolean;
  dateLabel: string;
}
export interface Timeline {
  from: string;
  to: string;
  width: number;
  rows: TimelineRow[];
  ticks: { x: number; label: string; major: boolean }[];
  todayX: number | null;
  unscheduled: { phase: string; title: string }[];
}

const DAY = 86_400_000;
const toDay = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY;
const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
export const shortDay = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

/** First day to draw: the Monday (week), 1st of month (month) or quarter start before `d`. */
function floorTo(d: string, zoom: Zoom): string {
  if (zoom === 'week') {
    const n = toDay(d);
    const dow = (new Date(n * DAY).getUTCDay() + 6) % 7;
    return fromDay(n - dow);
  }
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7) - 1;
  const mm = zoom === 'quarter' ? m - (m % 3) : m;
  return new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 10);
}

export function layoutTimeline(
  phases: readonly PhaseIn[],
  zoom: Zoom,
  today: string,
): Timeline | null {
  const dates = phases
    .flatMap((p) => [p.start, p.end, ...p.milestones.map((m) => m.due)])
    .filter((d): d is string => !!d)
    .sort();
  if (dates.length === 0) return null;
  const px = PX_PER_DAY[zoom];
  const from = floorTo(dates[0]!, zoom);
  // A little room after the last date.
  const to = fromDay(toDay(dates.at(-1)!) + (zoom === 'week' ? 7 : zoom === 'month' ? 21 : 45));
  const x = (d: string) => Math.round((toDay(d) - toDay(from)) * px);
  const width = x(to);

  const rows: TimelineRow[] = [];
  const unscheduled: Timeline['unscheduled'] = [];
  phases.forEach((p, pi) => {
    const start = p.start ?? p.end;
    const end = p.end ?? p.start;
    const has = !!start && !!end;
    rows.push({
      kind: 'phase',
      id: p.id,
      label: `${pi + 1}. ${p.name}`,
      phaseIndex: pi,
      ...(has ? { x1: x(start), x2: Math.max(x(end) + Math.round(px), x(start) + 4) } : {}),
      unscheduled: !has,
      dateLabel: has ? `${shortDay(start)} – ${shortDay(end)}` : 'No dates yet',
    });
    if (!has) unscheduled.push({ phase: p.name, title: 'Stage dates' });
    for (const m of p.milestones) {
      rows.push({
        kind: 'milestone',
        id: m.id,
        label: m.title,
        phaseIndex: pi,
        ...(m.due ? { x: x(m.due) + Math.round(px / 2) } : {}),
        done: m.done,
        unscheduled: !m.due,
        dateLabel: m.due ? shortDay(m.due) : 'No date',
      });
      if (!m.due) unscheduled.push({ phase: p.name, title: m.title });
    }
  });

  const ticks: Timeline['ticks'] = [];
  if (zoom === 'week') {
    for (let d = from; d <= to; d = fromDay(toDay(d) + 7)) {
      ticks.push({ x: x(d), label: shortDay(d), major: +d.slice(8, 10) <= 7 });
    }
  } else {
    const step = zoom === 'quarter' ? 3 : 1;
    let y = +from.slice(0, 4);
    let m = +from.slice(5, 7) - 1;
    for (;;) {
      const d = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
      if (d > to) break;
      const label =
        zoom === 'quarter'
          ? `Q${Math.floor(m / 3) + 1} ${y}`
          : new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', {
              month: 'short',
              ...(m === 0 || ticks.length === 0 ? { year: 'numeric' } : {}),
            });
      ticks.push({ x: x(d), label, major: m === 0 });
      m += step;
      if (m > 11) {
        m -= 12;
        y += 1;
      }
    }
  }

  return {
    from,
    to,
    width,
    rows,
    ticks,
    todayX: today >= from && today <= to ? x(today) + Math.round(px / 2) : null,
    unscheduled,
  };
}
