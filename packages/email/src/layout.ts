/**
 * The BMG email layout (Brand Kit): navy header band with the official
 * white-on-navy logo, off-white page, white rounded card, deepened coral
 * button (AA contrast with white text), slate secondary text. Table-based and
 * inline-styled so it renders in Gmail, Outlook and Apple Mail.
 */

export const BRAND = {
  navy: '#011935',
  offWhite: '#F1F4F7',
  coral: '#D9534F',
  /** Coral deepened for buttons and small text (WCAG AA with white). */
  coralDeep: '#B5403C',
  slate: '#5C6775',
} as const;

const HEADING_FONT = "'Lexend Exa','League Spartan',Arial,Helvetica,sans-serif";
const BODY_FONT = "'Archivo Narrow',Arial,Helvetica,sans-serif";

/** A block of email content. Text is always escaped; there is no raw HTML block. */
export type Block =
  | { kind: 'p'; text: string }
  /** Label/value rows, e.g. "Due: 3 Dec". */
  | { kind: 'facts'; rows: [label: string, value: string][] }
  /** A highlighted value, e.g. a temporary password or code. */
  | { kind: 'code'; text: string; label?: string }
  | { kind: 'list'; items: string[] }
  /** A small section heading inside the card. */
  | { kind: 'h'; text: string }
  /** Numbered steps. */
  | { kind: 'steps'; items: string[] };

export interface EmailContent {
  subject: string;
  /** Hidden preview line shown by mail clients next to the subject. */
  preheader: string;
  heading: string;
  /** Small coral eyebrow above the heading. */
  eyebrow?: string;
  blocks: Block[];
  cta?: { label: string; url: string };
  footerNote?: string;
}

export interface LayoutOptions {
  /** Absolute https URL of the official white-on-navy logo PNG. */
  logoUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links reach an href; anything else becomes "#". */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '#';
  } catch {
    return '#';
  }
}

function blockHtml(b: Block): string {
  const p = `margin:0 0 16px;font-family:${BODY_FONT};font-size:17px;line-height:1.5;color:${BRAND.navy};`;
  switch (b.kind) {
    case 'p':
      return `<p style="${p}">${escapeHtml(b.text)}</p>`;
    case 'list':
      return `<ul style="margin:0 0 16px;padding-left:20px;font-family:${BODY_FONT};font-size:17px;line-height:1.5;color:${BRAND.navy};">${b.items
        .map((i) => `<li style="margin:0 0 4px;">${escapeHtml(i)}</li>`)
        .join('')}</ul>`;
    case 'h':
      return `<h2 style="margin:24px 0 10px;font-family:${HEADING_FONT};font-size:18px;line-height:1.3;color:${BRAND.navy};font-weight:bold;">${escapeHtml(b.text)}</h2>`;
    case 'steps':
      return `<ol style="margin:0 0 16px;padding-left:22px;font-family:${BODY_FONT};font-size:17px;line-height:1.5;color:${BRAND.navy};">${b.items
        .map((i) => `<li style="margin:0 0 6px;">${escapeHtml(i)}</li>`)
        .join('')}</ol>`;
    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border-collapse:separate;background:${BRAND.offWhite};border-radius:10px;">${b.rows
        .map(
          ([label, value]) =>
            `<tr><td style="padding:8px 14px;font-family:${BODY_FONT};font-size:15px;color:${BRAND.slate};width:38%;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:8px 14px;font-family:${BODY_FONT};font-size:16px;color:${BRAND.navy};font-weight:bold;">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'code':
      return `${b.label ? `<p style="margin:0 0 6px;font-family:${BODY_FONT};font-size:15px;color:${BRAND.slate};">${escapeHtml(b.label)}</p>` : ''}<p style="margin:0 0 16px;padding:12px 16px;background:${BRAND.offWhite};border-radius:10px;font-family:'Courier New',Courier,monospace;font-size:20px;letter-spacing:2px;color:${BRAND.navy};font-weight:bold;">${escapeHtml(b.text)}</p>`;
  }
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'p':
      return b.text;
    case 'list':
      return b.items.map((i) => `- ${i}`).join('\n');
    case 'h':
      return b.text.toUpperCase();
    case 'steps':
      return b.items.map((i, n) => `${n + 1}. ${i}`).join('\n');
    case 'facts':
      return b.rows.map(([l, v]) => `${l}: ${v}`).join('\n');
    case 'code':
      return `${b.label ? `${b.label}\n` : ''}${b.text}`;
  }
}

export function renderLayout(c: EmailContent, opts: LayoutOptions): RenderedEmail {
  const cta = c.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px;"><tr><td style="border-radius:10px;background:${BRAND.coralDeep};box-shadow:0 1px 2px rgba(1,25,53,0.12);"><a href="${escapeHtml(safeUrl(c.cta.url))}" style="display:inline-block;padding:14px 26px;font-family:${HEADING_FONT};font-size:15px;font-weight:bold;letter-spacing:0.5px;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(c.cta.label)}</a></td></tr></table>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(c.subject)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.offWhite};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(c.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.offWhite};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;border-collapse:separate;">
<tr><td align="center" style="background:${BRAND.navy};border-radius:14px 14px 0 0;padding:22px 24px;"><img src="${escapeHtml(safeUrl(opts.logoUrl))}" width="120" height="120" alt="Blueprint Music Group" style="display:block;width:120px;height:120px;border:0;outline:none;text-decoration:none;color:${BRAND.offWhite};font-family:${HEADING_FONT};font-size:16px;font-weight:700;line-height:1.3;text-align:center;"></td></tr>
<tr><td style="background:#FFFFFF;border-radius:0 0 14px 14px;padding:32px 32px 24px;box-shadow:0 1px 3px rgba(1,25,53,0.08);">
${c.eyebrow ? `<p style="margin:0 0 8px;font-family:${HEADING_FONT};font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${BRAND.coralDeep};font-weight:bold;">${escapeHtml(c.eyebrow)}</p>` : ''}
<h1 style="margin:0 0 20px;font-family:${HEADING_FONT};font-size:24px;line-height:1.3;color:${BRAND.navy};font-weight:bold;">${escapeHtml(c.heading)}</h1>
${c.blocks.map(blockHtml).join('\n')}
${cta}
${c.footerNote ? `<p style="margin:20px 0 0;font-family:${BODY_FONT};font-size:14px;line-height:1.5;color:${BRAND.slate};">${escapeHtml(c.footerNote)}</p>` : ''}
</td></tr>
<tr><td align="center" style="padding:18px 24px;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${BRAND.slate};">Blueprint Music Group · Melbourne<br>You're receiving this because you have a Blueprint Music Group account.</td></tr>
</table></td></tr></table>
</body></html>`;
  const text = [
    c.heading,
    '',
    ...c.blocks.map((b) => `${blockText(b)}\n`),
    ...(c.cta ? [`${c.cta.label}: ${safeUrl(c.cta.url)}`, ''] : []),
    ...(c.footerNote ? [c.footerNote, ''] : []),
    '— Blueprint Music Group',
  ].join('\n');
  return { subject: c.subject, html, text };
}
