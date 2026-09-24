import { LoaderCircle } from 'lucide-react';
import { cn } from '../lib/cn';

export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-muted', className)}>
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span role="status" className="flex items-center gap-3 text-sm text-muted">
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}
