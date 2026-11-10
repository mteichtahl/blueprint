import { copyrightLine, loadLogo } from './planPdf.ts';

/**
 * Export an artist's brand kit to PDF. Built in the browser with jsPDF (the
 * same way as the plan PDF), so it works in the installed phone app too, where
 * the browser's print dialog isn't available. The PDF library loads only when
 * someone exports.
 */

const NAVY = '#011935';
const CORAL = '#B5403C';
const SLATE = '#5C6775';
const PAPER = '#F1F4F7';
const INK = '#1E2833';

export interface BrandKitPdfInput {
  artistName: string;
  logos: { label: string; url?: string }[];
  logoRules: string;
  colours: { name: string; hex: string; role: string }[];
  contrast: { label: string; fg: string; bg: string; ratio: number; grade: string }[];
  fonts: { headline: string; body: string };
  voice: { words: string; sayLike: string; avoid: string; bio: string };
  socials: { label: string; value: string }[];
  imagery: { note: string; urls: (string | undefined)[] };
}

export const brandKitFileName = (artistName: string, today: string) =>
  `Brand kit - ${artistName.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Artist'} - ${today}.pdf`;

interface Img {
  data: string;
  w: number;
  h: number;
  format: 'PNG' | 'JPEG';
}

/**
 * Fetches an image (a presigned link) and re-encodes it through a canvas, so
 * any browser-readable format (WebP, HEIC on Safari, etc.) ends up as PNG or
 * JPEG for jsPDF. Undefined if it can't be read; the PDF shows a placeholder.
 */
async function loadImage(url: string | undefined, keepAlpha: boolean): Promise<Img | undefined> {
  if (!url) return;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return;
    const bitmap = await createImageBitmap(await res.blob());
    const max = 1200;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!keepAlpha) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return keepAlpha
      ? { data: canvas.toDataURL('image/png'), w, h, format: 'PNG' }
      : { data: canvas.toDataURL('image/jpeg', 0.85), w, h, format: 'JPEG' };
  } catch {
    return undefined;
  }
}

