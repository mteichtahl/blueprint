import type { Plan } from './api.ts';

export interface PhaseProgress {
  id: string;
  name: string;
  pct: number;
  done: number;
  total: number;
  status: 'done' | 'now' | 'next';
}

/**
 * Phase progress for the workspace header and Studio HQ (screens doc: the
 * header shows the plan's own phases). A phase is done when every milestone
 * is; the first unfinished phase, and any other already under way, is "now".
 */
export function phaseProgress(plan: Pick<Plan, 'phases'>): PhaseProgress[] {
  let foundNow = false;
  return plan.phases.map((p) => {
    const total = p.milestones.length;
    const done = p.milestones.filter((m) => m.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    let status: PhaseProgress['status'] = 'next';
    if (total > 0 && done === total) status = 'done';
    else if (!foundNow || done > 0) {
      status = 'now';
      foundNow = true;
    }
    return { id: p.id, name: p.name, pct, done, total, status };
  });
}

export function overallProgress(plan: Pick<Plan, 'phases'>): number {
  const all = plan.phases.flatMap((p) => p.milestones);
  return all.length ? Math.round((all.filter((m) => m.done).length / all.length) * 100) : 0;
}
