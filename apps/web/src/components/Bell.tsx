import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
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
  const panel = useRef<HTMLDivElement>(null);
  // The list opens on top of everything, just under the bell. It's rendered at
  // the end of the page (a portal) so no header, chat or scrolling area can
  // clip it or cover it (the artist header hides its overflow).
  const [place, setPlace] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const put = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const width = Math.min(360, vw - 24);
      const right = Math.max(12, vw - r.right);
      setPlace({ top: r.bottom + 8, right: Math.min(right, vw - width - 12), width });
    };
    put();
    window.addEventListener('resize', put);
    return () => window.removeEventListener('resize', put);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
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
      {open &&
        createPortal(
          <div
            ref={panel}
            role="region"
            aria-label="Notifications"
            style={place}
            className="card fixed z-[70] max-h-[70vh] gap-2 overflow-y-auto overscroll-contain p-3 text-foreground shadow-md"
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}
