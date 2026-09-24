import type { ReactNode } from 'react';
import { Button, type ButtonVariant } from './Button';
import { Dialog } from './Dialog';
import { ErrorAlert } from './ErrorAlert';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  confirmIcon?: ReactNode;
  pending?: boolean;
  error?: unknown;
  confirmDisabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  confirmIcon,
  pending,
  error,
  confirmDisabled,
  size = 'sm',
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!pending}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            loading={pending}
            disabled={confirmDisabled}
            icon={confirmIcon}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children || error ? (
        <div className="space-y-4">
          {children}
          {error ? <ErrorAlert error={error} /> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
