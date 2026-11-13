import { useEffect, useRef, useState } from 'react';
import { useAvatarSrc } from './avatars.tsx';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/**
 * BMG primitives, matching the design canvas (bmg-ui.css) and the screens
 * doc: shadcn-style radius and navy-tinted shadows, Brand Kit colours and fonts.
 */

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'cta' | 'ghost' | 'navy';
  size?: 'md' | 'sm';
}) {
  const styles = {
    default: 'border-foreground bg-card text-foreground hover:bg-[#F6F8FA] dark:hover:bg-secondary',
    ghost: 'border-input bg-card text-foreground hover:bg-[#F6F8FA] dark:hover:bg-secondary',
    navy: 'border-primary bg-primary text-primary-foreground hover:opacity-90',
    // Headliner: light coral with navy text and a solid navy offset shadow.
    cta: 'border-[#011935] bg-pop text-pop-foreground hover:bg-pop-hover shadow-[3px_3px_0_#011935] dark:border-pop dark:shadow-none',
  }[variant];
  const sizes = {
    md: 'min-h-11 px-5 text-[15px]',
    sm: 'min-h-[38px] px-3.5 text-sm whitespace-nowrap',
  }[size];
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-full border-2 font-title font-extrabold transition ${size === 'md' ? 'tracking-[.03em] uppercase' : 'tracking-[.01em]'} disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${sizes} ${className}`}
      {...props}
    />
  );
}

export function Card({
  title,
  action,
  footer,
  children,
  className = '',
}: {
  title?: ReactNode;
  /** Right side of the header row: a status chip, link or icon button. */
  action?: ReactNode;
  /** Full-width footer link (card anatomy). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-hd">
          {typeof title === 'string' ? (
            <h2 className="poster text-[20px] leading-none">{title}</h2>
          ) : (
            title
          )}
          {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
      {footer && <div className="card-ft mt-auto">{footer}</div>}
    </section>
  );
}

const control =
  'min-h-12 w-full min-w-0 rounded-[14px] border-2 border-input bg-white px-3.5 text-base outline-none focus:ring-[3px] focus:ring-[rgba(1,25,53,0.22)]';

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[15px] font-bold">{label}</span>
      <input className={control} {...props} />
      {hint && <span className="src">{hint}</span>}
    </label>
  );
}

export function Select({
  label,
  options,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[15px] font-bold">{label}</span>
      <select className={control} {...props}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextArea({
  label,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[15px] font-bold">{label}</span>
      <textarea className={`${control} min-h-24 py-2.5`} {...props} />
    </label>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'success';
  children: ReactNode;
}) {
  const styles = {
    info: 'bg-secondary text-foreground',
    error: 'bg-[#FBE3E2] text-[#8E2F2C]',
    success: 'bg-[#E3F1EA] text-[#1F6F4A]',
  }[tone];
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg px-3 py-2.5 text-sm leading-snug ${styles}`}
    >
      {children}
    </p>
  );
}

/** Badge colours from the canvas: coral tint, slate, navy, deep coral, on-navy. */
export function Tag({
  tone = 's',
  children,
  className = '',
}: {
  tone?: 'c' | 's' | 'n' | 'k' | 'w';
  children: ReactNode;
  className?: string;
}) {
  return <span className={`tag t${tone} ${className}`}>{children}</span>;
}

