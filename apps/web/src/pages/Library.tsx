import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ArtistSummary } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { download, formatSize, uploadFile, waitUntilScanned, type FileItem } from '../lib/files.ts';
import { Button, Card, Chips, DataTable, Icon, Notice, shortDate, Tag } from '../components/ui.tsx';

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

/** Pick a file, upload it, then wait for the malware scan. */
function UploadBox({
  cfg,
  token,
  collection,
  options,
  children,
  onDone,
  title = 'Upload',
}: {
  cfg: AppConfig;
  token: string;
  collection: string;
  /** Extra fields for the upload request (visibility or sharing). */
  options: () => Record<string, unknown>;
  children?: React.ReactNode;
  onDone: () => void;
  title?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function go() {
    if (!file) return;
    setResult(null);
    try {
      setBusy('Uploading…');
      const created = await uploadFile(cfg, token, collection, file, options());
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
            ? { tone: 'success', text: `${file.name} is ready.` }
            : {
                tone: 'error',
                text: `${file.name} was not kept: ${settled.rejectReason ?? 'it failed the scan'}.`,
              },
      );
      setFile(null);
      if (input.current) input.current.value = '';
    } catch (e) {
      setResult({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      onDone();
    }
  }

  return (
    <Card title={title}>
      <label className="flex min-h-[96px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[#9AA4B0] bg-background px-4 py-4 text-center">
        <Icon name="upload" size={22} />
        <b className="text-[15px]">{file ? file.name : 'Choose a file'}</b>
        <span className="src">
          {file ? formatSize(file.size) : 'Up to 500 MB · scanned for malware first'}
        </span>
        <input
          ref={input}
          type="file"
          className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {children}
      <Button variant="cta" disabled={!file || !!busy} onClick={() => void go()}>
        {busy ?? 'Upload'}
      </Button>
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
    </Card>
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

function FileTable({
  files,
  empty,
  columns,
  onOpen,
  compact = false,
}: {
  files: FileItem[] | null;
  empty: string;
  columns: { label: string; cell: (f: FileItem) => React.ReactNode }[];
  onOpen: (f: FileItem) => void;
  /** Phone layout: a list of rows instead of a table. */
  compact?: boolean;
}) {
  if (!files) return <p className="src">Loading…</p>;
  if (files.length === 0) return <p className="src pb-5">{empty}</p>;
  if (compact) {
    return (
      <div className="flex flex-col gap-1.5">
        {files.map((f) => (
          <button
            key={f.fileId}
            type="button"
            disabled={f.status !== 'available'}
            onClick={() => onOpen(f)}
            className="flex min-h-[52px] items-center gap-3 rounded-[10px] border border-input bg-card px-3 py-2.5 text-left shadow-xs"
          >
            <span className="appsq !bg-secondary !text-foreground">
              <Icon name="file" size={14} strokeWidth={2.4} />
            </span>
            <span className="min-w-0 flex-1">
              <b className="block truncate">{f.name}</b>
              <span className="src">
                {formatSize(f.size)} · {date(f.createdAt)}
                {columns.map((c) => (
                  <span key={c.label}> · {c.cell(f)}</span>
                ))}
              </span>
            </span>
            <StatusBadge f={f} />
          </button>
        ))}
      </div>
    );
  }
  return (
    <DataTable>
      <thead>
        <tr>
          <th scope="col">Name</th>
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
                <span className="appsq !bg-secondary !text-foreground">
                  <Icon name="file" size={14} strokeWidth={2.4} />
                </span>
                <b>{f.name}</b>
                <StatusBadge f={f} />
              </span>
            </td>
            <td className="src">{formatSize(f.size)}</td>
            {columns.map((c) => (
              <td key={c.label}>{c.cell(f)}</td>
            ))}
            <td className="src">{date(f.createdAt)}</td>
            <td className="text-right">
              <Button
                size="sm"
                variant="ghost"
                disabled={f.status !== 'available'}
                onClick={() => onOpen(f)}
              >
                <Icon name="download" size={15} />
                Open
              </Button>
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
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  isBmg: boolean;
}) {
  const collection = `/artists/${artistId}/files`;
  const { files, error, setError, load } = useFiles(cfg, token, collection);
  const [visibility, setVisibility] = useState('normal');
  const [filter, setFilter] = useState<ArtistFilter>('all');

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

  const upload = (
    <UploadBox
      cfg={cfg}
      token={token}
      collection={collection}
      title={isBmg ? 'Upload & share' : 'Upload'}
      options={() => ({ visibility })}
      onDone={() => void load()}
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
  const visible = files && files.filter((f) => ARTIST_FILTERS[filter].test(f));
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

  if (!isBmg) {
    return (
      <div className="flex flex-col gap-3">
        {upload}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="eyebrow pt-2 text-muted-foreground">My uploads and files</div>
        <FileTable
          files={files}
          empty="No files yet."
          onOpen={open}
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
        action={<span className="src">{files?.length ?? 0} files</span>}
      >
        <Chips
          label="Quick filters"
          value={filter}
          onChange={setFilter}
          options={ARTIST_FILTER_OPTIONS}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <FileTable files={visible} empty="No files here." onOpen={open} columns={columns} />
      </Card>
      <div className="flex-[1_1_300px]">{upload}</div>
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
  artists,
}: {
  cfg: AppConfig;
  token: string;
  isBmg: boolean;
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

  const open = (f: FileItem) =>
    void download(cfg, token, `${collection}/${f.fileId}`).catch((e) =>
      setError((e as Error).message),
    );

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
        <UploadBox
          cfg={cfg}
          token={token}
          collection={collection}
          title="Upload & share"
          options={() => ({ sharing })}
          onDone={() => void load()}
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
    <Card title={`Share “${file.name}”`}>
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
