import { useEffect, useRef, useState } from 'react';
import { REAUTH_EVENT } from '../lib/api.ts';
import { Button } from './ui.tsx';

/**
 * One app-wide "Confirm it's you" prompt. Admin actions need a sign-in in the
 * last 5 minutes (design 6.3); whenever the API refuses one for that reason,
 * on any screen, this offers to sign in again. "Not now" just closes it.
 */
export function ReauthPrompt({ onReauth }: { onReauth: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(REAUTH_EVENT, show);
    return () => window.removeEventListener(REAUTH_EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector('button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={box}
      role="alertdialog"
      aria-labelledby="reauth-title"
      aria-describedby="reauth-text"
      className="card fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-col gap-3 shadow-lg"
    >
      <h2 id="reauth-title" className="poster m-0 text-[20px] leading-none">
        Confirm it’s you
      </h2>
      <p id="reauth-text" className="m-0 text-sm leading-snug">
        Admin changes need a sign-in in the last 5 minutes. Sign in again, then try that again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="cta" size="sm" onClick={onReauth}>
          Sign in again
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Not now
        </Button>
      </div>
    </div>
  );
}
