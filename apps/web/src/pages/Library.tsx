import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ArtistSummary } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  EDIT_ACCESS_LABEL,
  fileTypeOf,
  formatSize,
  uploadFile,
  waitUntilScanned,
  type FileItem,
} from '../lib/files.ts';
import { CATEGORY_ONE } from './Assets.tsx';
import { makeThumbnail } from '../lib/thumbnail.ts';
import { FileThumb } from '../components/FileThumb.tsx';
import { DocumentPage } from './Document.tsx';
import { CustomAccess, FolderBrowser, type Place, type Selection } from '../components/Folders.tsx';
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

/** The folder a Place points at, if it's a real one (not the top or "Shared with me"). */
const folderOf = (p: Place) => (typeof p === 'string' && p !== 'shared' ? p : undefined);

/** Shown on the upload form inside a folder (rev 10). */
function InFolderHint() {
  return (
    <span className="src">
      Uploading into this folder: it gets the folder’s access. You can give it its own access from
      the document afterwards.
    </span>
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

/** "Owned by me" / the owner's name, and a lock when only the owner can edit it. */
function OwnerCell({ f }: { f: FileItem }) {
  return (
    <span className="whitespace-nowrap">
      {f.locked && (
        <span role="img" aria-label="Locked" title="Locked: only the owner can edit it">
          🔒{' '}
        </span>
      )}
      {f.ownedByMe ? 'Me' : f.ownerName}
    </span>
  );
}

function EditAccessSelect({
  value,
  onChange,
  team,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Library: "everyone" means the Blueprint team. */
  team?: boolean;
}) {
  return (
    <Select
      label="Who can edit it"
      value={value}
      onChange={onChange}
      options={[
        { value: 'owner', label: EDIT_ACCESS_LABEL.owner },
        {
          value: 'everyone',
          label: team ? 'Everyone at Blueprint' : EDIT_ACCESS_LABEL.everyone,
        },
      ]}
    />
  );
}

function StatusBadge({ f }: { f: FileItem }) {
  if (f.status === 'available') {
    return f.inUse ? (
      <Tag tone="s" className="ml-2">
        <span title="Used somewhere in the app, so it can’t be deleted">In use</span>
      </Tag>
    ) : null;
  }
  return (
    <Tag tone={f.status === 'pending' ? 's' : 'c'} className="ml-2">
      <span title={f.rejectReason ?? undefined}>
        {f.status === 'pending' ? 'Scanning' : 'Rejected'}
      </span>
    </Tag>
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

/**
 * The list of documents. Tapping a document (anywhere on its row or card)
 * opens its detail page (rev 8); there are no buttons on the rows.
 */
function FileTable({
  files,
  empty,
  columns,
  onOpen,
  compact = false,
  selection,
  onDragStart,
}: {
  files: FileItem[] | null;
  empty: string;
  columns: { label: string; cell: (f: FileItem) => React.ReactNode }[];
  onOpen: (f: FileItem) => void;
  /** Phone layout: a list of cards instead of a table. */
  compact?: boolean;
  /** Selecting files to move (rev 10). */
  selection?: Selection;
  /** Dragging a file onto a folder (rev 10, wider screens). */
  onDragStart?: (e: React.DragEvent, f: FileItem) => void;
}) {
  const check = (f: FileItem) =>
    selection && (
      <input
        type="checkbox"
        className="size-4 flex-none"
        aria-label={`Select ${f.displayName}`}
        checked={selection.ids.has(f.fileId)}
        disabled={!f.canMove}
        onClick={(e) => e.stopPropagation()}
        onChange={() => selection.toggle(f.fileId)}
      />
    );
  // The phone list is used for the artist app and on any phone-width screen.
  const phone = usePhone();
  if (!files) return <WaveLoader />;
  if (files.length === 0) return <p className="src pb-5">{empty}</p>;
  if (compact || phone) {
    return (
      <ul className="flex flex-col gap-1.5">
        {files.map((f) => (
          <li key={f.fileId} className="flex items-center gap-2">
            {check(f)}
            <button
              type="button"
              onClick={() => onOpen(f)}
              className="flex min-h-[52px] w-full items-center gap-3 rounded-[10px] border border-input bg-card px-3 py-2.5 text-left shadow-xs hover:bg-[#F6F8FA] dark:hover:bg-secondary"
            >
              {/* The type is in the details line; the tile would only repeat it. */}
              <span aria-hidden="true" className="flex-none">
                <Thumb f={f} size={44} />
              </span>
              <span className="min-w-0 flex-1">
                <b className="line-clamp-2 block [overflow-wrap:anywhere]">
                  {f.displayName} {f.customAccess && <CustomAccess />}
                </b>
                <span className="src">
                  {typeLabel(f)} · {formatSize(f.size)} · {date(f.createdAt)}
                  {columns.map((c) => (
                    <span key={c.label}> · {c.cell(f)}</span>
                  ))}
                </span>
                <StatusBadge f={f} />
              </span>
              <span aria-hidden="true" className="flex-none text-muted-foreground">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
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
        </tr>
      </thead>
      <tbody>
        {files.map((f) => (
          <tr
            key={f.fileId}
            className="cursor-pointer hover:bg-[#F6F8FA] dark:hover:bg-secondary"
            onClick={() => onOpen(f)}
            draggable={!!onDragStart && !!f.canMove}
            onDragStart={onDragStart ? (e) => onDragStart(e, f) : undefined}
          >
            <td>
              <span className="flex items-center gap-3">
                {check(f)}
                <Thumb f={f} size={40} />
                <span className="min-w-0">
                  <button
                    type="button"
                    className="block text-left font-bold hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(f);
                    }}
                  >
                    {f.displayName}
                  </button>{' '}
                  {f.customAccess && <CustomAccess />}
                  {f.title && <span className="src block">{f.name}</span>}
                </span>
                <StatusBadge f={f} />
              </span>
            </td>
            <td className="src">{typeLabel(f)}</td>
            <td className="src">{formatSize(f.size)}</td>
            {columns.map((c) => (
              <td key={c.label}>{c.cell(f)}</td>
            ))}
            <td className="src">{date(f.createdAt)}</td>
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
  kind = 'all',
  onOpenChange,
  openFileId,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isBmg: boolean;
  isAdmin?: boolean;
  /** Open this document's page straight away (a notification or "Where it's used" link). */
  openFileId?: string | null;
  /** Library type filter: everything, or documents only (assets have their own gallery). */
  kind?: Exclude<LibraryKind, 'assets'>;
  /** A document page opened or closed (so the screen can hide what's around it). */
  onOpenChange?: (open: boolean) => void;
}) {
  const collection = `/artists/${artistId}/files`;
  const { files, error, load } = useFiles(cfg, token, collection);
  // Which folder is open (rev 10): null is the top of the Library.
  const [place, setPlace] = useState<Place>(null);
  const inFolder = folderOf(place);
  const [visibility, setVisibility] = useState('normal');
  const [editAccess, setEditAccess] = useState('owner');
  const [filter, setFilter] = useState<ArtistFilter>('all');
  const [mine, setMine] = useState<MineFilter>('all');
  // Phones get an "Upload document" button that opens the upload page.
  const phone = usePhone();
  const [uploading, setUploading] = useState(false);
  // The document whose detail (or edit) page is open (rev 8).
  const [opened, setOpened] = useState<FileItem | null>(null);
  useEffect(() => {
    if (openFileId) setOpened({ fileId: openFileId } as FileItem);
  }, [openFileId]);
  useEffect(() => onOpenChange?.(!!opened), [opened, onOpenChange]);

  const upload = (
    <UploadBox
      cfg={cfg}
      token={token}
      collection={collection}
      title={isBmg ? 'Upload & share' : 'Upload'}
      options={() => ({
        visibility,
        ...(inFolder
          ? { folderId: inFolder, ...(visibility === 'private' ? { editAccess: 'owner' } : {}) }
          : { editAccess: visibility === 'private' ? 'owner' : editAccess }),
      })}
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
      {inFolder ? (
        <InFolderHint />
      ) : (
        visibility !== 'private' && <EditAccessSelect value={editAccess} onChange={setEditAccess} />
      )}
    </UploadBox>
  );
  const ofKind = files && (kind === 'documents' ? files.filter((f) => !f.asset) : files);
  const visible = ofKind && ofKind.filter((f) => ARTIST_FILTERS[filter].test(f));
  const columns = [
    {
      label: 'Who can see it',
      cell: (f: FileItem) => VISIBILITY_LABEL[f.visibility ?? 'normal'],
    },
    { label: 'Owner', cell: (f: FileItem) => <OwnerCell f={f} /> },
  ];

  if (opened) {
    return (
      <DocumentPage
        cfg={cfg}
        token={token}
        collection={collection}
        fileId={opened.fileId}
        initial={opened.displayName ? opened : undefined}
        onBack={() => setOpened(null)}
        onChanged={() => void load()}
        onOpenFolder={(id) => {
          setOpened(null);
          setPlace(id);
        }}
      />
    );
  }
  if (phone && uploading) return upload;
  if (!isBmg) {
    return (
      <div className="flex flex-col gap-3">
        {phone ? <UploadDocumentButton onClick={() => setUploading(true)} /> : upload}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="eyebrow pt-2 text-muted-foreground">My uploads and files</div>
        <Chips label="Show" value={mine} onChange={setMine} options={MINE_FILTER_OPTIONS} />
        <FolderBrowser
          cfg={cfg}
          token={token}
          collection={collection}
          rootLabel="My library"
          files={ofKind && ofKind.filter((f) => MINE_FILTERS[mine].test(f))}
          place={place}
          onPlace={setPlace}
          onChanged={() => void load()}
          renderFiles={(here, o) => (
            <FileTable
              files={here}
              empty={place === null ? 'No files yet.' : 'No files in this folder.'}
              onOpen={setOpened}
              columns={[
                { label: 'Who', cell: (f) => VISIBILITY_LABEL[f.visibility ?? 'normal'] },
                { label: 'Owner', cell: (f) => <OwnerCell f={f} /> },
              ]}
              compact
              selection={o.selection}
            />
          )}
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
        <FolderBrowser
          cfg={cfg}
          token={token}
          collection={collection}
          rootLabel="Library"
          files={visible}
          place={place}
          onPlace={setPlace}
          onChanged={() => void load()}
          renderFiles={(here, o) => (
            <FileTable
              files={here}
              empty={place === null ? 'No files here.' : 'No files in this folder.'}
              onOpen={setOpened}
              columns={columns}
              selection={o.selection}
              onDragStart={o.onDragStart}
            />
          )}
        />
      </Card>
      {!phone && <div className="flex-[1_1_300px]">{upload}</div>}
    </div>
  );
}

/**
 * Rev 8 filters, in every library: documents only their owner can change,
 * ones used outside chat (they can't be deleted until removed from there),
 * and the viewer's own.
 */
const OWNERSHIP_FILTERS = {
  locked: { label: 'Locked', test: (f: FileItem) => f.locked },
  'in-use': { label: 'In use', test: (f: FileItem) => !!f.inUse },
  mine: { label: 'Owned by me', test: (f: FileItem) => f.ownedByMe },
} as const;

/** The artist's own Library: everything, or one of the rev 8 filters. */
const MINE_FILTERS = { all: { label: 'All', test: () => true }, ...OWNERSHIP_FILTERS } as const;
type MineFilter = keyof typeof MINE_FILTERS;
const MINE_FILTER_OPTIONS = (Object.keys(MINE_FILTERS) as MineFilter[]).map((id) => ({
  id,
  label: MINE_FILTERS[id].label,
}));

/** Blueprint's library: who it's shared with, or one of the rev 8 filters (no "In use":
 * library documents are only ever posted in chats, which don't count). */
const LIBRARY_FILTERS = {
  all: { label: 'All', test: () => true },
  'all-artists': { label: 'All artists', test: (f: FileItem) => f.sharing === 'all-artists' },
  selected: { label: 'Selected artists', test: (f: FileItem) => f.sharing === 'selected' },
  'bmg-only': {
    label: 'BMG only',
    test: (f: FileItem) => (f.sharing ?? 'bmg-only') === 'bmg-only',
  },
  locked: OWNERSHIP_FILTERS.locked,
  mine: OWNERSHIP_FILTERS.mine,
} as const;
type LibraryFilter = keyof typeof LIBRARY_FILTERS;
const LIBRARY_FILTER_OPTIONS = (Object.keys(LIBRARY_FILTERS) as LibraryFilter[]).map((id) => ({
  id,
  label: LIBRARY_FILTERS[id].label,
}));

const ARTIST_FILTERS = {
  all: { label: 'All', test: () => true },
  shared: { label: 'Shared', test: (f: FileItem) => f.visibility === 'normal' },
  'bmg-only': { label: 'BMG only', test: (f: FileItem) => f.visibility === 'bmg-only' },
  artist: { label: 'From the artist', test: (f: FileItem) => f.uploaderRole === 'artist' },
  bmg: { label: 'From Blueprint', test: (f: FileItem) => f.uploaderRole !== 'artist' },
  scanning: { label: 'Scanning or rejected', test: (f: FileItem) => f.status !== 'available' },
  ...OWNERSHIP_FILTERS,
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
  artists,
  openFileId,
  onClosed,
  onOpenChange,
}: {
  cfg: AppConfig;
  token: string;
  isBmg: boolean;
  isAdmin?: boolean;
  artists: ArtistSummary[];
  /** Open this document's page straight away (from a Studio HQ card). */
  openFileId?: string | null;
  /** The opened document was closed. */
  onClosed?: () => void;
  /** A document page opened or closed (so the screen can hide what's around it). */
  onOpenChange?: (open: boolean) => void;
}) {
  const collection = '/library/files';
  const { files, error, load } = useFiles(cfg, token, collection);
  const [place, setPlace] = useState<Place>(null);
  const inFolder = folderOf(place);
  const [sharing, setSharing] = useState('bmg-only');
  const [editAccess, setEditAccess] = useState('everyone');
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('all');
  const names = Object.fromEntries(artists.map((a) => [a.artistId, a.displayName]));
  const phone = usePhone();
  const [uploading, setUploading] = useState(false);
  const [opened, setOpened] = useState<FileItem | null>(null);
  // Opened from elsewhere (a Studio HQ card): show that document's page.
  useEffect(() => {
    if (openFileId) setOpened({ fileId: openFileId } as FileItem);
  }, [openFileId]);
  useEffect(() => onOpenChange?.(!!opened), [opened, onOpenChange]);
  const back = () => {
    setOpened(null);
    onClosed?.();
  };

  if (opened) {
    return (
      <DocumentPage
        cfg={cfg}
        token={token}
        collection={collection}
        fileId={opened.fileId}
        initial={opened.displayName ? opened : undefined}
        artists={artists}
        onBack={back}
        onChanged={() => void load()}
        onOpenFolder={(id) => {
          back();
          setPlace(id);
        }}
      />
    );
  }

  if (!isBmg) {
    return (
      <div className="flex flex-col gap-3">
        {error && <Notice tone="error">{error}</Notice>}
        <FolderBrowser
          cfg={cfg}
          token={token}
          collection={collection}
          rootLabel="Library"
          files={files}
          place={place}
          onPlace={setPlace}
          onChanged={() => void load()}
          renderFiles={(here) => (
            <FileTable
              files={here}
              empty={
                place === null ? 'Nothing has been shared with you yet.' : 'Nothing in this folder.'
              }
              onOpen={setOpened}
              columns={[]}
              compact
            />
          )}
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
      options={() => (inFolder ? { folderId: inFolder, editAccess } : { sharing, editAccess })}
      onDone={() => void load()}
      asPage={phone}
      onBack={() => setUploading(false)}
    >
      {inFolder ? (
        <InFolderHint />
      ) : (
        <>
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
            To share with chosen artists, upload first, then open the document and choose Edit.
          </span>
        </>
      )}
      <EditAccessSelect value={editAccess} onChange={setEditAccess} team />
    </UploadBox>
  );
  if (phone && uploading) return uploadBox;

  const visible = files && files.filter((f) => LIBRARY_FILTERS[libraryFilter].test(f));
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
          options={LIBRARY_FILTER_OPTIONS}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <FolderBrowser
          cfg={cfg}
          token={token}
          collection={collection}
          rootLabel="Library"
          files={visible}
          place={place}
          onPlace={setPlace}
          onChanged={() => void load()}
          renderFiles={(here, o) => (
            <FileTable
              files={here}
              empty={place === null ? 'Nothing here.' : 'No files in this folder.'}
              onOpen={setOpened}
              selection={o.selection}
              onDragStart={o.onDragStart}
              columns={[
                {
                  label: 'Shared with',
                  cell: (f) =>
                    f.folderId || f.customAccess
                      ? 'Folder access'
                      : f.sharing === 'selected'
                        ? f.sharedWithArtistIds.map((id) => names[id] ?? 'Artist').join(', ') ||
                          'Nobody'
                        : SHARING_LABEL[f.sharing ?? 'bmg-only'],
                },
                { label: 'Owner', cell: (f) => <OwnerCell f={f} /> },
              ]}
            />
          )}
        />
      </Card>
      {!phone && <div className="flex flex-[1_1_300px] flex-col gap-5">{uploadBox}</div>}
    </div>
  );
}
