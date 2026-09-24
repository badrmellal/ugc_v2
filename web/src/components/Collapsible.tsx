import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Disclosure built on <details>/<summary> (keyboard and screen reader support for free).
 *
 * `defaultOpen` opens it initially, and opens it again whenever it turns true later (for example when a
 * field inside becomes invalid). It never closes the section by itself: only the user does, so fixing an
 * error while typing does not collapse the field being edited.
 */
export function Collapsible({
  summary,
  children,
  defaultOpen = false,
  className,
  summaryClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [lastDefaultOpen, setLastDefaultOpen] = useState(defaultOpen);
  if (defaultOpen !== lastDefaultOpen) {
    setLastDefaultOpen(defaultOpen);
    if (defaultOpen) setOpen(true);
  }

  return (
    <details className={cn('group', className)} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        className={cn(
          'flex list-none items-center gap-1.5 rounded-md text-sm font-medium text-muted select-none hover:text-fg',
          summaryClassName,
        )}
      >
        <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
        {summary}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}
