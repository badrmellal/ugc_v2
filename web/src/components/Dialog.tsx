import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** When false, Escape and backdrop clicks do not close the dialog (e.g. while a request is pending). */
  dismissible?: boolean;
}

/**
 * Modal built on the native <dialog> element: focus is trapped, Escape closes it and focus
 * returns to the trigger. Content is only mounted while open so forms inside reset each time.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        if (!dismissible) event.preventDefault();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(event) => {
        // Clicks on the backdrop target the <dialog> element itself.
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
      className={cn(
        'm-auto max-h-[90dvh] w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-line bg-surface p-0 text-fg shadow-2xl',
        'backdrop:bg-black/50 backdrop:backdrop-blur-[2px]',
        { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }[size],
      )}
    >
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-muted">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={!dismissible}
              className="-m-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Close"
            >
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          {children && <div className="overflow-y-auto px-5 py-4">{children}</div>}
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
