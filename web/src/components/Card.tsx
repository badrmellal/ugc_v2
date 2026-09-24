import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** id for the heading, to link it with aria-labelledby. */
  headingId?: string;
}

export function Card({ title, description, actions, children, className, bodyClassName, headingId }: CardProps) {
  const autoId = useId();
  const titleId = headingId ?? autoId;
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={cn('rounded-2xl border border-line bg-surface shadow-xs', className)}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && (
              <h2 id={titleId} className="text-sm font-semibold text-fg">
                {title}
              </h2>
            )}
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('px-4 py-4 sm:px-5', bodyClassName)}>{children}</div>
    </section>
  );
}
