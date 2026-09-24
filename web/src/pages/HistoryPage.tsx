import { Film, Plus } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { isTerminalStatus, type GenerationStatus } from '@shared/api';
import { useDocumentTitle, useGenerationList, useNow } from '../lib/hooks';
import { cn } from '../lib/cn';
import { Button, buttonClass } from '../components/Button';
import { ErrorAlert, ErrorState } from '../components/ErrorAlert';
import { GenerationCard } from '../components/GenerationCard';
import { Skeleton } from '../components/Skeleton';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'failed', label: 'Failed' },
] as const;

type FilterId = (typeof FILTERS)[number]['id'];

function parseFilter(value: string | null): FilterId {
  return FILTERS.some((filter) => filter.id === value) ? (value as FilterId) : 'all';
}

/** Server-side status filter. "Active" (queued + running) filters the full list on the client. */
function serverStatus(filter: FilterId): GenerationStatus | 'all' {
  return filter === 'succeeded' || filter === 'failed' ? filter : 'all';
}

const EMPTY_COPY: Record<FilterId, { title: string; message: string }> = {
  all: { title: 'No videos yet', message: 'Write a script, add a character image and generate your first video.' },
  active: { title: 'Nothing is generating', message: 'Videos that are queued or generating appear here.' },
  succeeded: { title: 'No finished videos yet', message: 'Finished videos appear here when they are ready.' },
  failed: { title: 'No failed videos', message: 'Failed videos appear here with the reason they failed.' },
};

const GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5';

export function HistoryPage() {
  useDocumentTitle('History');
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('filter'));
  const query = useGenerationList(serverStatus(filter));
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const visible = filter === 'active' ? items.filter((item) => !isTerminalStatus(item.status)) : items;
  const hasActive = items.some((item) => !isTerminalStatus(item.status));
  const now = useNow(30_000, true);

  const selectFilter = (id: FilterId) => {
    const next = new URLSearchParams(params);
    if (id === 'all') next.delete('filter');
    else next.set('filter', id);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">History</h1>
          <p className="mt-1 text-sm text-muted">
            Every video you generated, newest first.
            {hasActive && ' Active videos update automatically.'}
          </p>
        </div>
        <Link to="/" className={buttonClass('primary')}>
          <Plus className="size-4" aria-hidden="true" />
          New video
        </Link>
      </header>

      <div
        role="group"
        aria-label="Filter videos"
        className="inline-flex rounded-xl border border-line bg-surface-2 p-1"
      >
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            onClick={() => selectFilter(option.id)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              filter === option.id ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <ul className={GRID} aria-busy="true" aria-label="Loading videos">
          {Array.from({ length: 10 }, (_, index) => (
            <li key={index} className="space-y-2">
              <Skeleton className="aspect-[9/16] rounded-2xl" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </li>
          ))}
        </ul>
      ) : query.isError && items.length === 0 ? (
        <ErrorState
          title="Could not load your videos"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : visible.length === 0 && !query.hasNextPage ? (
        <EmptyState filter={filter} />
      ) : (
        <>
          {query.isError && (
            <ErrorAlert
              error={query.error}
              title="Could not refresh the list"
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          )}
          {visible.length > 0 ? (
            <ul className={GRID}>
              {visible.map((item) => (
                <GenerationCard key={item.id} item={item} now={now} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No matching videos in the loaded results.</p>
          )}
          {query.hasNextPage && (
            <div className="flex justify-center pt-2">
              <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmptyState({ filter }: { filter: FilterId }) {
  const copy = EMPTY_COPY[filter];
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line-strong px-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-text">
        <Film className="size-6" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-base font-semibold">{copy.title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted">{copy.message}</p>
      <Link to="/" className={buttonClass('primary', 'md', 'mt-5')}>
        <Plus className="size-4" aria-hidden="true" />
        Create a video
      </Link>
    </div>
  );
}
