import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ArtistSummary } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  download,
  fileTypeOf,
  formatSize,
  uploadFile,
  waitUntilScanned,
  type FileItem,
} from '../lib/files.ts';
import { CATEGORY_ONE } from './Assets.tsx';
import { makeThumbnail } from '../lib/thumbnail.ts';
import { FileThumb } from '../components/FileThumb.tsx';
import {
  Button,
  Card,
  Chips,
  DataTable,
  Field,
  Icon,
  Notice,
  shortDate,
  Tag,
  usePhone,
  WaveLoader,
} from '../components/ui.tsx';

const VISIBILITY_LABEL: Record<NonNullable<FileItem['visibility']>, string> = {
  normal: 'Shared',
  'bmg-only': 'BMG only',
  private: 'Private',
};
const SHARING_LABEL: Record<NonNullable<FileItem['sharing']>, string> = {
  'bmg-only': 'BMG only',
  'all-artists': 'All artists',
  selected: 'Selected artists',
};

const date = shortDate;

/** A file's type, plus its asset kind when it's in the asset library ("PNG · Press photo"). */
function typeLabel(f: FileItem): string {
  return f.asset ? `${f.fileType.label} · ${CATEGORY_ONE[f.asset.category]}` : f.fileType.label;
}

/**
 * Library type filter (rev 9): assets are artist files with extra details, so
 * Library and Assets are one place, told apart by type.
 */
export type LibraryKind = 'all' | 'documents' | 'assets';
export const LIBRARY_KIND_OPTIONS: readonly { id: LibraryKind; label: string }[] = [
  { id: 'all', label: 'All files' },
  { id: 'documents', label: 'Documents' },
  { id: 'assets', label: 'Assets' },
];

function useFiles(cfg: AppConfig, token: string, collection: string) {
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setFiles((await api<{ files: FileItem[] }>(cfg, token, 'GET', collection)).files);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cfg, token, collection]);
  useEffect(() => void load(), [load]);
  return { files, error, setError, load };
}

/**
 * Pick a file, name it, upload it, then wait for the malware scan. A preview
 * is drawn as soon as the file is picked and uploaded with it.
 *
 * Shown as a card beside the list on wider screens, and as its own page on a
 * phone (`asPage`), reached from the library's "Upload document" button.
 */
