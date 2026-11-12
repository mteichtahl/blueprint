import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Icon, Notice } from './ui.tsx';

/**
 * Rev 13 interaction patterns (docs/patterns.md). Every screen that shows one
 * thing uses these, so opening, editing and deleting work the same everywhere:
 *
 * - Records (documents, contacts, venues, folders) open a <RecordPage>; Edit
 *   opens an <EditScreen>.
 * - Work items (gigs, events, to-dos, plans, meetings, submissions) open a
 *   <WorkPage> where the work happens; Edit details opens an <EditScreen>.
 * - Deleting an object only ever happens in the <DangerArea> at the bottom of
 *   its <EditScreen>.
 */

/** P8: "← name of the page you came from". There is no default text on purpose. */
export function BackLink({ to, onClick }: { to: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      ← {to}
    </Button>
  );
}

type ItemPageProps = {
  /** Small heading on the card ("Document", "Gig"). */
  kind: string;
  /** The item's name, shown large. */
  title: ReactNode;
  /** Muted line under the name (type and size, date and venue…). */
  sub?: ReactNode;
  /** Status chips and marks beside the name. */
  badges?: ReactNode;
  /** Left of the name: a preview, logo or date block. */
  lead?: ReactNode;
  /** P8: where Back goes. */
  back: { to: string; onClick: () => void };
  /** The one main action (Download, Mark done). */
  primary?: ReactNode;
  /** Shown only when the person may edit; opens the item's <EditScreen>. */
  onEdit?: (() => void) | undefined;
  /** Rare actions (Access, Move to…), after Edit. Never Delete. */
  more?: ReactNode;
  children?: ReactNode;
};

function ItemPage({
  kind,
  title,
  sub,
  badges,
  lead,
  back,
  primary,
  onEdit,
  more,
  children,
  editLabel,
  pattern,
}: ItemPageProps & { editLabel: string; pattern: 'record' | 'work' }) {
  return (
    <Card
      title={<h2 className="t text-[19px]">{kind}</h2>}
      action={<BackLink to={back.to} onClick={back.onClick} />}
      className="flex flex-col gap-4"
    >
      <div data-pattern={pattern} className="flex flex-wrap items-start gap-4">
        {lead && <span className="flex-none">{lead}</span>}
        <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-1.5">
          <h3 className="t text-[22px] leading-tight [overflow-wrap:anywhere]">{title}</h3>
          {sub && <span className="src [overflow-wrap:anywhere]">{sub}</span>}
          {badges && <span className="flex flex-wrap items-center gap-1.5">{badges}</span>}
        </div>
        {(primary || onEdit || more) && (
          <div className="flex flex-wrap items-center gap-2">
            {primary}
            {onEdit && (
              <Button variant="ghost" onClick={onEdit}>
                <Icon name="pencil" size={16} />
                {editLabel}
              </Button>
            )}
            {more}
          </div>
        )}
      </div>
      {children}
    </Card>
  );
}

/** P2: a record you mostly look at. Header actions: primary, Edit, then rare ones. */
export function RecordPage(props: ItemPageProps) {
  return <ItemPage {...props} editLabel="Edit" pattern="record" />;
}

/**
 * P3: a work item you mostly act on. Day-to-day actions sit in the page's
 * sections and save as they happen; the item's own fields sit behind Edit details.
 */
export function WorkPage(props: ItemPageProps) {
  return <ItemPage {...props} editLabel="Edit details" pattern="work" />;
}

/** A titled block on a work page, with its own actions on the right. */
export function WorkSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-input pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="t text-[17px]">{title}</h3>
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * P4: fields, then Save and Cancel at the bottom (Enter saves, Escape cancels),
 * then the danger area last.
 */
export function EditScreen({
  title,
  back,
  onSave,
  onCancel,
  busy = false,
  saveLabel = 'Save',
  canSave = true,
  error,
  children,
  danger,
}: {
  title: string;
  back: { to: string; onClick: () => void };
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  saveLabel?: string;
  canSave?: boolean;
  error?: string | null;
  children: ReactNode;
  /** A <DangerArea>, shown below Save and Cancel. */
  danger?: ReactNode;
}) {
  return (
    <Card
      title={<h2 className="t text-[19px]">{title}</h2>}
      action={<BackLink to={back.to} onClick={back.onClick} />}
    >
      <form
        data-pattern="edit"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        {children}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="cta" disabled={busy || !canSave}>
            {busy ? 'Saving…' : saveLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
      {danger}
    </Card>
  );
}

/**
 * P5: the only place an object is deleted (or archived). The first click asks,
 * the second does it; the ask times out after 6 seconds. When something stops
 * it, the button is disabled and the reason and places are listed.
 */
export function DangerArea({
  title,
  action = 'Delete',
  what,
  blocked,
  onConfirm,
  disabled = false,
  extra,
}: {
  /** "Delete this contact". */
  title: string;
  /** The button's word: Delete, Archive, Remove stage, Discard. */
  action?: string;
  /** What will happen, in plain words. */
  what?: ReactNode;
  /** Why it can't be done yet, and where it's used. */
  blocked?: { reason: ReactNode; places?: string[]; hint?: ReactNode } | null;
  onConfirm: () => Promise<void>;
  disabled?: boolean;
  /** Another action that belongs here (Archive beside Delete). */
  extra?: ReactNode;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 6000);
    return () => clearTimeout(t);
  }, [confirm]);
  const id = `danger-${title.replace(/\W+/g, '-').toLowerCase()}`;
  // The accessible name always contains the visible words (WCAG 2.5.3).
  const visible = busy ? 'Working…' : confirm ? `Click again to ${action.toLowerCase()}` : action;
  const name = title.toLowerCase().includes(visible.toLowerCase()) ? title : `${visible}: ${title}`;
  return (
    <section
      aria-labelledby={id}
      data-pattern="danger"
      className="mt-4 flex flex-col gap-2 rounded-[10px] border border-[#E7B9B7] bg-[#FDF3F2] p-3.5"
    >
      <h3 id={id} className="text-[15px] font-bold text-[#8E2F2C]">
        {title}
      </h3>
      {blocked ? (
        <>
          <p className="text-sm">{blocked.reason}</p>
          {blocked.places && blocked.places.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {blocked.places.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {blocked.hint && <p className="src">{blocked.hint}</p>}
        </>
      ) : (
        what && <p className="src">{what}</p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <span className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={confirm ? 'cta' : 'ghost'}
          disabled={busy || disabled || !!blocked}
          aria-label={name}
          onClick={async () => {
            if (!confirm) return setConfirm(true);
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
              setConfirm(false);
            }
          }}
        >
          <Icon name="trash" size={16} />
          {visible}
        </Button>
        {extra}
      </span>
    </section>
  );
}

/**
 * P9: the second (and last) level of navigation, a segmented control. Use it
 * for a page's sections too (the meeting page, phone Contacts & venues).
 */
export function SectionSwitch<T extends string>({
  label,
  value,
  onChange,
  options,
  className = '',
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { id: T; label: string; count?: ReactNode; disabled?: boolean }[];
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={`seg ${className}`}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          aria-disabled={o.disabled || undefined}
          onClick={() => !o.disabled && onChange(o.id)}
        >
          {o.label} {o.count}
        </button>
      ))}
    </div>
  );
}
