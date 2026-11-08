import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/** Minimal shadcn-style primitives with the BMG tokens. */

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'cta' | 'ghost' }) {
  const styles = {
    primary: 'bg-primary text-primary-foreground hover:opacity-90',
    cta: 'bg-cta text-white hover:bg-cta-hover shadow-[0_2px_6px_-2px_rgba(181,64,60,.45)]',
    ghost: 'bg-transparent text-foreground hover:bg-secondary',
  }[variant];
  return (
    <button
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold shadow-2xs transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Card({
  title,
  children,
  className = '',
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-border bg-gradient-to-b from-white to-[#fafbfc] p-6 shadow-xs ${className}`}
    >
      {title && <h2 className="mb-4 font-title text-xl">{title}</h2>}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold">{label}</span>
      <input
        className="h-10 w-full rounded-md border border-input bg-white px-3 text-sm shadow-xs outline-none focus:ring-[3px] focus:ring-[rgba(1,25,53,0.22)]"
        {...props}
      />
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
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
    info: 'border-border bg-secondary',
    error: 'border-destructive/40 bg-destructive/10 text-destructive',
    success: 'border-emerald-700/30 bg-emerald-50 text-emerald-900',
  }[tone];
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-md border px-3 py-2 text-sm ${styles}`}
    >
      {children}
    </p>
  );
}

export function Wordmark({ light = false }: { light?: boolean }) {
  return (
    <span
      className={`font-logo text-sm tracking-[0.2em] ${light ? 'text-primary-foreground' : 'text-foreground'}`}
    >
      BLUEPRINT
    </span>
  );
}
