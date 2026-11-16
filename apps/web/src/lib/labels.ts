import type { Priority } from './api.ts';

/*
 * Small labels the home screens share with pages that load on first use.
 */

/** Canvas badge colours: High deep coral, Medium coral tint, Low slate. */
export const PRIORITY_TAG: Record<Priority, readonly ['k' | 'c' | 's', string]> = {
  high: ['k', 'High'],
  medium: ['c', 'Medium'],
  low: ['s', 'Low'],
};

/** Library type filter (rev 9): documents and assets are one place, told apart by type. */
export type LibraryKind = 'all' | 'documents' | 'assets';
export const LIBRARY_KIND_OPTIONS: readonly { id: LibraryKind; label: string }[] = [
  { id: 'all', label: 'All files' },
  { id: 'documents', label: 'Documents' },
  { id: 'assets', label: 'Assets' },
];
