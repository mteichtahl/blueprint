import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import {
  fileTypeOf,
  formatSize,
  linkFor,
  MAX_UPLOAD_BYTES,
  postToS3,
  type FileItem,
} from '../lib/files.ts';
import { makeThumbnail, THUMB_MAX_BYTES } from '../lib/thumbnail.ts';
import { FileThumb } from './FileThumb.tsx';
import { Button, Icon, Notice, WaveLoader } from './ui.tsx';

/**
 * Gig media: photos and videos of a gig, on the gig's page. Several can be
 * picked or dropped at once. The API names each one `<gig>_<img|video>_<00001>`
 * and files it in the artist's Library under gigs › year › month › day (made
 * on the first upload); who can see and add them follows that folder's
 * access (rev 10), so the list only shows what you can open.
 */

type Target = { url: string; fields: Record<string, string> };
interface MediaList {
  folder: string;
  /** The day folder, once the first upload has made it. */
  folderId: string | null;
  canAdd: boolean;
  files: FileItem[];
}
interface Sending {
  id: string;
  name: string;
  /** The name the API gave it, once known. */
  savedAs?: string;
  state: 'waiting' | 'sending' | 'done' | 'failed';
  error?: string;
}

/** Matches the API's limit per request; bigger selections go in batches. */
export const MEDIA_BATCH = 20;
const PARALLEL = 3;

export const isMedia = (f: { type: string; name: string }) => {
  const kind = fileTypeOf(f).kind;
  return (kind === 'image' || kind === 'video') && f.type !== 'image/svg+xml';
};

/** Splits a selection into what can go up and why the rest can't. */
export function sortPicked(files: File[]) {
  const ok: File[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (!isMedia(f)) skipped.push(`${f.name} isn’t a photo or video`);
    else if (f.size === 0) skipped.push(`${f.name} is empty`);
    else if (f.size > MAX_UPLOAD_BYTES) skipped.push(`${f.name} is over 500 MB`);
    else ok.push(f);
  }
  return { ok, skipped };
}

async function inPool<T>(items: T[], n: number, run: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) await run(t);
    }),
  );
}