const AVATAR_TONES = [
  'bg-primary text-primary-foreground',
  'bg-[#5C6775] text-[#F1F4F7]',
  'bg-cta text-white',
  'bg-[#E6E9ED] text-primary',
];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function Avatar({
  name,
  size = 40,
  className = '',
  src,
  artistId,
  userSub,
}: {
  name: string;
  size?: number;
  className?: string;
  /** A profile picture (data URL); the initials show when there isn't one. */
  src?: string | null | undefined;
  /** Whose avatar it is: their profile picture shows when they have one. */
  artistId?: string | null | undefined;
  userSub?: string | null | undefined;
}) {
  const tone = AVATAR_TONES[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 3];
  const ofUser = useAvatarSrc('users', src ? null : userSub);
  const ofArtist = useAvatarSrc('artists', src || ofUser ? null : artistId);
  src = src || ofUser || ofArtist;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={`av ${className} !bg-transparent object-cover`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`av ${tone} ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}

export function Bar({ pct, color = '#011935' }: { pct: number; color?: string }) {
  return (
    <div className="bar" role="presentation">
      <div
        data-ink={color === '#011935' || undefined}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
      />
    </div>
  );
}

/** The page heading block: coral eyebrow, League Spartan title, muted line. */
export function PageHeader({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head flex flex-wrap items-end gap-3">
      <div className="flex min-w-[min(280px,100%)] flex-1 flex-col gap-1.5">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="poster m-0 text-[48px] max-sm:text-[36px]">{title}</h1>
        {sub && <p className="m-0 text-base text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The official Blueprint Music Group logo (white on navy, the brand kit's
 * square file), cropped to its artwork. On light surfaces it shows as a navy
 * tile until the navy-on-white file is added to /brand.
 */
export function Logo({ light = true, compact = false }: { light?: boolean; compact?: boolean }) {
  const w = compact ? 96 : 150;
  const img = Math.round(w * 1.4267);
  return (
    <span
      className={`relative block flex-none overflow-hidden ${light ? '' : 'rounded-xl bg-[#011935]'}`}
      style={{ width: w, height: Math.round(w * 0.653) }}
    >
      <img
        src="/brand/bmg-logo-white-on-navy.png"
        alt="Blueprint Music Group"
        width={img}
        height={img}
        className="absolute max-w-none mix-blend-lighten"
        style={{ left: -Math.round(w * 0.2067), top: -Math.round(w * 0.4133) }}
      />
    </span>
  );
}

/** The Headliner wristband ribbon: decoration, hidden from screen readers. */
export function Ribbon({ text, className = '' }: { text: string; className?: string }) {
  return (
    <span aria-hidden="true" className={`ribbon ${className}`}>
      {` ${text} ★ `.repeat(4)}
    </span>
  );
}

/** The nine bars of the waveform logo: x position and full height (centred on y=30). */
const WAVE_BARS: [number, number][] = [
  [12, 6],
  [20, 18],
  [28, 34],
  [36, 16],
  [44, 46],
  [52, 26],
  [60, 12],
  [68, 22],
  [76, 6],
];

/**
 * The loading indicator: the waveform logo with its bars oscillating like a
 * sound wave. Use instead of "Loading…" text. `label` is read by screen readers.
 */
export function WaveLoader({
  label = 'Loading',
  size = 56,
  inline = false,
  className = '',
}: {
  label?: string;
  size?: number;
  inline?: boolean;
  className?: string;
}) {
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag
      role="status"
      aria-live="polite"
      className={`${inline ? 'inline-flex' : 'flex py-6'} items-center justify-center ${className}`}
    >
      <svg
        className="wave-loader"
        width={size}
        height={Math.round((size * 60) / 88)}
        viewBox="0 0 88 60"
        aria-hidden="true"
      >
        <g stroke="currentColor" strokeWidth="4" strokeLinecap="round">
          {WAVE_BARS.map(([x, h], i) => (
            <line
              key={x}
              x1={x}
              x2={x}
              y1={30 - h / 2}
              y2={30 + h / 2}
              style={{ animationDelay: `${i * 0.09 - 1.2}s` }}
            />
          ))}
        </g>
      </svg>
      <span className="sr-only">{label}</span>
    </Tag>
  );
}

/** Kept for older screens: the text wordmark. */
export function Wordmark({ light = false }: { light?: boolean }) {
  return <Logo light={light} />;
}

const ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z',
  chat: 'M4 5h16v11H8l-4 4z',
  todo: 'M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9',
  folder: 'M4 4h6l2 3h8v13H4z',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  calendar: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
  mail: 'M4 5h16v14H4zM4 7l8 6 8-6',
  phone:
    'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0zM12 18v4',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  users:
    'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  template: 'M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z',
  mic: 'M12 3a3 3 0 013 3v5a3 3 0 01-6 0V6a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v4M8 21h8',
  sparkle:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-3.5-3.5',
  // A speech bubble with a spark: the assistant ("Ask BMG").
  assistant:
    'M13 4H5a1 1 0 00-1 1v10a1 1 0 001 1h3v4l4-4h7a1 1 0 001-1v-4M18 2l.9 2.1L21 5l-2.1.9L18 8l-.9-2.1L15 5l2.1-.9z',
  help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01',
  bell: 'M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 003.4 0',
  arrow: 'M7 17L17 7M9 7h8v8',
  file: 'M6 3h8l4 4v14H6z',
  upload: 'M12 20V9M7 14l5-5 5 5M4 4h16',
  download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  filter: 'M4 6h16M7 12h10M10 18h4',
  chevrons: 'M7 15l5 5 5-5M7 9l5-5 5 5',
  back: 'M15 18l-6-6 6-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  userPlus: 'M10 12a4 4 0 100-8 4 4 0 000 8zM2 21a8 8 0 0114.5-4.6M19 14v6M16 17h6',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h11',
  record: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 9a3 3 0 100 6 3 3 0 000-6z',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 18,
  strokeWidth = 2,
  className = '',
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-none ${className}`}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** True below the phone breakpoint (640px). Tables become row cards there. */
export function usePhone(query = '(max-width: 639px)') {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true;
  const [phone, setPhone] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return phone;
}

/**
 * Data table wrapper: sits flush inside a card, as in the canvas (.dt).
 * On phones, pass `cards` (one <RowCard> per row) and they replace the table,
 * so nobody scrolls sideways to read a row.
 */
export function DataTable({
  children,
  cards,
  label,
  fit = false,
}: {
  children: ReactNode;
  /** The same rows as <RowCard>s, shown instead of the table on phones. */
  cards?: ReactNode;
  /** What the list is, for screen readers ("To-dos"). */
  label?: string;
  /** Two-column tables (label and number): on phones they keep their shape,
      fitted to the screen width, with long labels wrapping. */
  fit?: boolean;
}) {
  const phone = usePhone();
  if (phone && cards !== undefined)
    return (
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={label}>
        {cards}
      </ul>
    );
  if (phone && fit)
    return (
      <div className="-mx-5">
        <table className="dt dt-fit">{children}</table>
      </div>
    );
  return (
    // A wide table scrolls in its own box instead of widening the page: w-0 +
    // min-width keep its width out of its parents' size, and `relative` keeps
    // its screen-reader-only labels (absolutely positioned) inside the box.
    <div className="relative -mx-5 w-0 min-w-[calc(100%+2.5rem)] overflow-x-auto">
      <table className="dt">{children}</table>
    </div>
  );
}

/**
 * One table row as a phone card: up to three lines (title with a status on the
 * right, the key context, then a few tags). Tapping the card opens the row;
 * controls that act straight away (a tick box, call, a switch) sit outside
 * that tap area so they never open it by mistake.
 */
export function RowCard({
  title,
  sub,
  status,
  tags,
  lead,
  actions,
  onOpen,
  openLabel,
  accent = false,
  muted = false,
}: {
  title: ReactNode;
  sub?: ReactNode;
  /** A tag on the right of the title line. */
  status?: ReactNode;
  /** Small tags on the third line. */
  tags?: ReactNode;
  /** Left of the card: a tick box, date block, avatar or file type. */
  lead?: ReactNode;
  /** Right of the card: buttons that act at once (call, email, a switch, a menu). */
  actions?: ReactNode;
  onOpen?: () => void;
  /** Screen-reader name for the open action, when the title alone is unclear. */
  openLabel?: string;
  /** Coral left edge (overdue, needs help). */
  accent?: boolean;
  /** Done or inactive: the title is struck through and greyed. */
  muted?: boolean;
}) {
  const body = (
    <>
      <span className="flex items-start gap-2">
        <b
          className={`min-w-0 flex-1 text-[15px] leading-snug ${muted ? 'text-muted-foreground line-through' : ''}`}
        >
          {title}
        </b>
        {status && <span className="flex flex-none items-center">{status}</span>}
      </span>
      {sub && <span className="src block">{sub}</span>}
      {tags && <span className="mt-1 flex flex-wrap items-center gap-1.5">{tags}</span>}
    </>
  );
  return (
    <li
      className={`flex min-h-[52px] items-start gap-3 rounded-[10px] border border-input bg-card px-3 py-2.5 shadow-xs ${accent ? 'border-l-[3px] border-l-accent' : ''}`}
    >
      {lead && <span className="flex flex-none items-center self-start pt-0.5">{lead}</span>}
      {onOpen ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          onClick={onOpen}
        >
          {/* Extra words for screen readers go before the visible text, not instead
              of it, so voice control users can still say what they see (WCAG 2.5.3). */}
          {openLabel && <span className="sr-only">{openLabel}: </span>}
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">{body}</span>
      )}
      {actions && (
        <span className="flex flex-none items-center gap-1.5 self-center">{actions}</span>
      )}
    </li>
  );
}