function UploadBox({
  cfg,
  token,
  collection,
  options,
  children,
  onDone,
  title = 'Upload',
  asPage = false,
  onBack,
}: {
  cfg: AppConfig;
  token: string;
  collection: string;
  /** Extra fields for the upload request (visibility or sharing). */
  options: () => Record<string, unknown>;
  children?: React.ReactNode;
  onDone: () => void;
  title?: string;
  /** Full-page layout (phone), with a way back to the library. */
  asPage?: boolean;
  onBack?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  // undefined: still drawing it; null: no preview for this file.
  const [thumb, setThumb] = useState<Blob | null | undefined>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const making = useRef<Promise<Blob | null> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!thumb) {
      setThumbUrl(null);
      return;
    }
    const url = URL.createObjectURL(thumb);
    setThumbUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [thumb]);

  function pick(f: File | null) {
    setFile(f);
    setResult(null);
    setName('');
    if (!f) {
      setThumb(null);
      making.current = null;
      return;
    }
    setThumb(undefined);
    const p = makeThumbnail(f);
    making.current = p;
    void p.then((b) => {
      if (making.current === p) setThumb(b);
    });
  }

  function reset() {
    pick(null);
    if (input.current) input.current.value = '';
  }

  async function go() {
    if (!file) return;
    setResult(null);
    const shown = name.trim() || file.name;
    try {
      setBusy('Uploading…');
      const preview = thumb === undefined ? await making.current : thumb;
      const created = await uploadFile(cfg, token, collection, file, options(), {
        title: name,
        thumbnail: preview ?? null,
      });
      onDone();
      setBusy('Checking for malware…');
      const settled = await waitUntilScanned(cfg, token, `${collection}/${created.fileId}`);
      setResult(
        !settled
          ? {
              tone: 'success',
              text: 'Uploaded. The scan is taking a while; the file appears when it’s done.',
            }
          : settled.status === 'available'
            ? { tone: 'success', text: `${shown} is ready.` }
            : {
                tone: 'error',
                text: `${shown} was not kept: ${settled.rejectReason ?? 'it failed the scan'}.`,
              },
      );
      reset();
    } catch (e) {
      setResult({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      onDone();
    }
  }

  const type = file ? fileTypeOf(file) : null;
  const body = (
    <>
      <label className="flex min-h-[96px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[#9AA4B0] bg-background px-4 py-4 text-center">
        {file && type ? (
          <span className="flex w-full items-center gap-3 text-left">
            <FileThumb
              src={thumbUrl}
              kind={type.kind}
              ext={type.ext}
              label={type.label}
              size={64}
              loading={thumb === undefined}
            />
            <span className="min-w-0 flex-1">
              <b className="line-clamp-2 block text-[15px] [overflow-wrap:anywhere]">{file.name}</b>
              <span className="src">
                {type.label} · {formatSize(file.size)}
              </span>
              <span className="src block underline">Choose a different file</span>
            </span>
          </span>
        ) : (
          <>
            <Icon name="upload" size={22} />
            <b className="text-[15px]">Choose a file</b>
            <span className="src">Up to 500 MB · scanned for malware first</span>
          </>
        )}
        <input
          ref={input}
          type="file"
          className="sr-only"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      <Field
        label="Name"
        value={name}
        maxLength={200}
        onChange={(e) => setName(e.target.value)}
        placeholder={file ? file.name : 'e.g. Tour rider 2027'}
        hint="Shown in lists instead of the file name. Leave blank to use the file name."
      />
      {children}
      <Button variant="cta" disabled={!file || !!busy} onClick={() => void go()}>
        {busy ?? 'Upload'}
      </Button>
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
    </>
  );

  if (!asPage) return <Card title={title}>{body}</Card>;
  return (
    <Card
      title="Upload document"
      action={
        <Button size="sm" variant="ghost" onClick={onBack} disabled={!!busy}>
          ← Library
        </Button>
      }
    >
      {body}
      {result?.tone === 'success' && (
        <Button variant="navy" onClick={onBack}>
          Back to library
        </Button>
      )}
    </Card>
  );
}

/** The phone's way into the upload page. */
function UploadDocumentButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="cta" className="w-full" onClick={onClick}>
      <Icon name="upload" size={16} />
      Upload document
    </Button>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[15px] font-bold">{label}</span>
      <select
        className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base shadow-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusBadge({ f }: { f: FileItem }) {
  if (f.status === 'available') return null;
  return (
    <Tag tone={f.status === 'pending' ? 's' : 'c'} className="ml-2">
      <span title={f.rejectReason ?? undefined}>
        {f.status === 'pending' ? 'Scanning' : 'Rejected'}
      </span>
    </Tag>
  );
}

/** Delete with a second click to confirm (no browser dialogs). */
function DeleteButton({ f, onDelete }: { f: FileItem; onDelete: (f: FileItem) => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <Button
      size="sm"
      variant={confirm ? 'cta' : 'ghost'}
      disabled={busy}
      aria-label={confirm ? `Confirm delete ${f.displayName}` : `Delete ${f.displayName}`}
      onClick={async (e) => {
        e.stopPropagation();
        if (!confirm) return setConfirm(true);
        setBusy(true);
        try {
          await onDelete(f);
        } finally {
          setBusy(false);
          setConfirm(false);
        }
      }}
    >
      <Icon name="trash" size={15} />
      {busy ? 'Deleting…' : confirm ? 'Confirm' : 'Delete'}
    </Button>
  );
}

/** A file's preview, or its type's tile. */
function Thumb({ f, size }: { f: FileItem; size: number }) {
  return (
    <FileThumb
      src={f.thumbnailUrl}
      kind={f.fileType.kind}
      ext={f.fileType.ext}
      label={f.fileType.label}
      size={size}
    />
  );
}

function RenameButton({ f, onClick }: { f: FileItem; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" aria-label={`Rename ${f.displayName}`} onClick={onClick}>
      <Icon name="pencil" size={15} />
      <span className="max-sm:sr-only">Rename</span>
    </Button>
  );
}

/**
 * Rename in place: the name the file shows in lists. Blank goes back to the
 * file name; Enter saves, Escape cancels.
 */
function RenameForm({
  f,
  onSave,
  onCancel,
}: {
  f: FileItem;
  onSave: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(f.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(value.trim());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-sm font-bold">Name</span>
        <input
          className="min-h-11 w-full rounded-lg border border-input bg-white px-3 text-base shadow-xs"
          value={value}
          maxLength={200}
          placeholder={f.name}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
          }}
        />
      </label>
      <span className="src">Leave blank to show the file name ({f.name}).</span>
      {error && <Notice tone="error">{error}</Notice>}
      <span className="flex gap-2">
        <Button size="sm" variant="cta" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

function FileTable({
  files,
  empty,
  columns,
  onOpen,
  onDelete,
  canDelete = () => false,
  onRename,
  canRename = () => false,
  compact = false,
}: {
  files: FileItem[] | null;
  empty: string;
  columns: { label: string; cell: (f: FileItem) => React.ReactNode }[];
  onOpen: (f: FileItem) => void;
  onDelete?: (f: FileItem) => Promise<void>;
  canDelete?: (f: FileItem) => boolean;
  /** Save a new name ('' shows the file name again). */
  onRename?: (f: FileItem, title: string) => Promise<void>;
  canRename?: (f: FileItem) => boolean;
  /** Phone layout: a list of rows instead of a table. */
  compact?: boolean;
}) {
  // The phone list is used for the artist app and on any phone-width screen.
  const phone = usePhone();
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = (f: FileItem) => async (title: string) => {
    await onRename!(f, title);
    setRenaming(null);
  };
  const renamable = (f: FileItem) => !!onRename && canRename(f);
  if (!files) return <WaveLoader />;
  if (files.length === 0) return <p className="src pb-5">{empty}</p>;
  if (compact || phone) {
    return (
      <div className="flex flex-col gap-1.5">
        {files.map((f) =>
          renaming === f.fileId ? (
            <div
              key={f.fileId}
              className="flex items-start gap-3 rounded-[10px] border border-input bg-card px-3 py-2.5 shadow-xs"
            >
              <Thumb f={f} size={44} />
              <RenameForm f={f} onSave={rename(f)} onCancel={() => setRenaming(null)} />
            </div>
          ) : (
            // The name is the open button; the details line (which can hold its
            // own controls, like "Shared with") sits beside it, not inside it.
            <div
              key={f.fileId}
              className="flex min-h-[52px] items-center gap-3 rounded-[10px] border border-input bg-card px-3 py-2.5 shadow-xs"
            >
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                disabled={f.status !== 'available'}
                onClick={() => onOpen(f)}
                className="flex-none"
              >
                <Thumb f={f} size={44} />
              </button>
              <span className="min-w-0 flex-1">
                <button
                  type="button"
                  disabled={f.status !== 'available'}
                  onClick={() => onOpen(f)}
                  className="block w-full text-left"
                >
                  <b className="line-clamp-2 block [overflow-wrap:anywhere]">{f.displayName}</b>
                </button>
                <span className="src">
                  {typeLabel(f)} · {formatSize(f.size)} · {date(f.createdAt)}
                  {columns.map((c) => (
                    <span key={c.label}> · {c.cell(f)}</span>
                  ))}
                </span>
                <StatusBadge f={f} />
              </span>
              {(renamable(f) || (onDelete && canDelete(f))) && (
                <span className="flex flex-none flex-col items-end gap-1.5">
                  {renamable(f) && <RenameButton f={f} onClick={() => setRenaming(f.fileId)} />}
                  {onDelete && canDelete(f) && <DeleteButton f={f} onDelete={onDelete} />}
                </span>
              )}
            </div>
          ),
        )}
      </div>
    );
  }
  return (
    <DataTable>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Type</th>
          <th scope="col">Size</th>
          {columns.map((c) => (
            <th key={c.label} scope="col">
              {c.label}
            </th>
          ))}
          <th scope="col">Added</th>
          <th scope="col" />
        </tr>
      </thead>
      <tbody>
        {files.map((f) => (
          <tr key={f.fileId}>
            <td>
              <span className="flex items-center gap-3">
                <Thumb f={f} size={40} />
                {renaming === f.fileId ? (
                  <RenameForm f={f} onSave={rename(f)} onCancel={() => setRenaming(null)} />
                ) : (
                  <span className="min-w-0">
                    <b className="block">{f.displayName}</b>
                    {f.title && <span className="src block">{f.name}</span>}
                  </span>
                )}
                <StatusBadge f={f} />
              </span>
            </td>
            <td className="src">{typeLabel(f)}</td>
            <td className="src">{formatSize(f.size)}</td>
            {columns.map((c) => (
              <td key={c.label}>{c.cell(f)}</td>
            ))}
            <td className="src">{date(f.createdAt)}</td>
            <td className="whitespace-nowrap text-right">
              <Button
                size="sm"
                variant="ghost"
                disabled={f.status !== 'available'}
                onClick={() => onOpen(f)}
              >
                <Icon name="download" size={15} />
                Open
              </Button>
              {renamable(f) && renaming !== f.fileId && (
                <span className="ml-2 inline-block">
                  <RenameButton f={f} onClick={() => setRenaming(f.fileId)} />
                </span>
              )}
              {onDelete && canDelete(f) && (
                <span className="ml-2 inline-block">
                  <DeleteButton f={f} onDelete={onDelete} />
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

/**
 * One artist's files: the workspace Library tab (BMG) and the artist's own
 * Library screen. Artists can mark uploads private (only they can open them,
 * enforced by their key); BMG can keep its uploads BMG-only.
 */
export function ArtistFiles({
  cfg,
  token,
  artistId,
  isBmg,
  isAdmin = false,
  kind = 'all',
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isBmg: boolean;
  isAdmin?: boolean;
  /** Library type filter: everything, or documents only (assets have their own gallery). */
  kind?: Exclude<LibraryKind, 'assets'>;
}) {
  const collection = `/artists/${artistId}/files`;
  const { files, error, setError, load } = useFiles(cfg, token, collection);
  const [visibility, setVisibility] = useState('normal');
  const [filter, setFilter] = useState<ArtistFilter>('all');
  // Phones get an "Upload document" button that opens the upload page.
  const phone = usePhone();
  const [uploading, setUploading] = useState(false);

  async function setShared(f: FileItem, shared: boolean) {
    try {
      await api(cfg, token, 'PATCH', `${collection}/${f.fileId}`, {
        visibility: shared ? 'normal' : 'bmg-only',
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const open = (f: FileItem) =>
    void download(cfg, token, `${collection}/${f.fileId}`).catch((e) =>
      setError((e as Error).message),
    );
  const remove = async (f: FileItem) => {
    try {
      await api(cfg, token, 'DELETE', `${collection}/${f.fileId}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Same rule as the API: your own uploads; an admin may also remove Blueprint's.
  const canDelete = (f: FileItem) =>
    isBmg
      ? f.uploaderRole !== 'artist' && (isAdmin || f.uploadedByMe)
      : f.uploaderRole === 'artist' && f.uploadedByMe;
  // Same rule as the API: the artist renames their own uploads; Blueprint renames Blueprint's.
  const canRename = (f: FileItem) =>
    isBmg ? f.uploaderRole !== 'artist' : f.uploaderRole === 'artist' && f.uploadedByMe;
  const rename = async (f: FileItem, title: string) => {
    await api(cfg, token, 'PATCH', `${collection}/${f.fileId}`, { title });
    await load();
  };

  const upload = (
    <UploadBox
      cfg={cfg}
      token={token}
      collection={collection}
      title={isBmg ? 'Upload & share' : 'Upload'}
      options={() => ({ visibility })}
      onDone={() => void load()}
      asPage={phone}
      onBack={() => setUploading(false)}
    >
      <Select
        label="Who can see it"
        value={visibility}
        onChange={setVisibility}
        options={
          isBmg
            ? [
                { value: 'normal', label: 'The artist and Blueprint' },
                { value: 'bmg-only', label: 'Blueprint only' },
              ]
            : [
                { value: 'normal', label: 'Me and Blueprint' },
                { value: 'private', label: 'Only me (private)' },
              ]
        }
      />
    </UploadBox>
  );
  const ofKind = files && (kind === 'documents' ? files.filter((f) => !f.asset) : files);
  const visible = ofKind && ofKind.filter((f) => ARTIST_FILTERS[filter].test(f));
  const columns = [
    {
      label: 'Who can see it',
      cell: (f: FileItem) =>
        isBmg && f.uploaderRole !== 'artist' && f.status === 'available' ? (
          <label className="flex items-center gap-2">
            <input
              className="switch"
              type="checkbox"
              checked={f.visibility === 'normal'}
              onChange={(e) => void setShared(f, e.target.checked)}
            />
            <span>{f.visibility === 'normal' ? 'Shared with artist' : 'BMG only'}</span>
          </label>
        ) : (
          VISIBILITY_LABEL[f.visibility ?? 'normal']
        ),
    },
    {
      label: 'From',
      cell: (f: FileItem) => (f.uploaderRole === 'artist' ? 'Artist' : 'Blueprint'),
    },
  ];

  if (phone && uploading) return upload;
  if (!isBmg) {
    return (
      <div className="flex flex-col gap-3">
        {phone ? <UploadDocumentButton onClick={() => setUploading(true)} /> : upload}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="eyebrow pt-2 text-muted-foreground">My uploads and files</div>
        <FileTable
          files={ofKind}
          empty="No files yet."
          onOpen={open}
          onDelete={remove}
          canDelete={canDelete}
          onRename={rename}
          canRename={canRename}
          columns={[{ label: 'Who', cell: (f) => VISIBILITY_LABEL[f.visibility ?? 'normal'] }]}
          compact
        />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-start gap-5">
      <Card
        className="flex-[2_1_560px] pb-0"
        title="Files"
        action={<span className="src">{ofKind?.length ?? 0} files</span>}
      >
        {phone && <UploadDocumentButton onClick={() => setUploading(true)} />}
        <Chips
          label="Quick filters"
          value={filter}
          onChange={setFilter}
          options={ARTIST_FILTER_OPTIONS}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <FileTable
          files={visible}
          empty="No files here."
          onOpen={open}
          onDelete={remove}
          canDelete={canDelete}
          onRename={rename}
          canRename={canRename}
          columns={columns}
        />
      </Card>
      {!phone && <div className="flex-[1_1_300px]">{upload}</div>}
    </div>
  );
}

const ARTIST_FILTERS = {
  all: { label: 'All', test: () => true },
  shared: { label: 'Shared', test: (f: FileItem) => f.visibility === 'normal' },
  'bmg-only': { label: 'BMG only', test: (f: FileItem) => f.visibility === 'bmg-only' },
  artist: { label: 'From the artist', test: (f: FileItem) => f.uploaderRole === 'artist' },
  bmg: { label: 'From Blueprint', test: (f: FileItem) => f.uploaderRole !== 'artist' },
  scanning: { label: 'Scanning or rejected', test: (f: FileItem) => f.status !== 'available' },
} as const;
type ArtistFilter = keyof typeof ARTIST_FILTERS;
const ARTIST_FILTER_OPTIONS = (Object.keys(ARTIST_FILTERS) as ArtistFilter[]).map((id) => ({
  id,
  label: ARTIST_FILTERS[id].label,
}));

/**
 * BMG's document library. BMG uploads and decides per file who it's shared
 * with: nobody, every artist, or named artists. Artists see the files shared
 * with them.
 */
export function Library({
  cfg,
  token,
  isBmg,
  isAdmin = false,
  artists,
}: {
  cfg: AppConfig;
  token: string;
  isBmg: boolean;
  isAdmin?: boolean;
  artists: ArtistSummary[];
}) {
  const collection = '/library/files';
  const { files, error, setError, load } = useFiles(cfg, token, collection);
  const [sharing, setSharing] = useState('bmg-only');
  const [libraryFilter, setLibraryFilter] = useState<
    'all' | 'all-artists' | 'selected' | 'bmg-only'
  >('all');
  const [editing, setEditing] = useState<FileItem | null>(null);
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));
  const phone = usePhone();
  const [uploading, setUploading] = useState(false);

  const open = (f: FileItem) =>
    void download(cfg, token, `${collection}/${f.fileId}`).catch((e) =>
      setError((e as Error).message),
    );
  const remove = async (f: FileItem) => {
    try {
      await api(cfg, token, 'DELETE', `${collection}/${f.fileId}`);
      if (editing?.fileId === f.fileId) setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!isBmg) {
    return (
      <div className="flex flex-col gap-3">
        {error && <Notice tone="error">{error}</Notice>}
        <FileTable
          files={files}
          empty="Nothing has been shared with you yet."
          onOpen={open}
          columns={[]}
          compact
        />
      </div>
    );
  }

  const uploadBox = (
    <UploadBox
      cfg={cfg}
      token={token}
      collection={collection}
      title="Upload & share"
      options={() => ({ sharing })}
      onDone={() => void load()}
      asPage={phone}
      onBack={() => setUploading(false)}
    >
      <Select
        label="Share with"
        value={sharing}
        onChange={setSharing}
        options={[
          { value: 'bmg-only', label: 'Nobody yet (BMG only)' },
          { value: 'all-artists', label: 'All artists' },
        ]}
      />
      <span className="src">
        To share with chosen artists, upload first, then pick them under “Shared with”.
      </span>
    </UploadBox>
  );
  if (phone && uploading) return uploadBox;

  const visible =
    files &&
    files.filter((f) => libraryFilter === 'all' || (f.sharing ?? 'bmg-only') === libraryFilter);
  return (
    <div className="flex flex-wrap items-start gap-5">
      <Card
        className="flex-[2_1_560px] pb-0"
        title="All files"
        action={<span className="src">{files?.length ?? 0} files</span>}
      >
        {phone && <UploadDocumentButton onClick={() => setUploading(true)} />}
        <Chips
          label="Quick filters"
          value={libraryFilter}
          onChange={setLibraryFilter}
          options={[
            { id: 'all', label: 'All' },
            { id: 'all-artists', label: 'All artists' },
            { id: 'selected', label: 'Selected artists' },
            { id: 'bmg-only', label: 'BMG only' },
          ]}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <FileTable
          files={visible}
          empty="Nothing here."
          onOpen={open}
          onDelete={remove}
          canDelete={(f) => isAdmin || f.uploadedByMe}
          onRename={async (f, title) => {
            await api(cfg, token, 'PATCH', `${collection}/${f.fileId}`, { title });
            await load();
          }}
          canRename={() => true}
          columns={[
            {
              label: 'Shared with',
              cell: (f) => (
                <button
                  type="button"
                  className="text-left font-semibold underline"
                  onClick={() => setEditing(f)}
                >
                  {f.sharing === 'selected'
                    ? f.sharedWithArtistIds.map((id) => names[id] ?? 'Artist').join(', ') ||
                      'Nobody'
                    : SHARING_LABEL[f.sharing ?? 'bmg-only']}
                </button>
              ),
            },
          ]}
        />
      </Card>
      <div className="flex flex-[1_1_300px] flex-col gap-5">
        {!phone && uploadBox}
        {editing && (
          <ShareDialog
            file={editing}
            artists={artists}
            onClose={() => setEditing(null)}
            onSave={async (next) => {
              try {
                await api(cfg, token, 'PATCH', `${collection}/${editing.fileId}`, next);
                setEditing(null);
                await load();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function ShareDialog({
  file,
  artists,
  onClose,
  onSave,
}: {
  file: FileItem;
  artists: ArtistSummary[];
  onClose: () => void;
  onSave: (next: { sharing: string; sharedWithArtistIds: string[] }) => Promise<void>;
}) {
  const [sharing, setSharing] = useState<string>(file.sharing ?? 'bmg-only');
  const [picked, setPicked] = useState<Set<string>>(new Set(file.sharedWithArtistIds));
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Card title={`Share “${file.displayName}”`}>
      <div className="space-y-3 text-sm">
        {(['bmg-only', 'all-artists', 'selected'] as const).map((s) => (
          <label key={s} className="flex items-center gap-2">
            <input
              type="radio"
              name="sharing"
              checked={sharing === s}
              onChange={() => setSharing(s)}
            />
            {SHARING_LABEL[s]}
          </label>
        ))}
        {sharing === 'selected' && (
          <div className="grid gap-1 pl-6 sm:grid-cols-2">
            {artists.map((a) => (
              <label key={a.artistId} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={picked.has(a.artistId)}
                  onChange={() => toggle(a.artistId)}
                />
                {a.displayName}
              </label>
            ))}
            {artists.length === 0 && <p className="text-muted-foreground">No artists yet.</p>}
          </div>
        )}
        <div className="flex gap-2 pt-2">
          <Button
            onClick={() =>
              void onSave({
                sharing,
                sharedWithArtistIds: sharing === 'selected' ? [...picked] : [],
              })
            }
          >
            Save
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
