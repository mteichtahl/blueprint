import { useEffect, useRef, useState } from 'react';
import type { AppNotification } from '../lib/notifications.ts';
import { Icon } from './ui.tsx';

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`;
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
};

/** Notification bell with a count dot and a dropdown list (design: top bar). */
export function Bell({
  items,
  unread,
  onOpen,
  onMarkAll,
  light = false,
}: {
  items: AppNotification[];
  unread: number;
  onOpen: (n: AppNotification) => void;
  onMarkAll: () => void;
  /** On the navy phone header. */
  light?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        className={`ibtn ${light ? '!text-[#F1F4F7] hover:!bg-white/10' : ''}`}
        aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" size={20} />
        {unread > 0 && (
          <span className={`dot ${light ? '!border-[#011935]' : ''}`}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="card absolute right-0 z-30 mt-2 max-h-[70vh] w-[min(360px,90vw)] gap-2 overflow-y-auto overscroll-contain p-3 text-foreground shadow-md max-sm:fixed max-sm:inset-x-3 max-sm:top-[72px] max-sm:mt-0 max-sm:w-auto">
          <div className="card-hd px-1">
            <b className="t text-[17px]">Notifications</b>
            {unread > 0 && (
              <button
                type="button"
                className="ml-auto text-sm font-bold underline"
                onClick={onMarkAll}
              >
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 && <p className="src px-1 pb-2">You're all caught up.</p>}
          <div className="flex max-h-[60vh] flex-col overflow-y-auto">
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpen(n);
                }}
                className="flex gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-secondary"
              >
                <span
                  className={`mt-1.5 size-2 flex-none rounded-full ${n.read ? 'bg-transparent' : 'bg-cta'}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <b className="block text-[15px] leading-snug">{n.title}</b>
                  <span className="src block">{n.body}</span>
                </span>
                <span className="src flex-none">{ago(n.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