/** Builds the PDF and starts the download. */
export async function exportBrandKitPdf(kit: BrandKitPdfInput): Promise<void> {
  const [{ jsPDF }, logo, logoImgs, photoImgs] = await Promise.all([
    import('jspdf'),
    loadLogo(),
    Promise.all(kit.logos.map((l) => loadImage(l.url, true))),
    Promise.all(kit.imagery.urls.map((u) => loadImage(u, false))),
  ]);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 18;
  const textW = W - M * 2;
  let y = 0;

  const header = (first: boolean) => {
    const band = first ? 34 : 14;
    doc.setFillColor(NAVY);
    doc.rect(0, 0, W, band, 'F');
    doc.setTextColor('#FFFFFF');
    const size = band - 2;
    const textX = logo ? M + size + 4 : M;
    if (logo) doc.addImage(logo, 'PNG', M - 2, 1, size, size, 'bmg-logo', 'FAST');
    if (first) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(logo ? 'B R A N D   K I T' : 'BLUEPRINT  ·  B R A N D   K I T', textX, 16);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.text(kit.artistName, textX, 25);
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`${kit.artistName}: brand kit`, W - M, 9, { align: 'right' });
    }
    y = first ? 44 : 24;
  };
  const need = (h: number) => {
    if (y + h > H - 18) {
      doc.addPage('a4', 'portrait');
      header(false);
    }
  };
  const write = (
    text: string,
    o: { size?: number; bold?: boolean; colour?: string; indent?: number; gap?: number } = {},
  ) => {
    const size = o.size ?? 10.5;
    doc.setFont('helvetica', o.bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(o.colour ?? INK);
    const lines = doc.splitTextToSize(text, textW - (o.indent ?? 0)) as string[];
    const lh = size * 0.42;
    for (const line of lines) {
      need(lh);
      doc.text(line, M + (o.indent ?? 0), y);
      y += lh;
    }
    y += o.gap ?? 1.5;
  };
  const heading = (text: string) => {
    need(16);
    y += 3;
    write(text.toUpperCase(), { size: 9, bold: true, colour: CORAL, gap: 0.5 });
    doc.setDrawColor(CORAL);
    doc.setLineWidth(0.4);
    doc.line(M, y - 1, M + 24, y - 1);
    y += 6;
  };
  const labelled = (label: string, value: string) => {
    if (!value.trim()) return;
    write(label, { size: 9.5, bold: true, colour: NAVY, gap: 0.6 });
    write(value.trim(), { gap: 3 });
  };
  const placeholder = (x: number, top: number, w: number, h: number, text: string) => {
    doc.setFillColor(PAPER);
    doc.rect(x, top, w, h, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(SLATE);
    doc.text(text, x + w / 2, top + h / 2, { align: 'center', baseline: 'middle' });
  };
  /** An image fitted into a box, keeping its shape. */
  const fit = (img: Img, x: number, top: number, w: number, h: number) => {
    const s = Math.min(w / img.w, h / img.h);
    const iw = img.w * s;
    const ih = img.h * s;
    doc.addImage(img.data, img.format, x + (w - iw) / 2, top + (h - ih) / 2, iw, ih);
  };
  /** A grid of square tiles with optional captions. */
  const grid = (
    items: { img?: Img; caption?: string; missing: string }[],
    cols: number,
    border: boolean,
  ) => {
    const gap = 5;
    const size = (textW - gap * (cols - 1)) / cols;
    const capH = items.some((i) => i.caption) ? 6 : 0;
    for (let r = 0; r < items.length; r += cols) {
      need(size + capH + gap);
      items.slice(r, r + cols).forEach((it, c) => {
        const x = M + c * (size + gap);
        if (it.img) fit(it.img, x, y, size, size);
        else placeholder(x, y, size, size, it.missing);
        if (border) {
          doc.setDrawColor('#D3D8DE');
          doc.setLineWidth(0.3);
          doc.roundedRect(x, y, size, size, 1.5, 1.5, 'S');
        }
        if (it.caption) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(INK);
          const cap = doc.splitTextToSize(it.caption, size)[0] as string;
          doc.text(cap, x, y + size + 4.5);
        }
      });
      y += size + capH + gap;
    }
  };

  header(true);
  write(
    `Exported ${now.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    {
      size: 9,
      colour: SLATE,
      gap: 4,
    },
  );

  // ── Logos ──
  heading('Logos');
  if (kit.logos.length === 0) write('No logos added yet.', { colour: SLATE });
  else
    grid(
      kit.logos.map((l, i) => ({ img: logoImgs[i], caption: l.label, missing: 'Logo' })),
      3,
      true,
    );
  if (kit.logoRules.trim()) labelled('How to use them', kit.logoRules);

  // ── Colours ──
  heading('Colours');
  const colours = kit.colours.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c.hex));
  if (colours.length === 0) write('No colours added yet.', { colour: SLATE });
  const cols = 4;
  const gap = 5;
  const sw = (textW - gap * (cols - 1)) / cols;
  for (let r = 0; r < colours.length; r += cols) {
    need(sw * 0.6 + 14);
    colours.slice(r, r + cols).forEach((c, i) => {
      const x = M + i * (sw + gap);
      doc.setFillColor(c.hex);
      doc.setDrawColor('#D3D8DE');
      doc.setLineWidth(0.3);
      doc.roundedRect(x, y, sw, sw * 0.6, 1.5, 1.5, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(INK);
      doc.text(doc.splitTextToSize(c.name || c.hex, sw)[0] as string, x, y + sw * 0.6 + 4.5);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(SLATE);
      doc.text(`${c.hex.toUpperCase()} · ${c.role}`, x, y + sw * 0.6 + 8.8);
    });
    y += sw * 0.6 + 14;
  }
  if (kit.contrast.length) {
    write('Contrast checks', { size: 9.5, bold: true, colour: NAVY, gap: 1 });
    for (const c of kit.contrast)
      write(`${c.label}: ${c.ratio}:1 · ${c.grade}`, { size: 9.5, indent: 3, gap: 0.8 });
    y += 2;
  }

  // ── Fonts ──
  heading('Fonts');
  write(`Headlines: ${kit.fonts.headline || 'not set'}`, { gap: 1 });
  write(`Body text: ${kit.fonts.body || 'not set'}`, { gap: 2 });

  // ── Voice ──
  heading('Voice & language');
  labelled('Three words', kit.voice.words);
  labelled('Say things like', kit.voice.sayLike);
  labelled('Avoid', kit.voice.avoid);
  labelled('Short bio', kit.voice.bio);
  if (![kit.voice.words, kit.voice.sayLike, kit.voice.avoid, kit.voice.bio].some((v) => v.trim()))
    write('Nothing written yet.', { colour: SLATE });

  // ── Socials ──
  heading('Socials');
  const socials = kit.socials.filter((s) => s.value.trim());
  if (socials.length === 0) write('No socials added yet.', { colour: SLATE });
  for (const s of socials) write(`${s.label}: ${s.value.trim()}`, { gap: 1 });

  // ── Imagery ──
  heading('Photo style');
  if (kit.imagery.urls.length)
    grid(
      photoImgs.map((img) => ({ img, missing: 'Photo' })),
      4,
      false,
    );
  if (kit.imagery.note.trim()) labelled('Moodboard note', kit.imagery.note);
  if (!kit.imagery.urls.length && !kit.imagery.note.trim())
    write('No photos added yet.', { colour: SLATE });

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFillColor(PAPER);
    doc.rect(0, H - 12, W, 12, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(SLATE);
    doc.text(`${copyrightLine(now.getFullYear())}  ·  blueprintmusic.group`, M, H - 5);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 5, { align: 'right' });
  }

  doc.save(brandKitFileName(kit.artistName, today));
}
