import { LIMITS } from '@shared/api';
import { useId, useMemo } from 'react';
import { analyzePacing } from '../lib/pacing';
import { cn } from '../lib/cn';
import { describedBy, inputClass } from './Field';
import { PacingMeter } from './PacingMeter';

export function ScriptEditor({
  value,
  onChange,
  error,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  const pacing = useMemo(() => analyzePacing(value), [value]);
  const nearLimit = value.length > LIMITS.scriptMaxChars * 0.9;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          Script (20 seconds)
        </label>
        <span className={cn('text-xs tabular-nums', nearLimit ? 'text-warn' : 'text-subtle')}>
          {value.length.toLocaleString()} / {LIMITS.scriptMaxChars.toLocaleString()}
        </span>
      </div>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, LIMITS.scriptMaxChars))}
        maxLength={LIMITS.scriptMaxChars}
        rows={8}
        disabled={disabled}
        spellCheck
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(`${id}-hint`, `${id}-pacing`, error && `${id}-error`)}
        placeholder={
          'Write everything the character says, plus any action notes.\n\nExample: Okay, I finally tried the overnight oats everyone keeps talking about. Here is my honest take after one week...'
        }
        className={cn(inputClass, 'min-h-44 resize-y leading-relaxed')}
      />
      <p id={`${id}-hint`} className="text-xs text-muted">
        The backend splits this into two coherent 10-second parts: part 1 is generated, part 2 extends it in the same
        interaction.
      </p>
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
      <PacingMeter pacing={pacing} id={`${id}-pacing`} />
    </div>
  );
}
