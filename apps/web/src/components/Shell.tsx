import { useEffect, useRef, useState, type ReactNode } from 'react';
import { RELEASE, openWhatsNew } from '../lib/release.ts';
import { Avatar, Icon, initials, Logo, Ribbon, type IconName } from './ui.tsx';

// ── Appearance (Light / Dark / System), from the sidebar or Profile ──────────
export type Theme = 'light' | 'dark' | 'system';
const THEME_KEY = 'bmg-theme';

function readTheme(fallback: Theme): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The appearance choice, saved on this device. `fallback` applies until the
 * person picks one: Headliner puts artists on the navy stage (dark) by default.
 */
export function useTheme(fallback: Theme = 'system'): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => readTheme(fallback));
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

// ── Release version at the foot of the menu; opens "What's new" ─────────────
function ReleaseFooter() {
  const title = RELEASE.commit ? `Build ${RELEASE.commit}` : undefined;
  return (
    <button
      type="button"
      onClick={openWhatsNew}
      title={title}
      className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-[#D3D8DE] hover:bg-white/5 hover:text-white"
    >
      <span>Version {RELEASE.label}</span>
      <span aria-hidden="true">·</span>
      <span className="underline underline-offset-2">What's new</span>
    </button>
  );
}

// ── Profile menu: the user's picture in the header opens a dropdown ─────────
export interface ProfileMenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
}

export function ProfileMenu({
  userName,
  roleLabel,
  avatar,
  size = 36,
  items,
  onProfile,
  onSignOut,
}: {
  userName: string;
  roleLabel: string;
  avatar?: string | null | undefined;
  size?: number;
  /** Extra rows between "Profile & preferences" and "Sign out". */
  items?: ProfileMenuItem[];
  onProfile: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const rows = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const i = rows.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === 'ArrowDown' ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
      rows[next]?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const rows: ProfileMenuItem[] = [
    { label: 'Profile & preferences', icon: 'user', onSelect: onProfile },
    ...(items ?? []),
  ];
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        // With no picture the initials are on screen, so they lead the name (WCAG 2.5.3).
        aria-label={avatar ? 'Your account' : `${initials(userName)}, your account`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={userName} src={avatar} size={size} className="!bg-cta !text-white" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Your account"
          className="absolute top-[calc(100%+8px)] right-0 z-50 flex w-64 flex-col overflow-hidden rounded-xl border border-input bg-card text-foreground shadow-md"
        >
          <div className="flex items-center gap-3 border-b border-input px-4 py-3">
            <Avatar name={userName} src={avatar} size={40} className="!bg-cta !text-white" />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-[15px]">{userName}</b>
              <span className="src block truncate">{roleLabel}</span>
            </span>
          </div>
          <div className="flex flex-col py-1">
            {rows.map((r) => (
              <button
                key={r.label}
                type="button"
                role="menuitem"
                className="flex min-h-11 items-center gap-2.5 px-4 text-left text-[15px] hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
                onClick={pick(r.onSelect)}
              >
                {r.icon && <Icon name={r.icon} size={18} className="text-muted-foreground" />}
                {r.label}
              </button>
            ))}
          </div>
          <div className="border-t border-input py-1">
            <button
              type="button"
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2.5 px-4 text-left text-[15px] font-bold hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
              onClick={pick(onSignOut)}
            >
              <Icon name="logout" size={18} className="text-muted-foreground" />
              Sign out
            </button>
          </div>
        </div>
      )}
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
  /** Whose avatar: their profile picture shows when they have one. */
  avatarArtistId?: string;
  coral?: boolean;
  badge?: string | number;
  badgeTone?: 'k' | 'w';
  /** Not built yet: shown greyed out, like the design's later screens. */
  soon?: boolean;
  /**
   * Things waiting here. On phones the three most urgent items (most waiting,
   * then lowest priority number) sit at the top of the menu.
   */
  urgent?: { waiting: number; priority: number };
  /** Phones: always in the top group, alongside the three most urgent. */
  alwaysOnTop?: boolean;
}

export interface NavSection {
  label?: string;
  /** A searchable dropdown at the top of the section, in place of one row per option. */
  picker?: NavPicker;
  items: NavItem[];
}

