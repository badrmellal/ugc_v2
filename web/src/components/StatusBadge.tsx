import { Ban, CircleCheck, CircleX, Clock, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { GenerationStatus } from '@shared/api';
import { cn } from '../lib/cn';

const STATUS: Record<GenerationStatus, { label: string; className: string }> = {
  queued: { label: 'Queued', className: 'bg-surface-2 text-muted border-line-strong' },
  running: { label: 'Generating', className: 'bg-accent-soft text-accent-text border-transparent' },
  succeeded: { label: 'Ready', className: 'bg-ok-soft text-ok border-transparent' },
  failed: { label: 'Failed', className: 'bg-danger-soft text-danger border-transparent' },
  canceled: { label: 'Canceled', className: 'bg-surface-2 text-muted border-line-strong' },
};

function StatusIcon({ status }: { status: GenerationStatus }) {
  const cls = 'size-3.5';
  switch (status) {
    case 'queued':
      return <Clock className={cls} aria-hidden="true" />;
    case 'running':
      return <LoaderCircle className={cn(cls, 'animate-spin')} aria-hidden="true" />;
    case 'succeeded':
      return <CircleCheck className={cls} aria-hidden="true" />;
    case 'failed':
      return <CircleX className={cls} aria-hidden="true" />;
    case 'canceled':
      return <Ban className={cls} aria-hidden="true" />;
  }
}

export function statusLabel(status: GenerationStatus): string {
  return STATUS[status].label;
}

export function StatusBadge({
  status,
  progress,
  className,
}: {
  status: GenerationStatus;
  /** Shown next to the label while the job is running. */
  progress?: number;
  className?: string;
}) {
  const { label, className: tone } = STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone,
        className,
      )}
    >
      <StatusIcon status={status} />
      {label}
      {status === 'running' && progress !== undefined && <span className="tabular-nums">{Math.round(progress)}%</span>}
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}
