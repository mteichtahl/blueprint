import type { Plan, Todo } from './model.ts';
import { planDay, type PlanChange } from './plan-history.ts';

/**
 * The handover summary a new plan owner gets (rev 12). Written from the
 * plan's own data, never by AI, so it reads the same for artists who opted
 * out of AI. Pure and unit-tested; the notifier loads what it needs.
 */
export interface HandoverInput {
  artistName: string;
  /** The previous owner, if the plan had one. */
  fromName?: string;
  /** Who changed the owner. */
  byName: string;
  /** The new owner changed it themselves. */
  byNewOwner: boolean;
  note?: string;
  plan: Pick<Plan, 'outcome' | 'measures' | 'phases'>;
  /** Open to-dos the new owner now looks after. */
  todos: Pick<Todo, 'title' | 'due' | 'done'>[];
  /** This artist's submissions waiting for review. */
  waiting: { title?: string; neededBy?: string }[];
  /** Latest plan changes, newest first. */
  recent: Pick<PlanChange, 'at' | 'changes'>[];
  /** YYYY-MM-DD. */
  today: string;
}

const SOON_DAYS = 30;
const MAX_ITEMS = 8;
const q = (s: string) => `“${s}”`;

/** Markdown to one plain line, shortened. */
export function plainText(md: string, max = 240): string {
  const text = md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function capped(items: string[], header: string): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_ITEMS).map((i) => `• ${i}`);
  const rest = items.length - shown.length;
  return [header, ...shown, ...(rest > 0 ? [`+ ${rest} more`] : [])];
}

export function handoverSummary(i: HandoverInput): string[] {
  const out: string[] = [];
  if (i.byNewOwner) {
    out.push(
      i.fromName
        ? `You took over ${i.artistName}'s plan from ${i.fromName}.`
        : `You're now the owner of ${i.artistName}'s plan.`,
    );
  } else {
    const from = i.fromName && i.fromName !== i.byName ? ` (from ${i.fromName})` : '';
    out.push(`${i.byName} handed ${i.artistName}'s plan to you${from}.`);
  }
  if (i.note) out.push(`Note: ${q(i.note)}`);

  const outcome = plainText(i.plan.outcome);
  if (outcome) out.push(`Outcome: ${outcome}`);
  const measures = i.plan.measures.filter((m) => m.label.trim());
  if (measures.length) {
    out.push(`Success measures: ${measures.map((m) => `${m.id} ${m.label.trim()}`).join('; ')}`);
  }

  // The current stage: the first with milestones still to do.
  const current = i.plan.phases.findIndex(
    (p) => p.milestones.length > 0 && p.milestones.some((m) => !m.done),
  );
  out.push(
    ...capped(
      i.plan.phases.map((p, n) => {
        const done = p.milestones.filter((m) => m.done).length;
        const dates = p.start && p.end ? ` (${planDay(p.start)} – ${planDay(p.end)})` : '';
        const now = n === current ? ', current stage' : '';
        return `${p.name}${dates}: ${done} of ${p.milestones.length} milestones done${now}`;
      }),
      'Stages:',
    ),
  );

  const until = addDays(i.today, SOON_DAYS);
  const due = i.plan.phases
    .flatMap((p) => p.milestones.map((m) => ({ m, stage: p.name })))
    .filter(({ m }) => !m.done && m.due && m.due <= until)
    .sort((a, b) => a.m.due!.localeCompare(b.m.due!))
    .map(({ m, stage }) =>
      m.due! < i.today
        ? `${q(m.title)} (${stage}), overdue since ${planDay(m.due!)}`
        : `${q(m.title)} (${stage}), due ${planDay(m.due!)}`,
    );
  out.push(...capped(due, 'Milestones overdue or due in the next 30 days:'));

  const open = i.todos
    .filter((t) => !t.done)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
    .map((t) => {
      if (!t.due) return t.title;
      return t.due < i.today
        ? `${t.title}, overdue since ${planDay(t.due)}`
        : `${t.title}, due ${planDay(t.due)}`;
    });
  out.push(...capped(open, `Your open to-dos for ${i.artistName} (${open.length}):`));

  out.push(
    ...capped(
      i.waiting.map(
        (w) =>
          `${w.title?.trim() || 'Untitled submission'}${w.neededBy ? `, needed by ${planDay(w.neededBy)}` : ''}`,
      ),
      `Waiting for review (${i.waiting.length}):`,
    ),
  );

  out.push(
    ...capped(
      i.recent.slice(0, 5).map((c) => {
        const more = c.changes.length - 1;
        return `${planDay(c.at.slice(0, 10))}: ${c.changes[0] ?? 'Saved'}${more > 0 ? ` and ${more} more` : ''}`;
      }),
      'Recent changes:',
    ),
  );
  return out;
}
