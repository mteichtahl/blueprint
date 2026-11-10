import { createElement } from 'react';
import type { Plan, PlanChange } from './api.ts';
import { layoutTimeline } from './timeline.ts';

/**
 * Export an artist's plan to PDF (rev 7): always the whole plan, branded,
 * with the Gantt chart. Rev 8 adds the official logo in the header, a
 * copyright line in the footer and a timeline of the plan's changes. Built in
 * the browser, so nothing leaves the app; the PDF libraries load only when
 * someone exports.
 */

const NAVY = '#011935';
const CORAL = '#B5403C';
const SLATE = '#5C6775';
const PAPER = '#F1F4F7';

export interface TextBlock {
  kind: 'heading' | 'bullet' | 'para' | 'quote';
  text: string;
}

/** Plan text is Markdown; the PDF keeps its shape (headings, bullets, quotes) as plain text. */
export function markdownToBlocks(md: string): TextBlock[] {
  const inline = (s: string) =>
    s
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(.+?)\1/g, '$2')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
  const blocks: TextBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'para', text: inline(para.join(' ')) });
    para = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const b = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    const q = line.match(/^>\s?(.*)$/);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', text: inline(h[1]!) });
    } else if (b) {
      flush();
      blocks.push({ kind: 'bullet', text: inline(b[1]!) });
    } else if (q) {
      flush();
      blocks.push({ kind: 'quote', text: inline(q[1]!) });
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return blocks.filter((b) => b.text);
}

/**
 * The official white-on-navy logo (2000×2000 PNG), the same file the emails
 * use. It's placed as supplied, never redrawn; until it's deployed the PDF
 * falls back to the BLUEPRINT wordmark in text.
 */
export const LOGO_PATH = '/brand/bmg-logo-white-on-navy.png';

export const copyrightLine = (year: number) =>
  `© ${year} Blueprint Music Group. All rights reserved.`;

/** Changes in the order they happened, for the PDF's timeline (the API sends newest first). */
export const changesOldestFirst = (changes: readonly PlanChange[]) =>
  [...changes].sort((a, b) => a.at.localeCompare(b.at) || a.version - b.version);

/** The logo's PNG bytes, or undefined if it isn't there (the app's fallback page isn't a PNG). */
export async function loadLogo(): Promise<Uint8Array | undefined> {
  try {
    const res = await fetch(LOGO_PATH);
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/png')) return;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return undefined;
  }
}

export const pdfFileName = (artistName: string, today: string) =>
  `Plan - ${artistName.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Artist'} - ${today}.pdf`;

