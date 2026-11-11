import { useEffect, useState } from 'react';
import {
  RELEASE,
  currentNotes,
  formatReleaseDate,
  markWhatsNewSeen,
  onOpenWhatsNew,
  shouldShowWhatsNew,
  type BuildRelease,
  type ReleaseNotes,
} from '../lib/release.ts';
import { Dialog } from './Folders.tsx';
import { Button, Tag } from './ui.tsx';

function Notes({ notes }: { notes: ReleaseNotes }) {
  return (
    <div className="flex flex-col gap-2.5">
      {notes.summary && <p className="m-0 text-[15px] leading-relaxed">{notes.summary}</p>}
      {notes.groups.map((g) => (
        <section key={g.title || 'changes'} className="flex flex-col gap-1">
          {g.title && <h3 className="navlabel !m-0 !px-0 text-muted-foreground">{g.title}</h3>}
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[15px] leading-snug">
            {g.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * "What's new": opens by itself the first time someone uses a new release
 * (once per version, per device), and again from the version in the menu footer.
 * Content comes from CHANGELOG.md at build time.
 */
export function WhatsNew({ release = RELEASE }: { release?: BuildRelease }) {
  const [open, setOpen] = useState(() => shouldShowWhatsNew(release));
  useEffect(() => onOpenWhatsNew(() => setOpen(true)), []);
  const notes = currentNotes(release);
  if (!open || !notes) return null;
  const close = () => {
    markWhatsNewSeen(release);
    setOpen(false);
  };
  const earlier = release.notes.filter((n) => n.version !== release.version);
  const date = formatReleaseDate(notes.date);
  return (
    <Dialog
      title={`What's new in ${release.version}`}
      onClose={close}
      footer={
        <Button variant="cta" onClick={close}>
          Got it
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Tag tone={release.channel === 'prod' ? 'n' : 'c'}>{release.label}</Tag>
        {date && <span>Released {date}</span>}
      </div>
      <Notes notes={notes} />
      {earlier.length > 0 && (
        <details className="border-t border-input pt-3">
          <summary className="cursor-pointer text-sm font-bold">Earlier releases</summary>
          <div className="mt-3 flex flex-col gap-4">
            {earlier.map((n) => (
              <div key={n.version} className="flex flex-col gap-1.5">
                <div className="text-sm font-bold">
                  {n.version}
                  {n.date && (
                    <span className="font-normal text-muted-foreground">
                      {' '}
                      · {formatReleaseDate(n.date)}
                    </span>
                  )}
                </div>
                <Notes notes={n} />
              </div>
            ))}
          </div>
        </details>
      )}
    </Dialog>
  );
}
