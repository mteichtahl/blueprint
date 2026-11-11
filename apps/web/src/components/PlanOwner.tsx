import { useState } from 'react';
import type { PlanOwner } from '../lib/api.ts';
import { Avatar, Button, Card, Select, Tag, TextArea } from './ui.tsx';

/**
 * Plan owner (screens doc rev 12): every artist plan has one Blueprint owner,
 * shown in the plan header. Blueprint can change it; artists see who it is.
 */

const NOTE_MAX = 500;
const label = (o: PlanOwner) => (o.jobTitle ? `${o.displayName} · ${o.jobTitle}` : o.displayName);

/** "Plan owner: Kyra · Founder & Director", or a coral "Needs an owner". */
export function OwnerChip({
  owner,
  ownerNeeded,
  onChange,
}: {
  owner: PlanOwner | null;
  ownerNeeded: boolean;
  /** Blueprint only. */
  onChange?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 text-[15px]">
      <span className="eyebrow">Plan owner</span>
      {owner ? (
        <span className="flex items-center gap-2">
          <Avatar name={owner.displayName} userSub={owner.sub} size={28} />
          <b>{owner.displayName}</b>
          {owner.jobTitle && <span className="text-muted-foreground">{owner.jobTitle}</span>}
        </span>
      ) : (
        <span className="text-muted-foreground">Not set</span>
      )}
      {ownerNeeded && <Tag tone="c">Needs an owner</Tag>}
      {onChange && (
        <Button size="sm" variant="ghost" onClick={onChange}>
          {owner ? 'Change owner' : 'Choose an owner'}
        </Button>
      )}
    </div>
  );
}

/** Pick an owner while starting a plan, or saving one that has none. */
export function OwnerPicker({
  candidates,
  value,
  onChange,
}: {
  candidates: PlanOwner[];
  value: string;
  onChange: (sub: string) => void;
}) {
  return (
    <div className="max-w-[420px]">
      <Select
        label="Plan owner"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={[
          { value: '', label: 'Choose someone from the Blueprint team' },
          ...candidates.map((c) => ({ value: c.sub, label: label(c) })),
        ]}
      />
      <span className="src">They get a summary of the plan and hear about every change to it.</span>
    </div>
  );
}

/** Change owner: who, what moves to them, and a note for the handover summary. */
export function ChangeOwnerPanel({
  artistName,
  current,
  candidates,
  movable,
  busy,
  onConfirm,
  onCancel,
}: {
  artistName: string;
  current: PlanOwner | null;
  candidates: PlanOwner[];
  /** Open to-dos that would move. */
  movable: number;
  busy: boolean;
  onConfirm: (sub: string, note: string) => void;
  onCancel: () => void;
}) {
  const choices = candidates.filter((c) => c.sub !== current?.sub);
  const [sub, setSub] = useState('');
  const [note, setNote] = useState('');
  const next = choices.find((c) => c.sub === sub);
  return (
    <Card title={<span className="eyebrow">Change plan owner</span>}>
      {choices.length === 0 ? (
        <p className="src m-0">
          Nobody else can own {artistName}&apos;s plan yet. Assign a team member to {artistName} in
          Access &amp; permissions first.
        </p>
      ) : (
        <>
          <Select
            label="New owner"
            value={sub}
            onChange={(e) => setSub(e.target.value)}
            options={[
              { value: '', label: 'Choose someone from the Blueprint team' },
              ...choices.map((c) => ({ value: c.sub, label: label(c) })),
            ]}
          />
          <p className="m-0 text-[15px]">
            {next
              ? movable > 0
                ? `${movable} open to-do${movable === 1 ? '' : 's'} will move to ${next.displayName}.`
                : `No open to-dos to move. ${next.displayName} will look after new ones.`
              : 'The new owner gets a summary of the plan, and the open to-dos move to them.'}
          </p>
          <TextArea
            label="Handover note (optional)"
            value={note}
            maxLength={NOTE_MAX}
            placeholder="Anything they should know first"
            onChange={(e) => setNote(e.target.value)}
          />
        </>
      )}
      <div className="flex flex-wrap gap-3">
        {choices.length > 0 && (
          <Button variant="cta" disabled={!next || busy} onClick={() => onConfirm(sub, note)}>
            {busy ? 'Changing…' : 'Change owner'}
          </Button>
        )}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
