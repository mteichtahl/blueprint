import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AppConfig } from '../lib/config.ts';
import { ago, businessDaysWaiting, type EnquirySummary } from '../lib/enquiries.ts';
import { useLive } from '../lib/live.ts';
import { Button, Card, Tag } from './ui.tsx';

/**
 * Studio HQ's Enquiries card (rev 21): how many consultation requests are
 * open, how long the oldest has waited, and the three newest.
 */
export function EnquiriesCard({
  cfg,
  token,
  onOpen,
  onAll,
}: {
  cfg: AppConfig;
  token: string;
  onOpen: (enquiryId: string) => void;
  onAll: () => void;
}) {
  const [open, setOpen] = useState<EnquirySummary[] | null>(null);
  const live = useLive(['enquiries']);
  useEffect(() => {
    api<{ enquiries: EnquirySummary[] }>(cfg, token, 'GET', '/enquiries')
      .then((r) => setOpen(r.enquiries.filter((e) => e.status === 'open')))
      .catch(() => setOpen([]));
  }, [cfg, token, live]);

  const now = new Date();
  const oldest = [...(open ?? [])].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))[0];
  const newest = [...(open ?? [])]
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, 3);
  const days = oldest ? businessDaysWaiting(oldest.receivedAt, now) : 0;

  return (
    <Card
      className="flex-[1_1_300px]"
      title="Enquiries"
      action={
        <Button size="sm" variant="ghost" onClick={onAll}>
          All requests
        </Button>
      }
    >
      <div className="flex items-baseline gap-3">
        <b className="poster text-[44px] leading-none">{open?.length ?? '–'}</b>
        <span className="src">
          {open === null
            ? 'Loading…'
            : open.length === 0
              ? 'No open consultation requests'
              : `open · oldest waiting ${days} business day${days === 1 ? '' : 's'}`}
        </span>
      </div>
      {newest.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {newest.map((e) => (
            <li key={e.enquiryId} className="border-t border-input">
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-2 text-left"
                onClick={() => onOpen(e.enquiryId)}
              >
                <b className="min-w-0 flex-1 truncate">{e.name}</b>
                <span className="src">{e.countryName}</span>
                <Tag tone={days > 2 && e === oldest ? 'k' : 's'}>{ago(e.receivedAt, now)}</Tag>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