/**
 * A full-screen panel for phones: a navy header with Back, then the content
 * scrolling on its own. Editing in a panel keeps the list put underneath, so
 * closing it lands you back where you were. Escape and Back close it; focus
 * moves into the panel and returns to whatever opened it.
 */
export function PhonePanel({
  title,
  aside,
  onClose,
  children,
}: {
  title: string;
  /** Small text on the right of the header ("From Blueprint"). */
  aside?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.body.style.overflow = scroll;
      opener?.focus?.();
    };
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-background outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="bp flex min-h-14 flex-none items-center gap-2 px-2 pt-[env(safe-area-inset-top)] text-[#F1F4F7] shadow-[0_2px_10px_rgba(1,25,53,.18)]">
        <button
          type="button"
          aria-label="Back"
          className="flex size-11 flex-none items-center justify-center"
          onClick={onClose}
        >
          <Icon name="back" />
        </button>
        <h2 className="t min-w-0 flex-1 truncate text-[19px] text-white">{title}</h2>
        {aside && <span className="flex-none pr-3 text-[13px] text-[#F1F4F7]/80">{aside}</span>}
      </header>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pt-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  );
}

/** A small square block for a date on a phone card ("DEC / 05"). */
export function DateBlock({ date }: { date: string }) {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <span className="flex w-10 flex-none flex-col items-center rounded-md bg-secondary py-1 leading-none">
      <span className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
        {d.toLocaleDateString('en-AU', { month: 'short' })}
      </span>
      <span className="t text-[17px]">{d.getDate()}</span>
    </span>
  );
}

