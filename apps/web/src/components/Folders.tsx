import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import type { FileItem } from '../lib/files.ts';
import {
  atLeast,
  describeChanges,
  LEVEL_LABEL,
  LEVELS,
  listFolders,
  moveItems,
  type AccessInfo,
  type Folder,
  type FolderList,
  type ItemRef,
  type Level,
  type Summary,
} from '../lib/folders.ts';
import { Button, Field, Icon, Notice, PhonePanel, Tag, usePhone, WaveLoader } from './ui.tsx';
import { DangerArea, EditScreen, RecordPage } from './patterns.tsx';

/**
 * Folders and folder permissions (rev 10): the folder browser (tree,
 * breadcrumbs, folder rows), the Access panel, and moving things.
 * The API decides everything; these screens only show what it allows.
 */

/** The top of a library, or the "Shared with me" list. */
export type Place = string | null | 'shared';
const SHARED = 'shared' as const;

export function useFolders(cfg: AppConfig, token: string, base: string) {
  const [list, setList] = useState<FolderList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await listFolders(cfg, token, base));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, base]);
  useEffect(() => void load(), [load]);
  return { list, error, load };
}

// ── A dialog: centred on wider screens, a full page on a phone ────────────
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
          <h2 className="t text-[19px]">{title}</h2>
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

// ── Helpers ───────────────────────────────────────────────────────────────
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

/** A small "custom access" mark: this folder or file has its own setting. */
export function CustomAccess() {
  return (
    <span
      role="img"
      aria-label="Has its own access setting"
      title="Has its own access setting"
      className="inline-flex text-muted-foreground"
    >
      <Icon name="userPlus" size={15} />
    </span>
  );
}

