import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  name: string;
  legend: ReactNode;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** `segmented` = compact pill row, `cards` = option cards with descriptions. */
  layout?: 'segmented' | 'cards';
  columns?: 2 | 3 | 4;
  hideLegend?: boolean;
}

/** Radio group styled as a segmented control or option cards. Arrow keys move the selection. */
export function SegmentedControl<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  disabled,
  layout = 'segmented',
  columns = 2,
  hideLegend,
}: SegmentedControlProps<T>) {
  const grid = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }[columns];
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className={cn('mb-1.5 text-sm font-medium text-fg', hideLegend && 'sr-only')}>{legend}</legend>
      <div
        className={cn(
          'grid gap-1.5',
          grid,
          layout === 'segmented' && 'rounded-xl border border-line bg-surface-2 p-1',
          layout === 'cards' && 'gap-2',
        )}
      >
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'relative flex min-w-0 cursor-pointer gap-2 transition-colors',
              'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
              'has-disabled:cursor-not-allowed has-disabled:opacity-60',
              layout === 'segmented' &&
                'items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-muted hover:text-fg has-checked:bg-surface has-checked:text-fg has-checked:shadow-sm',
              layout === 'cards' &&
                'flex-col rounded-xl border border-line-strong bg-surface px-3 py-2.5 hover:border-accent/60 has-checked:border-accent has-checked:bg-accent-soft has-checked:ring-1 has-checked:ring-accent',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span className={cn('flex min-w-0 items-center gap-2', layout === 'cards' && 'text-sm font-medium')}>
              {option.icon}
              <span className="truncate">{option.label}</span>
            </span>
            {option.description && layout === 'cards' && (
              <span className="text-xs leading-snug text-muted">{option.description}</span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
