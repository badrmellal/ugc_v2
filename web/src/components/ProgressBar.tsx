import { cn } from '../lib/cn';

export function ProgressBar({
  value,
  label,
  tone = 'accent',
  className,
}: {
  /** 0-100 */
  value: number;
  label: string;
  tone?: 'accent' | 'ok' | 'warn' | 'danger' | 'muted';
  className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  const fill = {
    accent: 'bg-accent',
    ok: 'bg-ok',
    warn: 'bg-warn',
    danger: 'bg-danger',
    muted: 'bg-subtle',
  }[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