function FolderIcon({ shared = false }: { shared?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-10 flex-none items-center justify-center rounded-[10px] ${shared ? 'bg-[#FBE3E2] text-[#8E2F2C]' : 'bg-[#DCE6F2] text-primary'}`}
    >
      <Icon name={shared ? 'users' : 'folder'} size={20} />
    </span>
  );
}

// ── Breadcrumbs ───────────────────────────────────────────────────────────
function Crumbs({
  rootLabel,
  place,
  folders,
  onGo,
  onDrop,
}: {
  rootLabel: string;
  place: Place;
  folders: Map<string, Folder>;
  onGo: (p: Place) => void;
  onDrop?: (to: string | null) => (e: React.DragEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const here = typeof place === 'string' && place !== SHARED ? folders.get(place) : undefined;
  const trail: ({ folderId: string; name: string } | null)[] = here
    ? [...here.path, { folderId: here.folderId, name: here.name }]
    : [];
  // Deep trees: the first crumb, "…", then the last two.
  const collapse = !open && trail.length > 3;
  const shownTrail = collapse ? trail.slice(-2) : trail;
  const crumb = (label: string, target: Place, current: boolean, key: string) => (
    <li key={key} className="flex items-center gap-1">
      {current ? (
        <b aria-current="page" className="[overflow-wrap:anywhere]">
          {label}
        </b>
      ) : (
        <button
          type="button"
          className="rounded px-1 underline-offset-2 hover:underline"
          onClick={() => onGo(target)}
          onDragOver={onDrop && target !== SHARED ? (e) => e.preventDefault() : undefined}
          onDrop={onDrop && target !== SHARED ? onDrop(target as string | null) : undefined}
        >
          {label}
        </button>
      )}
    </li>
  );
  const sep = (k: string) => (
    <li key={k} aria-hidden="true" className="text-muted-foreground">
      ›
    </li>
  );
  const items: ReactNode[] = [crumb(rootLabel, null, place === null, 'root')];
  if (place === SHARED) items.push(sep('s0'), crumb('Shared with me', SHARED, true, 'shared'));
  if (here && here.sharedWithMe) {
    items.push(sep('s1'), crumb('Shared with me', SHARED, false, 'shared'));
  }
  if (collapse) {
    items.push(
      sep('c'),
      <li key="more">
        <button
          type="button"
          className="rounded px-1 hover:bg-secondary"
          aria-label={`Show ${trail.length - 2} more folders in the path`}
          onClick={() => setOpen(true)}
        >
          …
        </button>
      </li>,
    );
  }
  shownTrail.forEach((c, i) => {
    items.push(sep(`s${i}x`));
    const last = i === shownTrail.length - 1;
    items.push(
      c ? (
        crumb(c.name, c.folderId, last, c.folderId)
      ) : (
        <li key={`h${i}`} className="text-muted-foreground" title="A folder you can’t open">
          …
        </li>
      ),
    );
  });
  return (
    <nav aria-label="Folder path">
      <ol className="flex flex-wrap items-center gap-1 text-[15px]">{items}</ol>
    </nav>
  );
}

// ── The tree (desktop) ────────────────────────────────────────────────────
function Tree({
  rootLabel,
  folders,
  place,
  hasShared,
  onGo,
  onDrop,
}: {
  rootLabel: string;
  folders: Folder[];
  place: Place;
  hasShared: boolean;
  onGo: (p: Place) => void;
  onDrop: (to: string | null) => (e: React.DragEvent) => void;
}) {
  const children = useMemo(() => {
    const m = new Map<string | null, Folder[]>();
    for (const f of folders) {
      const k = f.sharedWithMe ? SHARED : f.parentId;
      m.set(k, [...(m.get(k) ?? []), f]);
    }
    for (const list of m.values()) list.sort(byName);
    return m;
  }, [folders]);
  const byId = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders]);
  // Open the way to where we are.
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (typeof place !== 'string' || place === SHARED) return;
    const f = byId.get(place);
    if (!f) return;
    setOpen((o) => {
      const n = new Set(o);
      for (const c of f.path) if (c) n.add(c.folderId);
      return n;
    });
  }, [place, byId]);

  const row = (f: Folder, depth: number): ReactNode => {
    const kids = children.get(f.folderId) ?? [];
    const isOpen = open.has(f.folderId);
    return (
      <li
        key={f.folderId}
        role="treeitem"
        aria-expanded={kids.length ? isOpen : undefined}
        aria-selected={place === f.folderId}
      >
        <div
          className={`flex min-h-9 items-center gap-1 rounded-lg pr-2 ${place === f.folderId ? 'bg-[#DCE6F2] font-bold' : 'hover:bg-secondary'}`}
          style={{ paddingLeft: Math.min(depth, 12) * 14 + 4 }}
          onDragOver={atLeast(f.level, 'edit') ? (e) => e.preventDefault() : undefined}
          onDrop={atLeast(f.level, 'edit') ? onDrop(f.folderId) : undefined}
        >
          <button
            type="button"
            className="flex size-6 flex-none items-center justify-center text-muted-foreground"
            aria-label={isOpen ? `Close ${f.name}` : `Open ${f.name}`}
            tabIndex={kids.length ? 0 : -1}
            style={{ visibility: kids.length ? 'visible' : 'hidden' }}
            onClick={() =>
              setOpen((o) => {
                const n = new Set(o);
                if (n.has(f.folderId)) n.delete(f.folderId);
                else n.add(f.folderId);
                return n;
              })
            }
          >
            {isOpen ? '▾' : '▸'}
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => onGo(f.folderId)}
          >
            <Icon name="folder" size={15} />
            <span className="truncate">{f.name}</span>
            {f.customAccess && <CustomAccess />}
          </button>
        </div>
        {isOpen && kids.length > 0 && <ul role="group">{kids.map((k) => row(k, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <nav aria-label="Folders" className="text-[15px]">
      <ul role="tree" className="flex flex-col gap-0.5">
        <li role="treeitem" aria-selected={place === null}>
          <button
            type="button"
            className={`flex min-h-9 w-full items-center gap-1.5 rounded-lg px-2 text-left ${place === null ? 'bg-[#DCE6F2] font-bold' : 'hover:bg-secondary'}`}
            onClick={() => onGo(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop(null)}
          >
            <Icon name="home" size={15} />
            {rootLabel}
          </button>
        </li>
        {(children.get(null) ?? []).map((f) => row(f, 1))}
        {hasShared && (
          <li role="treeitem" aria-selected={place === SHARED}>
            <button
              type="button"
              className={`mt-1 flex min-h-9 w-full items-center gap-1.5 rounded-lg px-2 text-left ${place === SHARED ? 'bg-[#DCE6F2] font-bold' : 'hover:bg-secondary'}`}
              onClick={() => onGo(SHARED)}
            >
              <Icon name="users" size={15} />
              Shared with me
            </button>
            {(children.get(SHARED) ?? []).length > 0 && (
              <ul role="group">{(children.get(SHARED) ?? []).map((f) => row(f, 2))}</ul>
            )}
          </li>
        )}
      </ul>
    </nav>
  );
}

// ── Moving ────────────────────────────────────────────────────────────────
/** Who gains and loses access: shown before a move or an access change is saved. */
function SummaryNotice({ s, noun }: { s: Summary; noun?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Notice tone={s.changes.some((c) => c.loses) ? 'error' : 'info'}>
        This {describeChanges(s, noun)}.
      </Notice>
      {s.changes.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {s.changes.slice(0, 8).map((c) => (
            <li key={c.sub}>
              <b>{c.name}</b>
              {c.gains > 0 && ` gains access to ${c.gains}`}
              {c.gains > 0 && c.loses > 0 && ' and'}
              {c.loses > 0 && ` loses access to ${c.loses}`}
            </li>
          ))}
          {s.changes.length > 8 && <li className="src">and {s.changes.length - 8} more</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Move to…: pick a folder (drill down from the top), see who gains and
 * loses access, then confirm. `to` is set straight away for drag and drop.
 */
export function MoveDialog({
  cfg,
  token,
  base,
  rootLabel,
  items,
  to: preset,
  onClose,
  onMoved,
}: {
  cfg: AppConfig;
  token: string;
  base: string;
  rootLabel: string;
  items: ItemRef[];
  to?: string | null;
  onClose: () => void;
  /** Done: where it went (null is the top) and that folder's name. */
  onMoved: (to: string | null, name: string) => void;
}) {
  const { list, error: loadError } = useFolders(cfg, token, base);
  // Callers often pass a new array on every render. Key the check on what is
  // being moved, so a redraw around the dialog doesn't restart it (which
  // turned "Move to …" off again while it reloaded).
  const itemsKey = items.map((i) => `${i.kind}:${i.id}`).join(',');
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [at, setAt] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null | undefined>(preset);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moving = new Set(items.filter((i) => i.kind === 'folder').map((i) => i.id));
  const byId = new Map((list?.folders ?? []).map((f) => [f.folderId, f]));
  // A folder can't go into itself or anything inside it.
  const blocked = (f: Folder) =>
    moving.has(f.folderId) || f.path.some((p) => p && moving.has(p.folderId));

  useEffect(() => {
    if (target === undefined) return;
    setSummary(null);
    setError(null);
    let live = true;
    moveItems(cfg, token, base, itemsRef.current, target, true)
      .then((s) => live && setSummary(s))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [cfg, token, base, itemsKey, target]);

  async function go() {
    if (target === undefined) return;
    setBusy(true);
    try {
      await moveItems(cfg, token, base, items, target, false);
      onMoved(target, target === null ? rootLabel : (byId.get(target)?.name ?? 'the folder'));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const what = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  if (target !== undefined) {
    const name = target === null ? rootLabel : (byId.get(target)?.name ?? 'that folder');
    return (
      <Dialog
        title={`Move ${what}`}
        onClose={onClose}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={preset === undefined ? () => setTarget(undefined) : onClose}
            >
              {preset === undefined ? 'Back' : 'Cancel'}
            </Button>
            <Button variant="cta" disabled={!summary || busy} onClick={() => void go()}>
              {busy ? 'Moving…' : `Move to ${name}`}
            </Button>
          </>
        }
      >
        <p>
          Moving to <b>{name}</b>. Moved items keep their own access settings and take the rest from
          their new folder.
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        {!summary && !error && <WaveLoader />}
        {summary && <SummaryNotice s={summary} />}
      </Dialog>
    );
  }

  const here = at ? byId.get(at) : undefined;
  const kids = (list?.folders ?? [])
    .filter((f) => !f.sharedWithMe && f.parentId === at)
    .sort(byName);
  const canHere =
    at === null
      ? atLeast(list?.root.level ?? 'none', 'edit')
      : !!here && atLeast(here.level, 'edit') && !blocked(here);
  return (
    <Dialog
      title={`Move ${what} to…`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="cta" disabled={!canHere} onClick={() => setTarget(at)}>
            Move here
          </Button>
        </>
      }
    >
      {loadError && <Notice tone="error">{loadError}</Notice>}
      <div className="flex items-center gap-2">
        {at !== null && (
          <Button size="sm" variant="ghost" onClick={() => setAt(here?.parentId ?? null)}>
            ← {here?.parentId ? (byId.get(here.parentId)?.name ?? 'Back') : rootLabel}
          </Button>
        )}
        <b className="[overflow-wrap:anywhere]">{here?.name ?? rootLabel}</b>
      </div>
      {!list ? (
        <WaveLoader />
      ) : kids.length === 0 ? (
        <p className="src">No folders inside.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {kids.map((f) => (
            <li key={f.folderId}>
              <button
                type="button"
                disabled={blocked(f)}
                onClick={() => setAt(f.folderId)}
                className="flex min-h-[48px] w-full items-center gap-3 rounded-[10px] border border-input bg-card px-3 text-left disabled:opacity-50"
              >
                <Icon name="folder" size={18} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {!atLeast(f.level, 'edit') && <span className="src">View only</span>}
                <span aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// ── The Access panel ──────────────────────────────────────────────────────
function sourceText(e: AccessInfo['entries'][number]) {
  if (e.source.kind === 'here') return 'Set here';
  if (e.source.kind === 'inherited') return `Inherited from ${e.source.folderName}`;
  return 'Library default';
}

/**
 * Who has access to a folder or file, where each person's access comes from,
 * and (for people who manage it) changing it, with a summary before saving.
 */
export function AccessPanel({
  cfg,
  token,
  base,
  item,
  onClose,
  onSaved,
}: {
  cfg: AppConfig;
  token: string;
  base: string;
  item: ItemRef;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Unsaved changes: a level per person or group, or null to reset to inherited.
  const [changes, setChanges] = useState<Record<string, Level | null>>({});
  const [inherit, setInherit] = useState<boolean | undefined>(undefined);
  const [adding, setAdding] = useState('');
  const [addLevel, setAddLevel] = useState<Level>('view');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pushDown, setPushDown] = useState<'keep' | 'replace'>('keep');
  const [busy, setBusy] = useState(false);
  const [checkSub, setCheckSub] = useState('');
  const [check, setCheck] = useState<{ name: string; level: Level; because: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(
        await api<AccessInfo>(cfg, token, 'GET', `${base}/access?kind=${item.kind}&id=${item.id}`),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, base, item.kind, item.id]);
  useEffect(() => void load(), [load]);

  const dirty = Object.keys(changes).length > 0 || inherit !== undefined;
  const body = (preview: boolean) => ({
    item,
    ...(Object.keys(changes).length ? { grants: changes } : {}),
    ...(inherit !== undefined ? { inherit } : {}),
    pushDown,
    preview,
  });

  async function review() {
    setBusy(true);
    setError(null);
    try {
      setSummary(await api<Summary>(cfg, token, 'PUT', `${base}/access`, body(true)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      await api(cfg, token, 'PUT', `${base}/access`, body(false));
      setChanges({});
      setInherit(undefined);
      setSummary(null);
      onSaved();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function runCheck(sub: string) {
    setCheckSub(sub);
    setCheck(null);
    if (!sub) return;
    try {
      setCheck(
        await api(cfg, token, 'GET', `${base}/check?kind=${item.kind}&id=${item.id}&sub=${sub}`),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const title = `Access${info ? ` · ${info.item.name}` : ''}`;
  if (!info) {
    return (
      <Dialog title={title} onClose={onClose}>
        {error ? <Notice tone="error">{error}</Notice> : <WaveLoader />}
      </Dialog>
    );
  }

  const manage = info.canManage;
  const shownInherit = inherit ?? info.inherit;
  // The list as it will be: existing rows with their changes, plus new ones.
  const rows = info.entries.map((e) => ({
    ...e,
    level: changes[e.key] === undefined ? e.level : (changes[e.key] ?? e.level),
    resetting: changes[e.key] === null,
    changed: changes[e.key] !== undefined,
  }));
  for (const [key, level] of Object.entries(changes)) {
    if (level && !rows.some((r) => r.key === key)) {
      const c = info.candidates.find((x) => x.key === key);
      rows.push({
        key,
        label: c?.label ?? key,
        level,
        source: { kind: 'here' },
        resetting: false,
        changed: true,
      });
    }
  }
  const addable = info.candidates.filter(
    (c) =>
      !info.entries.some((e) => e.key === c.key && e.source.kind === 'here') && !(c.key in changes),
  );

  if (summary) {
    return (
      <Dialog
        title={title}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSummary(null)} disabled={busy}>
              Back
            </Button>
            <Button variant="cta" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <SummaryNotice s={summary} noun="files" />
        {(summary.deeperOverrides ?? 0) > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-1 font-bold">
              {summary.deeperOverrides} {summary.deeperOverrides === 1 ? 'item' : 'items'} inside
              have their own setting for the people you changed.
            </legend>
            {(['keep', 'replace'] as const).map((v) => (
              <label key={v} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="pushDown"
                  checked={pushDown === v}
                  onChange={() => {
                    setPushDown(v);
                    void api<Summary>(cfg, token, 'PUT', `${base}/access`, {
                      ...body(true),
                      pushDown: v,
                    })
                      .then(setSummary)
                      .catch((e) => setError((e as Error).message));
                  }}
                />
                {v === 'keep' ? 'Keep their settings' : 'Replace them with this'}
              </label>
            ))}
          </fieldset>
        )}
        {summary.youLoseManage && (
          <Notice tone="error">
            You’ll lose Can manage on this {item.kind}, so you won’t be able to change its access
            again.
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        manage ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {dirty ? 'Cancel' : 'Close'}
            </Button>
            <Button variant="cta" disabled={!dirty || busy} onClick={() => void review()}>
              {busy ? 'Checking…' : 'Review changes'}
            </Button>
          </>
        ) : undefined
      }
    >
      {info.legacySharing && (
        <Notice>
          This file isn’t in a folder yet, so it still uses its own sharing. Saving here gives it
          access settings of its own.
        </Notice>
      )}
      {!manage && <p className="src">You can see who has access but not change it.</p>}
      {error && <Notice tone="error">{error}</Notice>}

      {manage && item.kind === 'folder' && (
        <label className="flex items-start gap-3 rounded-lg border border-input p-3">
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={!shownInherit}
            onChange={(e) => setInherit(e.target.checked ? false : true)}
          />
          <span>
            <b className="block">Don’t inherit access from parent folders</b>
            <span className="src">
              The access it has now is copied in, so nothing changes until you edit it. After that,
              changes above no longer reach this folder.
            </span>
          </span>
        </label>
      )}

      <ul className="flex flex-col">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-input py-2.5 last:border-b-0"
          >
            <span className="min-w-0 flex-[1_1_160px]">
              <b className="block [overflow-wrap:anywhere]">{r.label}</b>
              <span className="src">
                {r.resetting
                  ? 'Will go back to inherited'
                  : r.changed
                    ? 'Set here (not saved)'
                    : sourceText(r)}
              </span>
            </span>
            {manage ? (
              <span className="flex items-center gap-2">
                <select
                  aria-label={`Access for ${r.label}`}
                  className="min-h-10 rounded-lg border border-input bg-white px-2 text-[15px]"
                  value={r.level}
                  onChange={(e) => setChanges((c) => ({ ...c, [r.key]: e.target.value as Level }))}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {LEVEL_LABEL[l]}
                    </option>
                  ))}
                </select>
                {(r.source.kind === 'here' || r.changed) && !r.resetting && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setChanges((c) => {
                        const n = { ...c };
                        if (r.source.kind === 'here') n[r.key] = null;
                        else delete n[r.key];
                        return n;
                      })
                    }
                  >
                    {r.source.kind === 'here' ? 'Reset to inherited' : 'Undo'}
                  </Button>
                )}
              </span>
            ) : (
              <Tag tone={r.level === 'none' ? 'c' : 's'}>{LEVEL_LABEL[r.level]}</Tag>
            )}
          </li>
        ))}
      </ul>

      {manage && addable.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[180px] flex-1 flex-col gap-1.5">
            <span className="text-[15px] font-bold">Add people or groups</span>
            <select
              className="min-h-11 rounded-lg border border-input bg-white px-3"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">Choose…</option>
              {addable.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                  {c.detail ? ` · ${c.detail}` : ''}
                </option>
              ))}
            </select>
          </label>
          <select
            aria-label="Their access"
            className="min-h-11 rounded-lg border border-input bg-white px-2"
            value={addLevel}
            onChange={(e) => setAddLevel(e.target.value as Level)}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABEL[l]}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            disabled={!adding}
            onClick={() => {
              setChanges((c) => ({ ...c, [adding]: addLevel }));
              setAdding('');
            }}
          >
            Add
          </Button>
        </div>
      )}

      {manage && info.candidates.some((c) => c.sub) && (
        <details className="rounded-lg border border-input p-3">
          <summary className="cursor-pointer font-bold">Check someone’s access</summary>
          <div className="flex flex-col gap-2 pt-2">
            <select
              aria-label="Person to check"
              className="min-h-11 rounded-lg border border-input bg-white px-3"
              value={checkSub}
              onChange={(e) => void runCheck(e.target.value)}
            >
              <option value="">Choose a person…</option>
              {info.candidates
                .filter((c) => c.sub)
                .map((c) => (
                  <option key={c.key} value={c.sub}>
                    {c.label}
                  </option>
                ))}
            </select>
            {check && (
              <p role="status">
                <b>{check.name}</b>: {LEVEL_LABEL[check.level]}, because {check.because}.
              </p>
            )}
          </div>
        </details>
      )}
    </Dialog>
  );
}

// ── Folder rows and the browser ───────────────────────────────────────────
type Dialogs =
  | { kind: 'new' }
  | { kind: 'access'; item: ItemRef }
  | { kind: 'move'; items: ItemRef[]; to?: string | null };

function NameDialog({
  title,
  initial,
  action,
  onClose,
  onSave,
}: {
  title: string;
  initial: string;
  action: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    try {
      await onSave(name.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="cta" disabled={!name.trim() || busy} onClick={() => void go()}>
            {action}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <Field
          label="Folder name"
          value={name}
          maxLength={120}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}

export interface Selection {
  /** Selected files (folders are tracked by the browser). */
  ids: Set<string>;
  toggle: (fileId: string) => void;
}

/**
 * Folders around a file list: the tree (desktop), breadcrumbs, folder rows,
 * New folder, selecting and moving, drag and drop, and the Access panel.
 * `renderFiles` draws the files in the current folder (the existing table).
 */
export function FolderBrowser({
  cfg,
  token,
  collection,
  rootLabel,
  files,
  place,
  onPlace,
  onChanged,
  renderFiles,
  toolbar,
}: {
  cfg: AppConfig;
  token: string;
  collection: string;
  rootLabel: string;
  files: FileItem[] | null;
  place: Place;
  onPlace: (p: Place) => void;
  onChanged: () => void;
  renderFiles: (
    files: FileItem[] | null,
    opts: { selection?: Selection; onDragStart: (e: React.DragEvent, f: FileItem) => void },
  ) => ReactNode;
  /** Extra buttons beside New folder (e.g. the phone's Upload document). */
  toolbar?: ReactNode;
}) {
  const base = collection.replace(/\/files$/, '/folders');
  const { list, error, load } = useFolders(cfg, token, base);
  const phone = usePhone();
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  // Folder details (rev 13, P2/P4): the open folder's record page and its edit screen.
  const [details, setDetails] = useState<{ editing: boolean } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selFiles, setSelFiles] = useState<Set<string>>(new Set());
  const [selFolders, setSelFolders] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => {
    void load();
    onChanged();
  };

  const folders = useMemo(() => list?.folders ?? [], [list]);
  const byId = useMemo(() => new Map(folders.map((f) => [f.folderId, f])), [folders]);
  // A folder that disappeared (deleted, or access removed): back to the top.
  useEffect(() => {
    if (list && typeof place === 'string' && place !== SHARED && !byId.has(place)) onPlace(null);
  }, [list, place, byId, onPlace]);

  useEffect(() => setDetails(null), [place]);

  const visibleIds = new Set(folders.map((f) => f.folderId));
  const sharedFiles = (files ?? []).filter((f) => f.folderId && !visibleIds.has(f.folderId));
  const hasShared = folders.some((f) => f.sharedWithMe) || (!!list && sharedFiles.length > 0);
  const here = typeof place === 'string' && place !== SHARED ? byId.get(place) : undefined;
  const levelHere: Level =
    place === SHARED ? 'view' : here ? here.level : (list?.root.level ?? 'none');

  const subfolders =
    place === SHARED
      ? folders.filter((f) => f.sharedWithMe)
      : folders.filter((f) => !f.sharedWithMe && f.parentId === (here?.folderId ?? null));
  subfolders.sort(byName);
  const filesHere =
    files &&
    (place === SHARED
      ? sharedFiles
      : files.filter((f) => (f.folderId ?? null) === (here?.folderId ?? null)));
  const count = (f: Folder) =>
    folders.filter((x) => x.parentId === f.folderId).length +
    (files ?? []).filter((x) => x.folderId === f.folderId).length;

  // Drag and drop: drag files or folders onto a folder, the tree or a crumb.
  const drag = useRef<ItemRef[] | null>(null);
  const onDragStart = (e: React.DragEvent, item: ItemRef) => {
    const group =
      selecting && (item.kind === 'file' ? selFiles.has(item.id) : selFolders.has(item.id))
        ? [
            ...[...selFiles].map((id) => ({ kind: 'file' as const, id })),
            ...[...selFolders].map((id) => ({ kind: 'folder' as const, id })),
          ]
        : [item];
    drag.current = group;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', group.map((g) => g.id).join(','));
  };
  const onDrop = (to: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    const items = drag.current;
    drag.current = null;
    if (!items?.length || items.some((i) => i.kind === 'folder' && i.id === to)) return;
    setDialog({ kind: 'move', items, to });
  };

  const selection: Selection | undefined = selecting
    ? {
        ids: selFiles,
        toggle: (id) =>
          setSelFiles((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          }),
      }
    : undefined;
  const selectedCount = selFiles.size + selFolders.size;
  const stopSelecting = () => {
    setSelecting(false);
    setSelFiles(new Set());
    setSelFolders(new Set());
  };

  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <Crumbs
        rootLabel={rootLabel}
        place={place}
        folders={byId}
        onGo={onPlace}
        onDrop={phone ? undefined : onDrop}
      />
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        {place !== SHARED && atLeast(levelHere, 'edit') && (
          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'new' })}>
            <Icon name="folder" size={15} />
            New folder
          </Button>
        )}
        {here && (
          // Rev 13: a folder's own actions (rename, access, move, delete) live on
          // its details page, not in a menu on its row.
          <Button size="sm" variant="ghost" onClick={() => setDetails({ editing: false })}>
            <Icon name="folder" size={15} />
            Folder details
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
        >
          {selecting ? 'Cancel' : 'Select'}
        </Button>
        {selecting && (
          <>
            <span className="src">{selectedCount} selected</span>
            <Button
              size="sm"
              variant="navy"
              disabled={selectedCount === 0}
              onClick={() =>
                setDialog({
                  kind: 'move',
                  items: [
                    ...[...selFiles].map((id) => ({ kind: 'file' as const, id })),
                    ...[...selFolders].map((id) => ({ kind: 'folder' as const, id })),
                  ],
                })
              }
            >
              Move to…
            </Button>
          </>
        )}
      </div>
      {(error || notice) && <Notice tone={error ? 'error' : 'success'}>{error ?? notice}</Notice>}
      {!list && !error ? (
        <WaveLoader />
      ) : (
        <>
          {(subfolders.length > 0 || (place === null && hasShared)) && (
            <ul className="flex flex-col gap-1.5" aria-label="Folders">
              {place === null && hasShared && phone && (
                <li>
                  <button
                    type="button"
                    onClick={() => onPlace(SHARED)}
                    className="flex min-h-[52px] w-full items-center gap-3 rounded-[10px] border border-input bg-card px-3 py-2 text-left shadow-xs"
                  >
                    <FolderIcon shared />
                    <b className="flex-1">Shared with me</b>
                    <span aria-hidden="true">›</span>
                  </button>
                </li>
              )}
              {subfolders.map((f) => (
                <li
                  key={f.folderId}
                  draggable={!phone && f.level === 'manage'}
                  onDragStart={(e) => onDragStart(e, { kind: 'folder', id: f.folderId })}
                  onDragOver={
                    !phone && atLeast(f.level, 'edit') ? (e) => e.preventDefault() : undefined
                  }
                  onDrop={!phone && atLeast(f.level, 'edit') ? onDrop(f.folderId) : undefined}
                  className="flex min-h-[52px] items-center gap-2 rounded-[10px] border border-input bg-card pr-1 pl-3 shadow-xs hover:bg-[#F6F8FA] dark:hover:bg-secondary"
                >
                  {selecting && (
                    <input
                      type="checkbox"
                      className="size-4 flex-none"
                      aria-label={`Select ${f.name}`}
                      checked={selFolders.has(f.folderId)}
                      disabled={f.level !== 'manage'}
                      onChange={() =>
                        setSelFolders((s) => {
                          const n = new Set(s);
                          if (n.has(f.folderId)) n.delete(f.folderId);
                          else n.add(f.folderId);
                          return n;
                        })
                      }
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => onPlace(f.folderId)}
                    className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
                  >
                    <FolderIcon />
                    <span className="min-w-0 flex-1">
                      <b className="line-clamp-2 block [overflow-wrap:anywhere]">{f.name}</b>
                      <span className="src flex flex-wrap items-center gap-1.5">
                        {count(f)} {count(f) === 1 ? 'item' : 'items'} ·{' '}
                        {f.ownedByMe ? 'Me' : f.ownerName}
                        {f.customAccess && <CustomAccess />}
                        {f.level === 'view' && <span>· View only</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {renderFiles(filesHere, {
            selection,
            onDragStart: (e, f) => onDragStart(e, { kind: 'file', id: f.fileId }),
          })}
        </>
      )}
    </div>
  );

  const shown =
    details && here ? (
      <FolderDetails
        cfg={cfg}
        token={token}
        base={base}
        rootLabel={rootLabel}
        folder={here}
        items={count(here)}
        editing={details.editing}
        onBack={() => setDetails(details.editing ? { editing: false } : null)}
        onEdit={() => setDetails({ editing: true })}
        onAccess={() => setDialog({ kind: 'access', item: { kind: 'folder', id: here.folderId } })}
        onMove={() => setDialog({ kind: 'move', items: [{ kind: 'folder', id: here.folderId }] })}
        onSaved={() => {
          setDetails({ editing: false });
          refresh();
        }}
        onDeleted={() => {
          setDetails(null);
          onPlace(here.parentId);
          setNotice(`Deleted “${here.name}”.`);
          refresh();
        }}
      />
    ) : (
      body
    );

  return (
    <>
      {phone || !list ? (
        shown
      ) : (
        <div className="flex items-start gap-4">
          <aside className="sticky top-2 w-[220px] flex-none border-r border-input pr-3">
            <Tree
              rootLabel={rootLabel}
              folders={folders}
              place={place}
              hasShared={hasShared}
              onGo={onPlace}
              onDrop={onDrop}
            />
          </aside>
          {shown}
        </div>
      )}
      {dialog?.kind === 'new' && (
        <NameDialog
          title="New folder"
          initial=""
          action="Create"
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            const made = await api<Folder>(cfg, token, 'POST', base, {
              name,
              parentId: here?.folderId ?? null,
            });
            setNotice(`Made “${made.name}”.`);
            refresh();
          }}
        />
      )}
      {dialog?.kind === 'access' && (
        <AccessPanel
          cfg={cfg}
          token={token}
          base={base}
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          cfg={cfg}
          token={token}
          base={base}
          rootLabel={rootLabel}
          items={dialog.items}
          to={dialog.to}
          onClose={() => setDialog(null)}
          onMoved={(to, name) => {
            stopSelecting();
            // Open where it went, so the moved items are in view.
            onPlace(to);
            setNotice(`Moved to “${name}”.`);
            refresh();
          }}
        />
      )}
    </>
  );
}

/** Folder details (rev 13): a record page, with Edit for the name and the danger area. */
function FolderDetails({
  cfg,
  token,
  base,
  rootLabel,
  folder: f,
  items,
  editing,
  onBack,
  onEdit,
  onAccess,
  onMove,
  onSaved,
  onDeleted,
}: {
  cfg: AppConfig;
  token: string;
  base: string;
  rootLabel: string;
  folder: Folder;
  items: number;
  editing: boolean;
  onBack: () => void;
  onEdit: () => void;
  onAccess: () => void;
  onMove: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(f.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(f.name), [f.name, editing]);
  const where = [rootLabel, ...f.path.map((p) => p?.name ?? '…')].join(' › ');
  const when = (iso: string) =>
    new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

  if (editing) {
    return (
      <EditScreen
        title="Edit folder"
        back={{ to: f.name, onClick: onBack }}
        busy={busy}
        error={error}
        canSave={!!name.trim() && name.trim() !== f.name}
        onCancel={onBack}
        onSave={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(cfg, token, 'PATCH', `${base}/${f.folderId}`, { name: name.trim() });
            onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        danger={
          f.level === 'manage' && (
            <DangerArea
              title={`Delete ${f.name}`}
              what={
                <>
                  {items > 0
                    ? 'Everything inside it is deleted too, including folders inside. '
                    : ''}
                  Files that are in use, or that belong to someone else, stop the delete. A
                  Blueprint admin can recover deleted files for 35 days.
                </>
              }
              onConfirm={async () => {
                await api(cfg, token, 'DELETE', `${base}/${f.folderId}`);
                onDeleted();
              }}
            />
          )
        }
      >
        <Field
          label="Folder name"
          value={name}
          maxLength={120}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </EditScreen>
    );
  }

  return (
    <RecordPage
      kind="Folder"
      title={f.name}
      sub={where}
      lead={<FolderIcon />}
      badges={
        <>
          <Tag tone="s">{LEVEL_LABEL[f.level]}</Tag>
          {f.customAccess && <Tag tone="n">Own access setting</Tag>}
        </>
      }
      back={{ to: f.name, onClick: onBack }}
      {...(atLeast(f.level, 'edit') ? { onEdit } : {})}
      more={
        <>
          <Button variant="ghost" onClick={onAccess}>
            <Icon name="users" size={16} />
            Access
          </Button>
          {f.level === 'manage' && (
            <Button variant="ghost" onClick={onMove}>
              Move to…
            </Button>
          )}
        </>
      }
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[15px]">
        <dt className="src">Owner</dt>
        <dd>{f.ownedByMe ? 'Me' : f.ownerName}</dd>
        <dt className="src">Inside</dt>
        <dd>
          {items} {items === 1 ? 'item' : 'items'}
        </dd>
        <dt className="src">Access</dt>
        <dd>{f.customAccess ? 'Set on this folder' : 'Inherited from the folder above'}</dd>
        <dt className="src">Made</dt>
        <dd>{when(f.createdAt)}</dd>
        <dt className="src">Last changed</dt>
        <dd>{when(f.updatedAt)}</dd>
      </dl>
    </RecordPage>
  );
}