export function GigMedia({
  cfg,
  token,
  artistId,
  gigId,
}: {
  cfg: AppConfig;
  token: string;
  artistId: string;
  gigId: string;
}) {
  // Gig media goes through the artist's files: listed with ?gigId, uploaded with a gigId.
  const files = `/artists/${artistId}/files`;
  const [data, setData] = useState<MediaList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = sending.some((s) => s.state === 'waiting' || s.state === 'sending');

  const load = useCallback(async () => {
    try {
      setData(await api<MediaList>(cfg, token, 'GET', `${files}?gigId=${gigId}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t load the photos and videos');
    }
  }, [cfg, token, files, gigId]);
  useEffect(() => void load(), [load]);

  // While anything is still being checked for malware, look again every few seconds.
  const scanning = data?.files.some((f) => f.status === 'pending') ?? false;
  useEffect(() => {
    if (!scanning || busy) return;
    const t = setTimeout(() => void load(), 4000);
    return () => clearTimeout(t);
  }, [scanning, busy, data, load]);

  const mark = (id: string, s: Partial<Sending>) =>
    setSending((all) => all.map((x) => (x.id === id ? { ...x, ...s } : x)));

  async function add(picked: File[]) {
    const { ok, skipped: no } = sortPicked(picked);
    setSkipped(no);
    setError(null);
    if (!ok.length) return;
    const rows = ok.map((f, i) => ({
      id: `${Date.now()}-${i}`,
      name: f.name,
      state: 'waiting' as const,
    }));
    setSending((all) => [...all.filter((s) => s.state === 'failed'), ...rows]);
    for (let b = 0; b < ok.length; b += MEDIA_BATCH) {
      const batch = ok.slice(b, b + MEDIA_BATCH);
      const ids = rows.slice(b, b + MEDIA_BATCH).map((r) => r.id);
      const thumbs = await Promise.all(
        batch.map((f) =>
          makeThumbnail(f)
            .then((t) => (t && t.size <= THUMB_MAX_BYTES ? t : null))
            .catch(() => null),
        ),
      );
      let res: { files: { file: FileItem; upload: Target; thumbUpload: Target | null }[] };
      try {
        res = await api(cfg, token, 'POST', files, {
          gigId,
          files: batch.map((f, i) => ({
            name: f.name,
            size: f.size,
            contentType: f.type || 'application/octet-stream',
            ...(thumbs[i]
              ? { thumbnail: { size: thumbs[i].size, contentType: thumbs[i].type } }
              : {}),
          })),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'The upload didn’t go through';
        ids.forEach((id) => mark(id, { state: 'failed', error: msg }));
        continue;
      }
      await inPool(
        batch.map((f, i) => ({ f, i })),
        PARALLEL,
        async ({ f, i }) => {
          const id = ids[i]!;
          const r = res.files[i]!;
          mark(id, { state: 'sending', savedAs: r.file.name });
          try {
            await postToS3(r.upload, f);
            if (thumbs[i] && r.thumbUpload)
              await postToS3(r.thumbUpload, thumbs[i]).catch(() => {});
            mark(id, { state: 'done' });
          } catch (e) {
            mark(id, {
              state: 'failed',
              error: e instanceof Error ? e.message : 'The upload didn’t go through',
            });
          }
        },
      );
    }
    await load();
    // Clear the finished rows; failures stay so they can be seen.
    setSending((all) => all.filter((s) => s.state === 'failed'));
  }

  async function open(f: FileItem) {
    try {
      window.open(await linkFor(cfg, token, `${files}/${f.fileId}`), '_blank');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t open it');
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (data?.canAdd && !busy) void add([...e.dataTransfer.files]);
  };
  const done = sending.filter((s) => s.state === 'done').length;

  return (
    <section
      className={`flex flex-col gap-2 rounded-lg ${over ? 'outline-2 outline-offset-4 outline-dashed outline-[#5C6775]' : ''}`}
      aria-label="Photos and videos"
      onDragOver={(e) => {
        if (!data?.canAdd) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2">
        <b className="flex-1 text-[15px]">
          Photos and videos{data ? ` · ${data.files.length}` : ''}
        </b>
        {data?.canAdd && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              accept="image/*,video/*"
              className="sr-only"
              aria-label="Choose photos and videos"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void add(files);
              }}
            />
            <Button size="sm" variant="cta" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="upload" size={16} />
              {busy ? `Uploading ${done} of ${sending.length}…` : 'Add photos and videos'}
            </Button>
          </>
        )}
      </div>
      {data && (
        <span className="src">
          {data.canAdd
            ? `Saved in the Library under ${data.folder}. Pick several at once, or drop them here.`
            : `In the Library under ${data.folder}. You can view these, but adding needs Can edit on that folder.`}
        </span>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {skipped.length > 0 && (
        <Notice tone="error">
          {skipped.length === 1
            ? skipped[0]
            : `${skipped.length} files were skipped: ${skipped.join('; ')}`}
          . Only photos and videos up to 500 MB can be added.
        </Notice>
      )}
      {sending.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-live="polite">
          {sending.map((s) => (
            <li
              key={s.id}
              className={s.state === 'failed' ? 'text-[#8E2F2C]' : 'text-muted-foreground'}
            >
              {s.savedAs ?? s.name}
              {' · '}
              {s.state === 'failed'
                ? `didn’t upload: ${s.error}`
                : s.state === 'done'
                  ? 'uploaded'
                  : s.state === 'sending'
                    ? 'uploading…'
                    : 'waiting'}
            </li>
          ))}
        </ul>
      )}
      {data === null && !error ? (
        <WaveLoader />
      ) : data && data.files.length === 0 ? (
        <p className="src">No photos or videos from this gig yet.</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {data?.files.map((f) => (
            <li key={f.fileId}>
              <button
                type="button"
                className="flex w-full flex-col items-center gap-1 rounded-lg p-1 text-left hover:bg-secondary disabled:cursor-default"
                disabled={f.status !== 'available'}
                onClick={() => void open(f)}
                title={f.name}
              >
                <FileThumb
                  src={f.thumbnailUrl}
                  kind={f.fileType.kind}
                  ext={f.fileType.ext}
                  label={f.fileType.label}
                  size={88}
                  loading={f.status === 'pending' && !f.thumbnailUrl}
                />
                <span className="w-full truncate text-xs">{f.name}</span>
                <span className="src w-full truncate text-[11px]">
                  {f.status === 'pending'
                    ? 'Checking…'
                    : f.status === 'rejected'
                      ? 'Not kept'
                      : formatSize(f.size)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
