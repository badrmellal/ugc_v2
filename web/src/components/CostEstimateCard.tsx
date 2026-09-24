import type { RegenerationMode, Resolution } from '@shared/api';
import { useEstimate } from '../lib/hooks';
import { cn } from '../lib/cn';
import { CostBreakdownView } from './CostBreakdownView';
import { ErrorAlert } from './ErrorAlert';
import { Skeleton } from './Skeleton';

/** Live estimate from POST /api/estimate for the selected resolution (debounced). */
export function CostEstimate({
  resolution,
  mode = 'full',
  className,
}: {
  resolution: Resolution;
  mode?: RegenerationMode;
  className?: string;
}) {
  const estimate = useEstimate(resolution, mode);
  if (estimate.isPending) {
    return (
      <div className={cn('space-y-2', className)} aria-busy="true" aria-label="Loading cost estimate">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-7 w-1/2 ml-auto" />
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
    <div className={cn('transition-opacity', estimate.isPlaceholderData && 'opacity-60', className)}>
      <CostBreakdownView breakdown={estimate.data} />
      <p className="mt-3 text-xs text-muted">
        Approximate. The actual cost is calculated from the token usage Google reports for each turn.
      </p>
    </div>
  );
}