export interface NavPicker {
  /** Names the search box, e.g. "Find an artist workspace". */
  label: string;
  /** The trigger's text when none of the options is open. */
  placeholder: string;
  options: NavItem[];
}

/** Every word typed appears in the name, ignoring case and accents. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();
export function matchesWords(name: string, query: string): boolean {
  const n = fold(name);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => n.includes(w));
}

/**
 * Side menu: one row that opens a search box over the options (the artist
 * workspaces), instead of a row per artist. Opens in place, so it works the
 * same in the desktop sidebar and the phone menu.
 */
function WorkspacePicker({
  picker,
  current,
  onPick,
}: {
  picker: NavPicker;
  current: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = `picker-${picker.label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  const shown = picker.options.filter((o) => matchesWords(o.label, q));
  const here = picker.options.find((o) => o.id === current);
  const waiting = picker.options.reduce(
    (n, o) => n + (typeof o.badge === 'number' ? o.badge : 0),
    0,
  );

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

  const close = (refocus: boolean) => {
    setOpen(false);
    setQ('');
    if (refocus) trigger.current?.focus();
  };
  const pick = (o: NavItem) => {
    close(false);
    onPick(o.id);
  };

  return (
    <div ref={root} className="flex flex-col gap-0.5">
      <button
        ref={trigger}
        type="button"
        className="nav"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        aria-current={here ? 'page' : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {here?.avatar ? (
          <Avatar
            name={here.avatar}
            artistId={here.avatarArtistId}
            size={26}
            className="!bg-[#F1F4F7] !text-[#011935]"
          />
        ) : (
          <span className="appsq">
            <Icon name="search" size={14} strokeWidth={2.4} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{here?.label ?? picker.placeholder}</span>
        {!here && waiting > 0 && <span className="tag tk">{waiting}</span>}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`flex-none transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={`${id}-panel`} className="navpicker">
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-label={picker.label}
            aria-expanded="true"
            aria-controls={shown.length > 0 ? `${id}-list` : undefined}
            aria-autocomplete="list"
            aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
            placeholder="Type an artist’s name"
            autoComplete="off"
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
                // Close the dropdown only, not the phone menu around it.
                e.preventDefault();
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                close(true);
              }
            }}
          />
          {shown.length > 0 && (
            <ul
              id={`${id}-list`}
              role="listbox"
              aria-label={picker.label}
              className="navpicker-list"
            >
              {shown.map((o, i) => (
                <li
                  key={o.id}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={o.id === current}
                  className={`navpicker-opt ${i === active ? 'navpicker-active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                >
                  {o.avatar && (
                    <Avatar
                      name={o.avatar}
                      artistId={o.avatarArtistId}
                      size={24}
                      className="!bg-[#F1F4F7] !text-[#011935]"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.badge !== undefined && o.badge !== 0 && (
                    <span className={`tag t${o.badgeTone ?? 'k'}`}>{o.badge}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {shown.length === 0 && (
            <p className="navpicker-empty" role="status">
              {picker.options.length === 0 ? 'No artists yet.' : `No artist matches “${q}”.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
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
  avatar,
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
  /** The user's profile picture, if they've set one. */
  avatar?: string | null | undefined;
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
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  // The phone menu behaves like a dialog: the page behind doesn't scroll, Escape
  // closes it, focus moves into it and goes back to the menu button after.
  useEffect(() => {
    if (!open) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    drawer.current?.querySelector<HTMLElement>('[aria-current="page"], button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key !== 'Tab' || !drawer.current) return;
      const items = [...drawer.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    const toDesktop = () => window.innerWidth >= 1024 && setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', toDesktop);
    const button = menuButton.current;
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', toDesktop);
      button?.focus();
    };
  }, [open]);

  // Phone menu: the unheaded items (Overview) first, then to-dos and the three most
  // urgent items, then everything else folded under headings that start collapsed
  // each time the menu opens.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const openMenu = () => {
    setExpanded(new Set());
    setOpen(true);
  };
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const byUrgency = (a: NavItem, b: NavItem) =>
    (b.urgent?.waiting ?? 0) - (a.urgent?.waiting ?? 0) ||
    (a.urgent?.priority ?? Infinity) - (b.urgent?.priority ?? Infinity);
  const all = sections.flatMap((s) => s.items).filter((item) => !item.soon);
  const pinned = [
    ...all.filter((item) => item.alwaysOnTop),
    ...all
      .filter((item) => item.urgent && !item.alwaysOnTop)
      .sort(byUrgency)
      .slice(0, 3),
  ].sort(byUrgency);
  const pinnedIds = new Set(pinned.map((item) => item.id));
  const lead = sections
    .filter((section) => !section.label)
    .flatMap((section) => section.items)
    .filter((item) => !pinnedIds.has(item.id));
  const folded = sections
    .filter((section): section is NavSection & { label: string } => !!section.label)
    .map((section) => ({
      label: section.label,
      picker: section.picker,
      items: section.items.filter((item) => !pinnedIds.has(item.id)),
    }))
    .filter((section) => section.items.length > 0 || !!section.picker);
  const picker = (section: NavSection) =>
    section.picker && <WorkspacePicker picker={section.picker} current={current} onPick={go} />;

  const navButton = (item: NavItem, square: boolean) => (
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
        <Avatar
          name={item.avatar}
          artistId={item.avatarArtistId}
          size={26}
          className="!bg-[#F1F4F7] !text-[#011935]"
        />
      ) : item.icon && square ? (
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
  );

  const sidebar = (phone: boolean) => (
    <nav
      aria-label="Main"
      className="bp flex h-full flex-col gap-0.5 overflow-x-hidden px-3.5 pt-[18px] pb-3.5"
    >
      <Ribbon text="STUDIO ★ ALL ACCESS" className="-mx-8 mt-2 mb-3" />
      <button type="button" className="mb-[14px] px-2 text-left" onClick={() => go('overview')}>
        <Logo />
      </button>
      {phone ? (
        <>
          {lead.length > 0 && (
            <div className="mb-1 flex flex-col gap-0.5">
              {lead.map((item) => navButton(item, false))}
            </div>
          )}
          {pinned.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <div className="navlabel">NEEDS ATTENTION</div>
              {pinned.map((item) => navButton(item, true))}
            </div>
          )}
          {folded.map((section) => {
            const isOpen = expanded.has(section.label);
            const id = `nav-${section.label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
            const waiting = section.items.reduce((n, item) => n + (item.urgent?.waiting ?? 0), 0);
            const here =
              section.items.some((item) => item.id === current) ||
              !!section.picker?.options.some((item) => item.id === current);
            return (
              <div key={section.label} className="flex flex-col gap-0.5">
                <button
                  type="button"
                  className="navlabel navgroup"
                  aria-expanded={isOpen}
                  aria-controls={id}
                  onClick={() => toggle(section.label)}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{section.label}</span>
                  {!isOpen && here && <span className="sr-only">(current page is here)</span>}
                  {!isOpen && here && (
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-[#F1F4F7]" />
                  )}
                  {!isOpen && waiting > 0 && <span className="tag tk">{waiting}</span>}
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`flex-none transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {isOpen && (
                  <div id={id} className="flex flex-col gap-0.5">
                    {picker(section)}
                    {section.items.map((item) => navButton(item, true))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      ) : (
        sections.map((section, i) => (
          <div key={section.label ?? i} className="flex flex-col gap-0.5">
            {section.label && <div className="navlabel">{section.label}</div>}
            {picker(section)}
            {section.items.map((item) => navButton(item, !!section.label))}
          </div>
        ))
      )}
      <div className="mt-auto pt-5">
        <AppearanceSwitch theme={theme} onChange={onTheme} />
        <ReleaseFooter />
      </div>
    </nav>
  );

  return (
    <div className="bmg-frame flex min-h-dvh bg-background text-foreground">
      <SkipLink />
      <div className="sticky top-0 hidden h-dvh w-[264px] flex-none overflow-y-auto lg:block">
        {sidebar(false)}
      </div>
      {open && (
        <div
          ref={drawer}
          className="fixed inset-0 z-40 flex lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <div className="drawer relative h-full w-[min(288px,85vw)] overflow-y-auto overscroll-contain bg-[#011935] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-md">
            <button
              type="button"
              className="absolute top-[max(16px,env(safe-area-inset-top))] right-2.5 z-10 flex size-10 items-center justify-center rounded-lg text-[#D3D8DE] hover:bg-white/10 hover:text-white"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
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
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
            {sidebar(true)}
          </div>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="drawer-scrim flex-1 bg-[#011935]/45"
            onClick={() => setOpen(false)}
          />
        </div>
      )}
      <div className="bmg-col flex min-w-0 flex-1 flex-col">
        <header className="topbar flex-wrap max-sm:px-4">
          <button
            ref={menuButton}
            type="button"
            className="ibtn lg:hidden"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={openMenu}
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
            className="search max-w-[380px] flex-1 opacity-70 max-sm:hidden"
            title="Search arrives with the assistant"
          >
            <Icon name="search" size={16} className="text-muted-foreground" />
            <span className="sr-only">Search</span>
            <input type="search" placeholder="Search artists, files, messages" disabled />
            <span className="kbd">/</span>
          </label>
          <div className="ml-auto flex items-center gap-2.5">
            <button
              type="button"
              className="askbtn"
              disabled={!onAsk}
              title={onAsk ? 'Ask BMG (⌘K)' : 'The assistant is not available'}
              onClick={onAsk}
            >
              <Icon name="assistant" />
              Ask BMG
              <span className="kbd max-lg:hidden" aria-hidden="true">
                ⌘K
              </span>
            </button>
            {bell}
            {topActions}
            <ProfileMenu
              userName={userName}
              roleLabel={roleLabel}
              avatar={avatar}
              onProfile={onProfile}
              onSignOut={onSignOut}
            />
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
  const main = useRef<HTMLElement>(null);
  // Each tab starts at the top (the content area scrolls, not the window).
  useEffect(() => {
    if (main.current) main.current.scrollTop = 0;
  }, [current]);
  return (
    <div className="app-frame mx-auto flex w-full max-w-[480px] flex-col overflow-hidden bg-background text-foreground shadow-md">
      <SkipLink />
      <header className="bp flex flex-none flex-col gap-1.5 overflow-hidden px-5 pt-[calc(10px+env(safe-area-inset-top))] pr-[max(20px,env(safe-area-inset-right))] pb-3.5 pl-[max(20px,env(safe-area-inset-left))]">
        <Ribbon text="ARTIST ★ ALL ACCESS" className="-mx-8 mb-1.5" />
        {header}
      </header>
      <main
        ref={main}
        id="main"
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pt-3 pb-24 outline-none"
      >
        {children}
      </main>
      <nav aria-label="Tabs" className="tabbar relative flex flex-none">
        {onAsk && current !== 'chat' && (
          <button
            type="button"
            aria-label="Ask BMG"
            onClick={onAsk}
            className="absolute -top-[70px] right-4 flex size-14 items-center justify-center rounded-full bg-cta text-white shadow-[0_6px_16px_rgba(1,25,53,.28)]"
          >
            <Icon name="assistant" size={24} />
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
      <h1 className="poster m-0 truncate pt-0.5 text-[30px] text-white">{title}</h1>
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
    <div className="flex min-h-dvh flex-col bg-background text-foreground md:flex-row">
      <aside className="bp flex flex-col gap-3 overflow-hidden px-6 pt-[calc(20px+env(safe-area-inset-top))] pb-6 md:w-[44%] md:justify-between md:p-12">
        <div className="flex flex-col gap-4">
          <Ribbon text="ARTISTS ONLY ★ ALL ACCESS" className="-mx-12 md:-mx-16" />
          <Logo />
        </div>
        <div className="flex flex-col gap-2 md:mb-16">
          <span className="eyebrow !text-[#E8726E]">{eyebrow}</span>
          <h1 className="poster m-0 text-[34px] text-white md:text-[60px]">{title}</h1>
          {sub && <p className="m-0 text-[15px] text-[#D3D8DE] md:text-[17px]">{sub}</p>}
        </div>
        <p className="m-0 hidden text-[13px] text-[#D3D8DE] md:block">
          Build · Connect · Grow — Blueprint Music Group, Melbourne
        </p>
      </aside>
      <main className="flex flex-1 items-start justify-center p-4 pb-[calc(16px+env(safe-area-inset-bottom))] md:items-center md:p-10">
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
