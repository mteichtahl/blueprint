import { createElement } from 'react';
import type { Plan } from './api.ts';
import { layoutTimeline } from './timeline.ts';

/**
 * Export an artist's plan to PDF (rev 7): always the whole plan, branded,
 * with the Gantt chart. Built in the browser, so nothing leaves the app; the
 * PDF libraries load only when someone exports.
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
}): Promise<void> {
  const [{ jsPDF }, { svg2pdf }, server, { TimelineSvg }] = await Promise.all([
    import('jspdf'),
    import('svg2pdf.js'),
    import('react-dom/server'),
    import('../components/PlanTimeline.tsx'),
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
    doc.setFillColor(NAVY);
    doc.rect(0, 0, W, first ? 34 : 14, 'F');
    doc.setTextColor('#FFFFFF');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(first ? 13 : 9);
    doc.text('BLUEPRINT', M, first ? 13 : 9);
    if (first) {
      doc.setFontSize(6.5);
      doc.setFont('helvetica', 'normal');
      doc.text('M U S I C   G R O U P', M, 17.5);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.text(`${artistName}: artist plan`, M, 28);
    } else {
      doc.setFont('helvetica', 'normal');
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

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFillColor(PAPER);
    doc.rect(0, H - 12, W, 12, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(SLATE);
    doc.text('Blueprint Music Group · blueprintmusic.group', M, H - 5);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 5, { align: 'right' });
  }

  doc.save(pdfFileName(artistName, today));
}
