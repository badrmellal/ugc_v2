import type { RegenerationMode, Resolution } from '@shared/api';
import { useEstimate } from '../lib/hooks';
import { cn } from '../lib/cn';
import { CostBreakdownView } from './CostBreakdownView';
import { ErrorAlert } from './ErrorAlert';
import { Skeleton } from './Skeleton';

/** Live estimate from POST /api/estimate for the selected resolution and options (debounced). */
export function CostEstimate({
  resolution,
  mode = 'full',
  reinforceCharacterOnExtend = false,
  className,
}: {
  resolution: Resolution;
  mode?: RegenerationMode;
  reinforceCharacterOnExtend?: boolean;
  className?: string;
}) {
  const { query: estimate, outdated } = useEstimate({ resolution, mode, reinforceCharacterOnExtend });
  if (estimate.isPending) {
    return (
      <div className={cn('space-y-2', className)} aria-busy="true" aria-label="Loading cost estimate">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="ml-auto h-7 w-1/2" />
      </div>
    );
  }
  if (estimate.isError) {
    return (
      <ErrorAlert
        className={className}
        title="Could not load the cost estimate"
        error={estimate.error}
        onRetry={() => void estimate.refetch()}
        retrying={estimate.isFetching}
      />
    );
  }
  return (
    <div className={cn('transition-opacity', outdated && 'opacity-60', className)} aria-busy={outdated || undefined}>
      <CostBreakdownView breakdown={estimate.data} />
      <p className="mt-3 text-xs text-muted">
        Approximate. The actual cost is calculated from the token usage Google reports for each turn.
      </p>
    </div>
  );
}
