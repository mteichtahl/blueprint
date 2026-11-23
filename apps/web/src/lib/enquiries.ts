/**
 * Consultation requests (rev 21), as the API sends them
 * (services/api/src/enquiries/model.ts), and the wording the pages share.
 */
export type EnquiryStatus = 'open' | 'in-progress' | 'converted' | 'closed';
export type CloseReason = 'not-a-fit' | 'no-reply' | 'duplicate' | 'spam' | 'other';

export interface EnquirySummary {
  enquiryId: string;
  status: EnquiryStatus;
  name: string;
  email: string;
  country: string;
  countryName: string;
  receivedAt: string;
  updatedAt: string;
  ownerSub?: string;
  ownerName?: string;
  artistId?: string;
  closedReason?: CloseReason;
  resends: number;
}

export type ActivityKind =
  | 'received'
  | 'sentAgain'
  | 'pickedUp'
  | 'handedBack'
  | 'takenOver'
  | 'converted'
  | 'closed'
  | 'reopened'
  | 'edited';

export interface EnquiryDetail extends EnquirySummary {
  phone?: string;
  aboutMe: string;
  howCanWeHelp: string;
  pickedUpAt?: string;
  convertedAt?: string;
  closedAt?: string;
  notes: { noteId: string; bySub: string; byName: string; at: string; text: string }[];
  activity: {
    actId: string;
    kind: ActivityKind;
    at: string;
    bySub?: string;
    byName?: string;
    fromSub?: string;
    fromName?: string;
    artistId?: string;
    reason?: CloseReason;
  }[];
}

export interface EnquiryCounts {
  open: number;
  inProgress: number;
  mine: number;
  convertedRecently: number;
  oldestOpenAt: string | null;
}

export const STATUS_LABEL: Record<EnquiryStatus, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  converted: 'Converted',
  closed: 'Closed',
};

export const CLOSE_REASONS: { id: CloseReason; label: string }[] = [
  { id: 'not-a-fit', label: 'Not a fit right now' },
  { id: 'no-reply', label: 'No reply' },
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'spam', label: 'Spam' },
  { id: 'other', label: 'Other' },
];
export const closeReasonLabel = (r?: CloseReason) =>
  CLOSE_REASONS.find((c) => c.id === r)?.label ?? 'Closed';

export type EnquiryFilter = 'open' | 'mine' | 'in-progress' | 'converted' | 'closed' | 'all';

/** Which requests a filter shows, in the order it shows them. Spam only shows under Closed. */
export function filterEnquiries(
  list: EnquirySummary[],
  filter: EnquiryFilter,
  meSub: string,
  query = '',
): EnquirySummary[] {
  const q = query.trim().toLocaleLowerCase();
  const shown = list.filter((e) => {
    if (filter === 'open' && e.status !== 'open') return false;
    if (filter === 'mine' && !(e.status === 'in-progress' && e.ownerSub === meSub)) return false;
    if (filter === 'in-progress' && e.status !== 'in-progress') return false;
    if (filter === 'converted' && e.status !== 'converted') return false;
    if (filter === 'closed' && e.status !== 'closed') return false;
    if (filter !== 'closed' && e.closedReason === 'spam') return false;
    if (!q) return true;
    return [e.name, e.email, e.countryName, e.country].some((s) =>
      s.toLocaleLowerCase().includes(q),
    );
  });
  // Open requests oldest first, so nothing is left waiting; everything else newest first.
  return filter === 'open'
    ? [...shown].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    : [...shown].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** Whole business days (Mon–Fri) since it came in, in Melbourne. */
export function businessDaysWaiting(receivedAt: string, now = new Date()): number {
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(d);
  const weekday = (d: Date) =>
    new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short' }).format(
      d,
    );
  const today = day(now);
  let n = 0;
  for (
    let t = Date.parse(receivedAt) + 24 * 3600 * 1000;
    day(new Date(t)) <= today && n < 60;
    t += 24 * 3600 * 1000
  ) {
    if (!['Sat', 'Sun'].includes(weekday(new Date(t)))) n += 1;
  }
  return n;
}

/** Open for more than two business days: flagged in deep coral. */
export const waitingTooLong = (
  e: Pick<EnquirySummary, 'status' | 'receivedAt'>,
  now = new Date(),
) => e.status === 'open' && businessDaysWaiting(e.receivedAt, now) > 2;

/** "2 h ago", "Yesterday", "3 days ago". */
export function ago(iso: string, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

export const when = (iso: string) =>
  new Date(iso).toLocaleString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/** One line of the activity list, in plain words. */
export function activityLine(a: EnquiryDetail['activity'][number], artistName?: string): string {
  const by = a.byName ?? 'Someone';
  switch (a.kind) {
    case 'received':
      return 'Received from the public form';
    case 'sentAgain':
      return 'They sent the form again';
    case 'pickedUp':
      return `Picked up by ${by}`;
    case 'handedBack':
      return `${by} handed it back`;
    case 'takenOver':
      return `${by} took it over${a.fromName ? ` from ${a.fromName}` : ''}`;
    case 'converted':
      return `${by} marked it converted${artistName ? ` to ${artistName}` : ''}`;
    case 'closed':
      return `${by} closed it: ${closeReasonLabel(a.reason)}`;
    case 'reopened':
      return `${by} reopened it`;
    case 'edited':
      return `${by} edited the details`;
  }
}

/** A CSV of the requests shown, for admins (Export CSV). No answers or notes. */
export function enquiriesCsv(list: EnquirySummary[]): string {
  // A leading = + - @ would run as a formula in a spreadsheet: keep it text.
  const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  const cell = (raw: string) => {
    const v = safe(raw);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const rows = [
    ['Name', 'Email', 'Country', 'Status', 'Received', 'Picked up by', 'Close reason'],
    ...list.map((e) => [
      e.name,
      e.email,
      e.countryName,
      STATUS_LABEL[e.status],
      e.receivedAt,
      e.ownerName ?? '',
      e.closedReason ? closeReasonLabel(e.closedReason) : '',
    ]),
  ];
  return rows.map((r) => r.map((v) => cell(String(v))).join(',')).join('\n');
}
