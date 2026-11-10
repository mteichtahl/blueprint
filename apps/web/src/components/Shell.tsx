import { useEffect, useState, type ReactNode } from 'react';
import { Avatar, Icon, Logo, type IconName } from './ui.tsx';

// ── Appearance (Light / Dark / System), from the sidebar or Profile ──────────
export type Theme = 'light' | 'dark' | 'system';
const THEME_KEY = 'bmg-theme';

function readTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle(
        'dark',
        theme === 'dark' || (theme === 'system' && media.matches),
      );
    apply();
    media.addEventListener('change', apply);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this visit.
    }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}

function AppearanceSwitch({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <div role="group" aria-label="Appearance" className="grid grid-cols-3 gap-1">
      {(['light', 'dark', 'system'] as const).map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={theme === t}
          onClick={() => onChange(t)}
          className={`flex min-h-[34px] items-center justify-center rounded-lg text-sm font-bold capitalize ${theme === t ? 'bg-[#F1F4F7] text-[#011935]' : 'bg-white/5 text-[#D3D8DE] hover:text-white'}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// ── BMG desktop shell: 264px blueprint sidebar + sticky top bar ──────────────
export interface NavItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Artist rows show an avatar instead of an icon. */
  avatar?: string;
  coral?: boolean;
  badge?: string | number;
  badgeTone?: 'k' | 'w';
  /** Not built yet: shown greyed out, like the design's later screens. */
  soon?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

export function BmgShell({
  sections,
  current,
  onNavigate,
  userName,
  roleLabel,
  theme,
  onTheme,
  onSignOut,
  onProfile,
  bell,
  topActions,
  onAsk,
  children,
}: {
  sections: NavSection[];
  current: string;
  onNavigate: (id: string) => void;
  userName: string;
  roleLabel: string;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onSignOut: () => void;
  onProfile: () => void;
  bell?: ReactNode;
  topActions?: ReactNode;
  /** Opens the assistant (button and ⌘K). */
  onAsk?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!onAsk) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onAsk();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAsk]);
  const go = (id: string) => {
    onNavigate(id);
    setOpen(false);
  };

  const sidebar = (
    <nav aria-label="Main" className="bp flex h-full flex-col gap-0.5 px-3.5 pt-[22px] pb-3.5">
      <button type="button" className="mb-[18px] px-2 text-left" onClick={() => go('overview')}>
        <Logo />
      </button>
      <button
        type="button"
        className="mb-3 flex min-h-[42px] items-center gap-2.5 rounded-[10px] border border-white/20 bg-white/5 px-2.5 text-left text-[15px] font-bold text-[#F1F4F7] hover:bg-white/10 disabled:opacity-60"
        disabled={!onAsk}
        title={onAsk ? undefined : 'The assistant is not available'}
        onClick={() => {
          setOpen(false);
          onAsk?.();
        }}
      >
        <Icon name="sparkle" />
        Ask Blueprint AI
        <span className="kbd ml-auto border-white/20 bg-white/10 text-[#D3D8DE]">⌘K</span>
      </button>
      {sections.map((section, i) => (
        <div key={section.label ?? i} className="flex flex-col gap-0.5">
          {section.label && <div className="navlabel">{section.label}</div>}
          {section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="nav"
              aria-current={current === item.id ? 'page' : undefined}
              aria-disabled={item.soon || undefined}
              title={item.soon ? 'Coming in a later release' : undefined}
              onClick={() => !item.soon && go(item.id)}
            >
              {item.avatar ? (
                <Avatar name={item.avatar} size={26} className="!bg-[#F1F4F7] !text-[#011935]" />
              ) : item.icon && section.label ? (
                <span className={`appsq ${item.coral ? 'appsq-c' : ''}`}>
                  <Icon name={item.icon} size={14} strokeWidth={2.4} />
                </span>
              ) : (
                item.icon && <Icon name={item.icon} />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badge !== undefined && item.badge !== 0 && (
                <span className={`tag t${item.badgeTone ?? 'k'}`}>{item.badge}</span>
              )}
            </button>
          ))}
        </div>
      ))}
      <div className="mt-auto pt-5">
        <AppearanceSwitch theme={theme} onChange={onTheme} />
      </div>
      <div className="ws mt-2.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          onClick={() => go('profile')}
        >
          <Avatar name={userName} size={34} className="!rounded-lg !bg-cta !text-white" />
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[15px]">{userName}</b>
            <span className="block text-[13px] text-[#D3D8DE]">{roleLabel} · Profile</span>
          </span>
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded-md px-2 py-1 text-[13px] font-bold text-[#D3D8DE] hover:bg-white/10 hover:text-white"
        >
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <SkipLink />
      <div className="sticky top-0 hidden h-screen w-[264px] flex-none overflow-y-auto lg:block">
        {sidebar}
      </div>
      {open && (
        <div className="fixed inset-0 z-20 flex lg:hidden" role="dialog" aria-label="Menu">
          <div className="h-full w-[264px] overflow-y-auto">{sidebar}</div>
          <button
            type="button"
            className="flex-1 bg-[#011935]/40"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="topbar flex-wrap max-sm:px-4">
          <button
            type="button"
            className="ibtn lg:hidden"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <label
            className="search max-w-[380px] flex-1 opacity-70"
            title="Search arrives with the assistant"
          >
            <Icon name="search" size={16} className="text-muted-foreground" />
            <span className="sr-only">Search</span>
            <input type="search" placeholder="Search artists, files, messages" disabled />
            <span className="kbd">/</span>
          </label>
          <div className="ml-auto flex items-center gap-2.5">
            {bell}
            {topActions}
            <button type="button" aria-label="Profile & preferences" onClick={onProfile}>
              <Avatar name={userName} size={36} className="!bg-cta !text-white" />
            </button>
          </div>
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="flex flex-col gap-5 px-8 pt-6 pb-11 outline-none max-sm:px-4"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

// ── Artist app: phone-first, navy blueprint header + bottom tab bar ──────────
export interface PhoneTab {
  id: string;
  label: string;
  icon: IconName;
  soon?: boolean;
}

export function ArtistShell({
  tabs,
  current,
  onNavigate,
  header,
  onAsk,
  children,
}: {
  tabs: PhoneTab[];
  current: string;
  onNavigate: (id: string) => void;
  header: ReactNode;
  /** Opted-in artists only: the floating assistant button. */
  onAsk?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[480px] flex-col bg-background text-foreground shadow-md">
      <SkipLink />
      <header className="bp flex flex-col gap-2 px-5 pt-[22px] pb-[18px]">{header}</header>
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col gap-3 px-4 py-3 pb-24 outline-none"
      >
        {children}
      </main>
      <nav
        aria-label="Tabs"
        className="fixed bottom-0 left-1/2 flex w-full max-w-[480px] -translate-x-1/2 border-t border-input bg-card pb-2"
      >
        {onAsk && (
          <button
            type="button"
            aria-label="Ask Blueprint AI"
            onClick={onAsk}
            className="absolute -top-[70px] right-4 flex size-14 items-center justify-center rounded-full bg-cta text-white shadow-[0_6px_16px_rgba(1,25,53,.28)]"
          >
            <Icon name="sparkle" size={24} />
          </button>
        )}
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className="ptab"
            aria-current={current === t.id ? 'page' : undefined}
            aria-disabled={t.soon || undefined}
            title={t.soon ? 'Coming in a later release' : undefined}
            onClick={() => !t.soon && onNavigate(t.id)}
          >
            <Icon name={t.icon} size={22} />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** Phone header content: coral eyebrow, white title, optional line and progress. */
export function PhoneHeader({
  eyebrow,
  title,
  right,
  children,
}: {
  eyebrow: string;
  title: string;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="eyebrow flex-1 !text-[#E8726E]">{eyebrow}</span>
        {right}
      </div>
      <h1 className="t m-0 text-[28px] text-white">{title}</h1>
      {children}
    </>
  );
}

/**
 * Sign-in, step-up and first-sign-in screens: the blueprint panel with the
 * logo beside a single focused card (phone: the panel becomes the header).
 */
export function AuthFrame({
  eyebrow,
  title,
  sub,
  children,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground md:flex-row">
      <aside className="bp flex flex-col gap-3 px-6 pt-7 pb-6 md:w-[44%] md:justify-between md:p-12">
        <Logo />
        <div className="flex flex-col gap-2 md:mb-16">
          <span className="eyebrow !text-[#E8726E]">{eyebrow}</span>
          <h1 className="t m-0 text-[28px] text-white md:text-[44px] md:leading-[1.05]">{title}</h1>
          {sub && <p className="m-0 text-[15px] text-[#D3D8DE] md:text-[17px]">{sub}</p>}
        </div>
        <p className="m-0 hidden text-[13px] text-[#D3D8DE] md:block">
          Build · Connect · Grow — Blueprint Music Group, Melbourne
        </p>
      </aside>
      <main className="flex flex-1 items-start justify-center p-4 md:items-center md:p-10">
        <div className="flex w-full max-w-[460px] flex-col gap-3">{children}</div>
      </main>
    </div>
  );
}

/** WCAG 2.4.1: the first Tab stop jumps past the sidebar or header to the content. */
function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only z-50 rounded-lg bg-card px-4 py-3 font-bold text-foreground shadow-md focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
    >
      Skip to main content
    </a>
  );
}