const day = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/** Builds the PDF and starts the download. */
export async function exportPlanPdf(opts: {
  artistName: string;
  plan: Pick<Plan, 'outcome' | 'measures' | 'phases'>;
  gaps: string[];
  /** The plan's change history (rev 8), newest first as the API sends it. */
  changes?: PlanChange[];
}): Promise<void> {
  const [{ jsPDF }, { svg2pdf }, server, { TimelineSvg }, logo] = await Promise.all([
    import('jspdf'),
    import('svg2pdf.js'),
    import('react-dom/server'),
    import('../components/PlanTimeline.tsx'),
    loadLogo(),
  ]);
  // react-dom/server is CommonJS: depending on the bundler its exports may sit on `default`.
  const renderToStaticMarkup = server.renderToStaticMarkup ?? server.default.renderToStaticMarkup;
  const { artistName, plan, gaps } = opts;
  // The person's own date, not UTC (Melbourne is ahead of UTC most of the day).
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
    // The logo's navy background matches the band, so it sits in it as supplied.
    const size = band - 2;
    const textX = logo ? M + size + 4 : M;
    if (logo) doc.addImage(logo, 'PNG', M - 2, 1, size, size, 'bmg-logo', 'FAST');
    if (first) {
      if (!logo) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text('BLUEPRINT', M, 13);
        doc.setFontSize(6.5);
        doc.setFont('helvetica', 'normal');
        doc.text('M U S I C   G R O U P', M, 17.5);
      } else {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.text('A R T I S T   P L A N', textX, 16);
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.text(logo ? artistName : `${artistName}: artist plan`, textX, logo ? 25 : 28);
    } else {
      if (!logo) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.text('BLUEPRINT', M, 9);
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`${artistName}: artist plan`, W - M, 9, { align: 'right' });
    }
    y = first ? 44 : 24;
  };
  const newPage = () => {
    doc.addPage('a4', 'portrait');
    header(false);
  };
  const need = (h: number) => {
    if (y + h > H - 18) newPage();
  };
  const write = (
    text: string,
    o: { size?: number; bold?: boolean; colour?: string; indent?: number; gap?: number } = {},
  ) => {
    const size = o.size ?? 10.5;
    doc.setFont('helvetica', o.bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(o.colour ?? '#1E2833');
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
    need(14);
    y += 3;
    write(text.toUpperCase(), { size: 9, bold: true, colour: CORAL, gap: 0.5 });
    doc.setDrawColor(CORAL);
    doc.setLineWidth(0.4);
    doc.line(M, y - 1, M + 24, y - 1);
    y += 6;
  };
  const markdown = (md: string) => {
    for (const b of markdownToBlocks(md)) {
      if (b.kind === 'heading') write(b.text, { bold: true, size: 11.5 });
      else if (b.kind === 'bullet') write(`•  ${b.text}`, { indent: 3 });
      else if (b.kind === 'quote') write(b.text, { indent: 5, colour: SLATE });
      else write(b.text, { gap: 2.5 });
    }
  };

  header(true);
  write(`Exported ${day(today)}`, { size: 9, colour: SLATE, gap: 4 });

  heading('Outcome');
  if (plan.outcome.trim()) markdown(plan.outcome);
  else write('No outcome written yet.', { colour: SLATE });

  heading('Success measures');
  const measures = plan.measures.filter((m) => m.label.trim());
  if (measures.length === 0) write('No measures yet.', { colour: SLATE });
  for (const m of measures) write(`${m.id}   ${m.label}`, { gap: 1.8 });

  // ── Timeline (Gantt), drawn as vectors ──
  // Months read best; long plans switch to quarters so the text stays legible on A4.
  const monthly = layoutTimeline(plan.phases, 'month', today);
  const t =
    monthly && monthly.width > 520 ? layoutTimeline(plan.phases, 'quarter', today) : monthly;
  heading('Timeline');
  if (!t) {
    write('No dates on this plan yet.', { colour: SLATE });
  } else {
    const markup = renderToStaticMarkup(
      createElement(TimelineSvg, { t, title: `${artistName} plan timeline` }),
    ).replace(/'Archivo Narrow', Arial, sans-serif/g, 'helvetica');
    const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    const sw = Number(svg.getAttribute('width'));
    const sh = Number(svg.getAttribute('height'));
    const scale = textW / sw;
    const h = sh * scale;
    need(h + 4);
    // svg2pdf needs the element in the document to measure text.
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0';
    holder.appendChild(svg);
    document.body.appendChild(holder);
    try {
      await svg2pdf(svg, doc, { x: M, y, width: textW, height: h });
    } finally {
      holder.remove();
    }
    y += h + 3;
    if (t.unscheduled.length) {
      write(
        `Not on the timeline yet: ${t.unscheduled
          .map((u) => (u.title === 'Stage dates' ? `${u.phase} (stage dates)` : u.title))
          .join(', ')}.`,
        { size: 9, colour: SLATE },
      );
    }
  }

  // ── Stages ──
  plan.phases.forEach((p, i) => {
    heading(`Stage ${i + 1}`);
    write(p.name, { size: 14, bold: true, colour: NAVY, gap: 1 });
    const dates = [p.start, p.end].filter(Boolean).map((d) => day(d!));
    if (dates.length) write(dates.join(' – '), { size: 9.5, colour: SLATE, gap: 2.5 });
    if (p.goal.trim()) markdown(p.goal);
    if (p.milestones.length === 0) {
      write('No milestones yet.', { colour: SLATE });
      return;
    }
    y += 1;
    for (const m of p.milestones) {
      need(6);
      // A drawn tick box (the standard PDF fonts have no ballot-box characters).
      doc.setDrawColor(NAVY);
      doc.setLineWidth(0.3);
      doc.rect(M, y - 3, 3.2, 3.2, m.done ? 'FD' : 'S');
      const extra = [
        m.due ? `due ${day(m.due)}` : '',
        m.measures.length ? m.measures.join(' ') : '',
      ]
        .filter(Boolean)
        .join(' · ');
      write(`${m.title}${extra ? `   (${extra})` : ''}`, {
        indent: 6,
        colour: m.done ? SLATE : '#1E2833',
        gap: 1.6,
      });
    }
  });

  heading('Alignment check');
  if (gaps.length === 0) write('No gaps: every measure is fed by a milestone.');
  for (const g of gaps) write(`•  ${g}`, { indent: 3 });

  // ── Change history (rev 8): a timeline, oldest first ──
  heading('Change history');
  const history = changesOldestFirst(opts.changes ?? []);
  if (history.length === 0) write('No changes recorded yet.', { colour: SLATE });
  history.forEach((c, i) => {
    need(12);
    const page = doc.getCurrentPageInfo().pageNumber;
    const dotY = y - 1.3;
    doc.setDrawColor(NAVY);
    doc.setLineWidth(0.4);
    doc.setFillColor(i === history.length - 1 ? CORAL : PAPER);
    doc.circle(M + 1.6, dotY, 1.4, 'FD');
    const when = new Date(c.at).toLocaleString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    write(`${when}   ${c.byName} · version ${c.version}`, {
      size: 9.5,
      bold: true,
      colour: NAVY,
      indent: 6,
      gap: 0.8,
    });
    for (const line of c.changes) write(`•  ${line}`, { size: 9.5, indent: 9, gap: 0.6 });
    y += 2.5;
    // Join this dot to the next one while they're on the same page.
    if (i < history.length - 1 && doc.getCurrentPageInfo().pageNumber === page) {
      doc.setDrawColor(SLATE);
      doc.setLineWidth(0.25);
      doc.line(M + 1.6, dotY + 1.4, M + 1.6, y - 2.7);
    }
  });

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  const year = now.getFullYear();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFillColor(PAPER);
    doc.rect(0, H - 12, W, 12, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(SLATE);
    doc.text(`${copyrightLine(year)}  ·  blueprintmusic.group`, M, H - 5);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 5, { align: 'right' });
  }

  doc.save(pdfFileName(artistName, today));
}