/** A 40px round icon link for a card's quick actions (call, email). */
export function QuickLink({ href, label, icon }: { href: string; label: string; icon: IconName }) {
  return (
    <a
      href={href}
      aria-label={label}
      className="flex size-10 items-center justify-center rounded-lg border border-input bg-card text-foreground hover:bg-secondary"
    >
      <Icon name={icon} size={18} />
    </a>
  );
}

/** Quick-filter chips above tables. */
export function Chips<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { id: T; label: string }[];
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="chip min-h-8"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const shortDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
  });

/** A modal on desktop; a full-screen PhonePanel on phones (P7). */
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const phone = usePhone();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phone) return;
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => opener?.focus?.();
  }, [phone]);
  if (phone) {
    return (
      <PhonePanel title={title} onClose={onClose}>
        {children}
        {footer && <div className="flex flex-wrap gap-2 pt-2">{footer}</div>}
      </PhonePanel>
    );
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(1,25,53,.35)] p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="card flex max-h-[85vh] w-full max-w-[560px] flex-col gap-3 overflow-hidden outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="card-hd">
          <h2 className="poster text-[20px] leading-none">{title}</h2>
          <button
            type="button"
            className="ml-auto flex size-9 items-center justify-center rounded-lg hover:bg-secondary"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-1">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 pb-1">{footer}</div>}
      </div>
    </div>
  );
}
