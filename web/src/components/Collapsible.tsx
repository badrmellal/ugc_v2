import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/** Disclosure built on <details>/<summary> (keyboard and screen reader support for free). */
export function Collapsible({
  summary,
  children,
  defaultOpen,
  className,
  summaryClassName,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  return (
    <details className={cn('group', className)} open={defaultOpen}>
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
