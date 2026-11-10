/**
 * What kind of file an upload really is. The browser's claimed type is often
 * missing or generic, so after the malware scan the promoter reads the first
 * bytes and decides from those (magic numbers), using the file name's
 * extension only to tell apart formats that share a container (a .docx and an
 * .xlsx are both ZIP files). Pure, so it is unit-tested.
 */

export const FILE_KINDS = [
  'pdf',
  'image',
  'video',
  'audio',
  'document',
  'spreadsheet',
  'presentation',
  'archive',
  'text',
  'design',
  'other',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface FileTypeInfo {
  kind: FileKind;
  /** For people: "PDF", "Word document", "PNG image", "MP3 audio". */
  label: string;
  /** Lower-case, no dot ("pdf", "docx"); empty when unknown. */
  ext: string;
  /** The MIME type this most likely is. */
  mime: string;
  /** Detected from the file's bytes (true), or only guessed from its name and claimed type. */
  detected: boolean;
}

interface Known {
  kind: FileKind;
  label: string;
  mime: string;
}

/** By extension. Also the fallback when the bytes don't settle it. */
const BY_EXT: Record<string, Known> = {
  pdf: { kind: 'pdf', label: 'PDF', mime: 'application/pdf' },
  png: { kind: 'image', label: 'PNG image', mime: 'image/png' },
  jpg: { kind: 'image', label: 'JPEG image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', label: 'JPEG image', mime: 'image/jpeg' },
  gif: { kind: 'image', label: 'GIF image', mime: 'image/gif' },
  webp: { kind: 'image', label: 'WebP image', mime: 'image/webp' },
  heic: { kind: 'image', label: 'HEIC photo', mime: 'image/heic' },
  heif: { kind: 'image', label: 'HEIF photo', mime: 'image/heif' },
  avif: { kind: 'image', label: 'AVIF image', mime: 'image/avif' },
  tif: { kind: 'image', label: 'TIFF image', mime: 'image/tiff' },
  tiff: { kind: 'image', label: 'TIFF image', mime: 'image/tiff' },
  bmp: { kind: 'image', label: 'BMP image', mime: 'image/bmp' },
  svg: { kind: 'image', label: 'SVG image', mime: 'image/svg+xml' },
  ico: { kind: 'image', label: 'Icon', mime: 'image/x-icon' },
  psd: { kind: 'design', label: 'Photoshop file', mime: 'image/vnd.adobe.photoshop' },
  ai: { kind: 'design', label: 'Illustrator file', mime: 'application/postscript' },
  eps: { kind: 'design', label: 'EPS file', mime: 'application/postscript' },
  indd: { kind: 'design', label: 'InDesign file', mime: 'application/x-indesign' },
  fig: { kind: 'design', label: 'Figma file', mime: 'application/octet-stream' },
  mp4: { kind: 'video', label: 'MP4 video', mime: 'video/mp4' },
  m4v: { kind: 'video', label: 'MP4 video', mime: 'video/x-m4v' },
  mov: { kind: 'video', label: 'QuickTime video', mime: 'video/quicktime' },
  webm: { kind: 'video', label: 'WebM video', mime: 'video/webm' },
  mkv: { kind: 'video', label: 'MKV video', mime: 'video/x-matroska' },
  avi: { kind: 'video', label: 'AVI video', mime: 'video/x-msvideo' },
  mp3: { kind: 'audio', label: 'MP3 audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', label: 'WAV audio', mime: 'audio/wav' },
  aif: { kind: 'audio', label: 'AIFF audio', mime: 'audio/aiff' },
  aiff: { kind: 'audio', label: 'AIFF audio', mime: 'audio/aiff' },
  flac: { kind: 'audio', label: 'FLAC audio', mime: 'audio/flac' },
  m4a: { kind: 'audio', label: 'M4A audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', label: 'AAC audio', mime: 'audio/aac' },
  ogg: { kind: 'audio', label: 'Ogg audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', label: 'Opus audio', mime: 'audio/opus' },
  doc: { kind: 'document', label: 'Word document', mime: 'application/msword' },
  docx: {
    kind: 'document',
    label: 'Word document',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  odt: {
    kind: 'document',
    label: 'OpenDocument text',
    mime: 'application/vnd.oasis.opendocument.text',
  },
  rtf: { kind: 'document', label: 'Rich text', mime: 'application/rtf' },
  pages: { kind: 'document', label: 'Pages document', mime: 'application/vnd.apple.pages' },
  xls: { kind: 'spreadsheet', label: 'Excel spreadsheet', mime: 'application/vnd.ms-excel' },
  xlsx: {
    kind: 'spreadsheet',
    label: 'Excel spreadsheet',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  ods: {
    kind: 'spreadsheet',
    label: 'OpenDocument spreadsheet',
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
  },
  numbers: {
    kind: 'spreadsheet',
    label: 'Numbers spreadsheet',
    mime: 'application/vnd.apple.numbers',
  },
  csv: { kind: 'spreadsheet', label: 'CSV', mime: 'text/csv' },
  ppt: { kind: 'presentation', label: 'PowerPoint', mime: 'application/vnd.ms-powerpoint' },
  pptx: {
    kind: 'presentation',
    label: 'PowerPoint',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  odp: {
    kind: 'presentation',
    label: 'OpenDocument presentation',
    mime: 'application/vnd.oasis.opendocument.presentation',
  },
  key: { kind: 'presentation', label: 'Keynote', mime: 'application/vnd.apple.keynote' },
  zip: { kind: 'archive', label: 'ZIP archive', mime: 'application/zip' },
  rar: { kind: 'archive', label: 'RAR archive', mime: 'application/vnd.rar' },
  '7z': { kind: 'archive', label: '7-Zip archive', mime: 'application/x-7z-compressed' },
  gz: { kind: 'archive', label: 'Gzip archive', mime: 'application/gzip' },
  tar: { kind: 'archive', label: 'TAR archive', mime: 'application/x-tar' },
  txt: { kind: 'text', label: 'Text', mime: 'text/plain' },
  md: { kind: 'text', label: 'Markdown', mime: 'text/markdown' },
  json: { kind: 'text', label: 'JSON', mime: 'application/json' },
  xml: { kind: 'text', label: 'XML', mime: 'application/xml' },
  html: { kind: 'text', label: 'HTML', mime: 'text/html' },
  htm: { kind: 'text', label: 'HTML', mime: 'text/html' },
};

/** Extensions that are ZIP files underneath. */
const ZIP_BASED = new Set([
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'pages',
  'numbers',
  'key',
  'zip',
  'fig',
  'indd',
]);
/** Extensions that are OLE2 (old Office) files underneath. */
const OLE_BASED = new Set(['doc', 'xls', 'ppt']);

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return m ? m[1]!.toLowerCase() : '';
}

const info = (k: Known, ext: string, detected: boolean): FileTypeInfo => ({ ...k, ext, detected });

/** From the name and the browser's claimed type only (before the bytes are checked). */
export function guessFileType(name: string, claimed = ''): FileTypeInfo {
  const ext = extensionOf(name);
  const byExt = BY_EXT[ext];
  if (byExt) return info(byExt, ext, false);
  const mime = claimed.toLowerCase();
  const fromMime = Object.entries(BY_EXT).find(([, k]) => k.mime === mime);
  if (fromMime) return info(fromMime[1], fromMime[0], false);
  const top = mime.split('/')[0];
  if (top === 'image' || top === 'video' || top === 'audio')
    return {
      kind: top,
      label: `${top[0]!.toUpperCase()}${top.slice(1)}`,
      ext,
      mime,
      detected: false,
    };
  if (top === 'text') return { kind: 'text', label: 'Text', ext, mime, detected: false };
  return {
    kind: 'other',
    label: ext ? `${ext.toUpperCase()} file` : 'File',
    ext,
    mime: mime || 'application/octet-stream',
    detected: false,
  };
}

const ascii = (b: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...b.subarray(start, start + len));
const has = (b: Uint8Array, at: number, ...bytes: number[]) =>
  b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);

/** Names of the first entries in a ZIP (from local file headers in `head`). */
function zipEntryNames(b: Uint8Array): string[] {
  const names: string[] = [];
  let i = 0;
  while (i + 30 <= b.length && names.length < 40) {
    if (!has(b, i, 0x50, 0x4b, 0x03, 0x04)) break;
    const v = new DataView(b.buffer, b.byteOffset + i, 30);
    const compressed = v.getUint32(18, true);
    const nameLen = v.getUint16(26, true);
    const extraLen = v.getUint16(28, true);
    names.push(ascii(b, i + 30, nameLen));
    const flags = v.getUint16(6, true);
    // A streamed entry (data descriptor) doesn't record its size up front: stop.
    if (flags & 0x08 || compressed === 0xffffffff) break;
    i += 30 + nameLen + extraLen + compressed;
  }
  return names;
}

function zipKind(b: Uint8Array, ext: string): FileTypeInfo {
  const names = zipEntryNames(b);
  const any = (re: RegExp) => names.some((n) => re.test(n));
  if (any(/^word\//)) return info(BY_EXT.docx!, 'docx', true);
  if (any(/^xl\//)) return info(BY_EXT.xlsx!, 'xlsx', true);
  if (any(/^ppt\//)) return info(BY_EXT.pptx!, 'pptx', true);
  // OpenDocument: the first entry is "mimetype", stored uncompressed.
  const odf = /application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)/.exec(
    ascii(b, 0, Math.min(b.length, 200)),
  );
  if (odf) {
    const e = odf[1] === 'text' ? 'odt' : odf[1] === 'spreadsheet' ? 'ods' : 'odp';
    return info(BY_EXT[e]!, e, true);
  }
  // The header alone can't tell an .xlsx from a .docx when [Content_Types].xml
  // fills the first bytes; trust a ZIP-based extension.
  if (ZIP_BASED.has(ext)) return info(BY_EXT[ext]!, ext, true);
  return info(BY_EXT.zip!, 'zip', true);
}

/** ISO base media (MP4, MOV, M4A, HEIC, AVIF): the brand after "ftyp". */
function isoKind(b: Uint8Array, ext: string): FileTypeInfo | null {
  if (ascii(b, 4, 4) !== 'ftyp') return null;
  const brand = ascii(b, 8, 4).toLowerCase();
  if (/^(heic|heix|hevc|mif1|msf1)/.test(brand))
    return info(
      ext === 'heif' ? BY_EXT.heif! : BY_EXT.heic!,
      ext === 'heif' ? 'heif' : 'heic',
      true,
    );
  if (brand.startsWith('avif')) return info(BY_EXT.avif!, 'avif', true);
  if (brand.startsWith('qt')) return info(BY_EXT.mov!, 'mov', true);
  if (/^(m4a |m4b |m4p )/.test(brand) || ext === 'm4a') return info(BY_EXT.m4a!, 'm4a', true);
  return info(BY_EXT.mp4!, ext === 'm4v' ? 'm4v' : 'mp4', true);
}

/** Plain text: valid UTF-8 with no control characters other than whitespace. */
function looksLikeText(b: Uint8Array): boolean {
  if (b.length === 0) return false;
  const sample = b.subarray(0, 4096);
  for (const c of sample)
    if (c === 0 || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(
      sample.subarray(0, Math.max(0, sample.length - 4)),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The file's type from its first bytes (at least the first 4 KB; 64 KB lets
 * Office files be told apart without the extension).
 */
export function detectFileType(head: Uint8Array, name: string, claimed = ''): FileTypeInfo {
  const ext = extensionOf(name);
  const b = head;
  const hit = (e: string) => info(BY_EXT[e]!, e, true);

  if (ascii(b, 0, 5) === '%PDF-') return hit('pdf');
  if (has(b, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return hit('png');
  if (has(b, 0, 0xff, 0xd8, 0xff)) return hit(ext === 'jpeg' ? 'jpeg' : 'jpg');
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return hit('gif');
  if (ascii(b, 0, 4) === 'RIFF') {
    const sub = ascii(b, 8, 4);
    if (sub === 'WEBP') return hit('webp');
    if (sub === 'WAVE') return hit('wav');
    if (sub === 'AVI ') return hit('avi');
  }
  if (has(b, 0, 0x49, 0x49, 0x2a, 0x00) || has(b, 0, 0x4d, 0x4d, 0x00, 0x2a)) return hit('tiff');
  if (ascii(b, 0, 2) === 'BM' && b.length > 26) return hit('bmp');
  if (ascii(b, 0, 4) === '8BPS') return hit('psd');
  const iso = isoKind(b, ext);
  if (iso) return iso;
  if (has(b, 0, 0x1a, 0x45, 0xdf, 0xa3)) return hit(ext === 'mkv' ? 'mkv' : 'webm'); // Matroska / WebM
  if (
    ascii(b, 0, 3) === 'ID3' ||
    (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 && ((b[1] ?? 0) & 0x06) !== 0)
  )
    return hit('mp3');
  if (ascii(b, 0, 4) === 'fLaC') return hit('flac');
  if (ascii(b, 0, 4) === 'OggS') return hit(ext === 'opus' ? 'opus' : 'ogg');
  if (ascii(b, 0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(b, 8, 4))) return hit('aiff');
  if (has(b, 0, 0xff, 0xf1) || has(b, 0, 0xff, 0xf9)) return hit('aac');
  if (has(b, 0, 0x50, 0x4b, 0x03, 0x04)) return zipKind(b, ext);
  if (has(b, 0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))
    return hit(OLE_BASED.has(ext) ? ext : 'doc');
  if (ascii(b, 0, 4) === 'Rar!') return hit('rar');
  if (has(b, 0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return hit('7z');
  if (has(b, 0, 0x1f, 0x8b)) return hit('gz');
  if (ascii(b, 257, 5) === 'ustar') return hit('tar');
  if (ascii(b, 0, 5) === '{\\rtf') return hit('rtf');
  if (ascii(b, 0, 4) === '%!PS') return hit(ext === 'ai' ? 'ai' : 'eps');

  if (looksLikeText(b)) {
    const text = new TextDecoder()
      .decode(b.subarray(0, 1024))
      .trimStart()
      .replace(/^\uFEFF/, '');
    if (/^<svg[\s>/]/i.test(text) || (/^<\?xml/i.test(text) && /<svg[\s>]/i.test(text)))
      return hit('svg');
    if (/^<!doctype html|^<html[\s>]/i.test(text)) return hit('html');
    // A text extension we know (csv, md, json…) is as good as it gets for text.
    const known = BY_EXT[ext];
    if (known && (known.kind === 'text' || ext === 'csv')) return info(known, ext, true);
    return hit('txt');
  }
  // Bytes we don't recognise: keep the guess, but say it wasn't confirmed.
  return guessFileType(name, claimed);
}
