import { useState } from 'react';
import { Chips } from './ui.tsx';
import { layoutTimeline, type Timeline, type Zoom } from '../lib/timeline.ts';

const LABEL_W = 220;
const ROW_H = 30;
const HEAD_H = 28;
/** Brand palette: navy, coral, slate, then their tints. */
const BAR_COLOURS = ['#011935', '#D9534F', '#5C6775', '#34506E', '#B5403C', '#8A94A1'];

interface PhaseIn {
  id: string;
  name: string;
  start?: string;
  end?: string;
  milestones: { id: string; title: string; done: boolean; due?: string }[];
}

/** The timeline as an SVG: label column, month or week ticks, bars, diamonds, today line. */
export function TimelineSvg({ t, title }: { t: Timeline; title: string }) {
  const h = HEAD_H + t.rows.length * ROW_H + 8;
  const w = LABEL_W + t.width + 16;
  return (
    <svg
      role="img"
      aria-label={title}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      fontFamily="'Archivo Narrow', Arial, sans-serif"
      fontSize="13"
    >
      <title>{title}</title>
      {t.ticks.map((tk, i) => (
        <g key={i}>
          <line
            x1={LABEL_W + tk.x}
            x2={LABEL_W + tk.x}
            y1={HEAD_H - 6}
            y2={h}
            stroke={tk.major ? '#C9D0D8' : '#E6E9ED'}
          />
          <text x={LABEL_W + tk.x + 4} y={16} fill="#5C6775">
            {tk.label}
          </text>
        </g>
      ))}
      {t.rows.map((r, i) => {
        const y = HEAD_H + i * ROW_H;
        const colour = BAR_COLOURS[r.phaseIndex % BAR_COLOURS.length]!;
        return (
          <g key={`${r.kind}-${r.id}`}>
            {r.kind === 'phase' && (
              <rect x={0} y={y} width={w} height={ROW_H} fill="#F1F4F7" opacity={0.6} />
            )}
            <text
              x={r.kind === 'phase' ? 8 : 22}
              y={y + ROW_H / 2 + 4}
              fill={r.kind === 'phase' ? '#011935' : '#2B3440'}
              fontWeight={r.kind === 'phase' ? 700 : 400}
              textDecoration={r.done ? 'line-through' : undefined}
            >
              {r.label.length > 30 ? `${r.label.slice(0, 29)}…` : r.label}
            </text>
            {r.kind === 'phase' && r.x1 !== undefined && r.x2 !== undefined && (
              <rect
                x={LABEL_W + r.x1}
                y={y + 7}
                width={r.x2 - r.x1}
                height={ROW_H - 14}
                rx={4}
                fill={colour}
              >
                <title>{`${r.label}: ${r.dateLabel}`}</title>
              </rect>
            )}
            {r.kind === 'milestone' && r.x !== undefined && (
              <rect
                x={LABEL_W + r.x - 6}
                y={y + ROW_H / 2 - 6}
                width={12}
                height={12}
                transform={`rotate(45 ${LABEL_W + r.x} ${y + ROW_H / 2})`}
                fill={r.done ? colour : '#FFFFFF'}
                stroke={colour}
                strokeWidth={2}
              >
                <title>{`${r.label}: ${r.dateLabel}${r.done ? ' (done)' : ''}`}</title>
              </rect>
            )}
            {r.unscheduled && (
              <text x={LABEL_W + 6} y={y + ROW_H / 2 + 4} fill="#8A94A1" fontStyle="italic">
                {r.dateLabel}
              </text>
            )}
          </g>
        );
      })}
      {t.todayX !== null && (
        <g>
          <line
            x1={LABEL_W + t.todayX}
            x2={LABEL_W + t.todayX}
            y1={HEAD_H - 6}
            y2={h}
            stroke="#B5403C"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
          <text x={LABEL_W + t.todayX + 4} y={HEAD_H - 8} fill="#B5403C" fontWeight={700}>
            Today
          </text>
        </g>
      )}
    </svg>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The plan's Timeline tab (rev 7): one bar per stage, a diamond per milestone
 * (filled when done), today's line, and week / month / quarter zoom. Dates
 * are set while editing the plan; anything without a date is listed below.
 */
export function PlanTimeline({
  phases,
  canEdit,
}: {
  phases: readonly PhaseIn[];
  canEdit: boolean;
}) {
  const [zoom, setZoom] = useState<Zoom>('month');
  const t = layoutTimeline(phases, zoom, today());
  if (!t) {
    return (
      <p className="src m-0">
        No dates on this plan yet.{' '}
        {canEdit
          ? 'Edit the plan and give each stage a start and end, and each milestone a due date.'
          : 'Blueprint adds dates to the plan.'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Chips
        label="Timeline zoom"
        value={zoom}
        onChange={setZoom}
        options={[
          { id: 'week', label: 'Weeks' },
          { id: 'month', label: 'Months' },
          { id: 'quarter', label: 'Quarters' },
        ]}
      />
      <div
        className="-mx-5 overflow-x-auto px-5"
        tabIndex={0}
        aria-label="Plan timeline, scrolls sideways"
      >
        <TimelineSvg t={t} title="Plan timeline" />
      </div>
      <p className="src m-0">
        Bars are stages; ◆ milestones (filled when done); the dashed line is today.
      </p>
      {t.unscheduled.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-muted-foreground">Unscheduled</span>
          <ul className="m-0 pl-[18px] text-[15px]">
            {t.unscheduled.map((u, i) => (
              <li key={i}>
                {u.phase}: {u.title === 'Stage dates' ? 'no start or end date' : u.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Screen readers get the same as a list. */}
      <ul className="sr-only">
        {t.rows.map((r) => (
          <li key={`${r.kind}-${r.id}`}>
            {r.label}: {r.dateLabel}
            {r.done ? ', done' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
