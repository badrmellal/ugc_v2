import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export const inputClass = cn(
  'block w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-fg shadow-xs',
  'placeholder:text-subtle focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent',
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted aria-[invalid=true]:border-danger',
);

interface FieldProps {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  hintId?: string;
  error?: string | null;
  errorId?: string;
  /** Right side of the label row (counters, badges). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint/error, with ids the control can reference via aria-describedby. */
export function Field({ label, htmlFor, hint, hintId, error, errorId, aside, children, className }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
          {label}
        </label>
        {aside && <div className="text-xs text-muted">{aside}</div>}
      </div>
      {children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined || undefined;
}
