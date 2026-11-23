import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './ui.tsx';

export interface SearchOption {
  id: string;
  label: string;
  /** Muted text on the right ("+61", "Artist"). */
  hint?: string;
  /** Left of the label: a code chip or an avatar. */
  lead?: ReactNode;
}

/**
 * A drop-down with a search box (rev 21): the consultation form's country
 * list and the artist picker on an enquiry. A button shows the choice; it
 * opens a panel with a search box and the matching options, worked by
 * keyboard (↑ ↓ Enter Esc) as an ARIA combobox.
 */
export function SearchSelect({
  label,
  value,
  options,
  onChange,
  search,
  pinned,
  pinnedLabel = 'Most chosen',
  placeholder = 'Choose…',
  searchLabel,
  error,
  hint,
  emptyText = (q) => `Nothing matches “${q}”.`,
}: {
  label: string;
  value: string | null;
  options: SearchOption[];
  onChange: (id: string) => void;
  /** Filters and orders the options for what's typed (default: the label contains it). */
  search?: (query: string, options: SearchOption[]) => SearchOption[];
  /** Shown first, under their own heading, when nothing is typed. */
  pinned?: SearchOption[];
  pinnedLabel?: string;
  placeholder?: string;
  searchLabel?: string;
  error?: string | null;
  hint?: string;
  emptyText?: (query: string) => string;
  /** Shown in the label as a required field (buttons can't carry aria-required). */
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const chosen = options.find((o) => o.id === value);

  const filter =
    search ??
    ((query: string, all: SearchOption[]) =>
      all.filter((o) => o.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const matches = filter(q, options);
  const showPinned = !q.trim() && pinned && pinned.length > 0;
  const shown = showPinned
    ? [...pinned, ...matches.filter((o) => !pinned.some((p) => p.id === o.id))]
    : matches;

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    setQ('');
    if (refocus) trigger.current?.focus();
  };
  const pick = (o: SearchOption) => {
    onChange(o.id);
    close(true);
  };

  const option = (o: SearchOption, i: number) => (
    <li
      key={`${i}-${o.id}`}
      id={`${id}-opt-${i}`}
      data-index={i}
      role="option"
      aria-selected={o.id === value}
      className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[12px] px-2.5 text-[15px] ${
        i === active ? 'bg-primary text-primary-foreground' : ''
      }`}
      onMouseEnter={() => setActive(i)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pick(o)}
    >
      {o.lead}
      <span className={`min-w-0 flex-1 truncate ${o.id === value ? 'font-bold' : ''}`}>
        {o.label}
      </span>
      {o.hint && (
        <span className={`text-sm ${i === active ? '' : 'text-muted-foreground'}`}>{o.hint}</span>
      )}
    </li>
  );

  return (
    <div ref={root} className="relative flex min-w-0 flex-col gap-1.5">
      <span id={`${id}-label`} className="text-[15px] font-bold">
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-[14px] border-2 bg-white px-3.5 text-left text-base text-[#011935] outline-none focus:ring-[3px] focus:ring-[rgba(1,25,53,0.22)] ${
          error ? 'border-[#B5403C]' : 'border-input'
        }`}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span id={`${id}-value`} className={`min-w-0 truncate ${chosen ? '' : 'text-[#66707C]'}`}>
          {chosen ? chosen.label : placeholder}
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1.5 flex flex-col gap-1.5 rounded-[18px] border-2 border-[#011935] bg-white p-2 text-[#011935] shadow-[4px_4px_0_#011935]">
          <span className="ss-search flex min-h-11 items-center gap-2 rounded-full border-2 border-[#011935] px-3">
            <Icon name="search" size={16} />
            <input
              ref={input}
              type="search"
              role="combobox"
              aria-label={searchLabel ?? `Search ${label.toLowerCase()}`}
              aria-expanded="true"
              aria-controls={shown.length ? `${id}-list` : undefined}
              aria-autocomplete="list"
              aria-activedescendant={shown[active] ? `${id}-opt-${active}` : undefined}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-base"
              placeholder="Type to search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((i) => Math.min(i + 1, shown.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (shown[active]) pick(shown[active]);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  close(true);
                } else if (e.key === 'Tab') {
                  close(false);
                }
              }}
            />
          </span>
          {shown.length > 0 ? (
            <ul
              ref={listRef}
              id={`${id}-list`}
              role="listbox"
              aria-label={label}
              className="m-0 flex max-h-[280px] list-none flex-col overflow-y-auto p-0"
            >
              {showPinned && (
                <li role="presentation" className="eyebrow px-2.5 pt-1.5 pb-1 !text-[#4A5562]">
                  {pinnedLabel}
                </li>
              )}
              {shown.slice(0, showPinned ? pinned.length : 0).map(option)}
              {showPinned && (
                <li role="presentation" className="eyebrow px-2.5 pt-2.5 pb-1 !text-[#4A5562]">
                  All
                </li>
              )}
              {shown
                .slice(showPinned ? pinned.length : 0)
                .map((o, j) => option(o, j + (showPinned ? pinned.length : 0)))}
            </ul>
          ) : (
            <p role="status" className="m-0 px-2.5 py-3 text-[15px] text-[#4A5562]">
              {emptyText(q)}
            </p>
          )}
          <p className="m-0 px-2.5 pb-1 text-[13px] text-[#4A5562]" aria-hidden="true">
            ↑ ↓ to move · Enter to choose · Esc to close
          </p>
        </div>
      )}
      {error ? (
        <span id={`${id}-error`} className="text-sm font-bold text-[#B5403C]">
          {error}
        </span>
      ) : (
        hint && (
          <span id={`${id}-hint`} className="src">
            {hint}
          </span>
        )
      )}
    </div>
  );
}
