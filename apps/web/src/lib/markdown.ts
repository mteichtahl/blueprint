/**
 * Plain-text helpers for Markdown (no editor code, so they stay in the main bundle).
 */

/** Markdown as one line of plain text, for headers and lists. */
export function markdownToText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
