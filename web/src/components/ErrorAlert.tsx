import { CircleAlert, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { describeError } from '../lib/errors';
import { cn } from '../lib/cn';
import { Button } from './Button';

/** Inline error box for a failed request, with validation details and an optional retry. */
export function ErrorAlert({
  error,
  title,
  onRetry,
  retrying,
  className,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const described = describeError(error);
  return (
    <div role="alert" className={cn('rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm', className)}>
      <div className="flex gap-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg">{title ?? described.title}</p>
          <p className="mt-0.5 break-words text-muted">{described.message}</p>
          {described.details.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-muted">
              {described.details.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          )}
          {onRetry && (
            <Button
              size="sm"
              className="mt-3"
              onClick={onRetry}
              loading={retrying}
              icon={<RefreshCw className="size-4" aria-hidden="true" />}
            >
              Try again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Centered error state for a page or panel that failed to load. */
export function ErrorState({
  error,
  title,
  onRetry,
  retrying,
  children,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  children?: ReactNode;
}) {
  const described = describeError(error);
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
        <CircleAlert className="size-6" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-lg font-semibold">{title ?? described.title}</h2>
      <p className="mt-1 text-sm text-muted">{described.message}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {onRetry && (
          <Button onClick={onRetry} loading={retrying} icon={<RefreshCw className="size-4" aria-hidden="true" />}>
            Try again
          </Button>
        )}
        {children}
      </div>
    </div>
  );
}
