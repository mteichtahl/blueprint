import { lazy, Suspense, type ComponentProps } from 'react';

/**
 * The plan screens carry the Markdown editor, so they load on first use
 * instead of with the rest of the app.
 */
const Plan = () => import('./Plan.tsx');
const LazyPlanTab = lazy(() => Plan().then((m) => ({ default: m.PlanTab })));
const LazyPlanStages = lazy(() => Plan().then((m) => ({ default: m.PlanStages })));

const loading = <p className="text-sm text-muted-foreground">Loading…</p>;

export function PlanTab(props: ComponentProps<typeof LazyPlanTab>) {
  return (
    <Suspense fallback={loading}>
      <LazyPlanTab {...props} />
    </Suspense>
  );
}

export function PlanStages(props: ComponentProps<typeof LazyPlanStages>) {
  return (
    <Suspense fallback={loading}>
      <LazyPlanStages {...props} />
    </Suspense>
  );
}
