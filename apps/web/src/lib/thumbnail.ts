/**
 * Previews for uploads. The browser already has the file, so it draws a small
 * picture of it before uploading: an image scaled down, a frame from a video,
 * or the first page of a PDF. Everything else (audio, Office files, archives)
 * gets no preview and lists show a tile for its type instead.
 *
 * The preview is a WebP (or PNG/JPEG where WebP can't be made) of at most
 * 320px and 64 KB. It's uploaded next to the file and scanned like it.
 */

const MAX_SIDE = 320;
export const THUMB_MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 12_000;

type Drawable = CanvasImageSource & { width?: number; height?: number };

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const toBlob = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((r) => c.toBlob(r, type, quality));

/** Scales a picture into a canvas no bigger than 320px and encodes it small. */
async function encode(src: Drawable, w: number, h: number): Promise<Blob | null> {
  if (!w || !h) return null;
  for (let side = MAX_SIDE; side >= 120; side = Math.round(side * 0.75)) {
    const scale = Math.min(1, side / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    const webp = await toBlob(canvas, 'image/webp', 0.8);
    if (webp && webp.type === 'image/webp' && webp.size <= THUMB_MAX_BYTES) return webp;
    // No WebP encoder (older Safari): PNG keeps transparency; JPEG if PNG is too big.
    const png = await toBlob(canvas, 'image/png');
    if (png && png.size <= THUMB_MAX_BYTES) return png;
    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const f = flat.getContext('2d')!;
    f.fillStyle = '#ffffff';
    f.fillRect(0, 0, flat.width, flat.height);
    f.drawImage(canvas, 0, 0);
    const jpeg = await toBlob(flat, 'image/jpeg', 0.8);
    if (jpeg && jpeg.size <= THUMB_MAX_BYTES) return jpeg;
  }
  return null;
}

/**
 * A local URL for a picked file. Only a browser-made `blob:` URL is ever put
 * in an element's src here, so file contents or names can't become markup or a
 * `javascript:` URL.
 */
function localUrl(file: Blob): string {
  const made = URL.createObjectURL(file);
  if (!/^blob:/.test(made)) {
    URL.revokeObjectURL(made);
    throw new Error('Not a local file URL');
  }
  return made;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Not an image this browser can open'));
    img.src = url;
  });
}

async function imageThumb(file: File): Promise<Blob | null> {
  const url = localUrl(file);
  try {
    const img = await loadImage(url);
    // SVGs without a size report 0; give them one.
    return encode(img, img.naturalWidth || 512, img.naturalHeight || 512);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function videoThumb(file: File): Promise<Blob | null> {
  const url = localUrl(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    if (!url.startsWith('blob:')) throw new Error('Not a local file URL');
    v.src = url;
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error("This browser can't open that video"));
    });
    // A moment in, so it isn't a black first frame.
    const at = Number.isFinite(v.duration) ? Math.min(1, v.duration * 0.1) : 0;
    if (at > 0) {
      await new Promise<void>((resolve) => {
        v.onseeked = () => resolve();
        v.currentTime = at;
      });
    }
    return encode(v, v.videoWidth, v.videoHeight);
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

async function pdfThumb(file: File): Promise<Blob | null> {
  // Loaded only when a PDF is picked (pdf.js is large).
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    disableFontFace: true,
  }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: (MAX_SIDE * 2) / Math.max(base.width, base.height),
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return encode(canvas, canvas.width, canvas.height);
  } finally {
    void doc.destroy();
  }
}

/** Biggest files we'll read just to draw a preview. */
const LIMITS = { image: 60e6, pdf: 80e6 } as const;

/**
 * A small preview of the file, or null when there isn't one to make (the type
 * has no picture, the browser can't open it, or it takes too long).
 */
export async function makeThumbnail(file: File): Promise<Blob | null> {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  try {
    if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/.test(name)) {
      return file.size <= LIMITS.image ? await withTimeout(imageThumb(file)) : null;
    }
    if (type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/.test(name)) {
      return await withTimeout(videoThumb(file));
    }
    if (type === 'application/pdf' || name.endsWith('.pdf')) {
      return file.size <= LIMITS.pdf ? await withTimeout(pdfThumb(file), 20_000) : null;
    }
  } catch {
    // No preview is fine: the list shows the type's tile.
  }
  return null;
}
