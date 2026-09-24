import { cn } from '../lib/cn';
import { pacingMessage, type Pacing, type PacingLevel } from '../lib/pacing';

const TONE: Record<PacingLevel, { text: string; bar: string; label: string }> = {
  empty: { text: 'text-muted', bar: 'bg-subtle', label: 'No dialogue yet' },
  good: { text: 'text-ok', bar: 'bg-ok', label: 'Good length' },
  tight: { text: 'text-warn', bar: 'bg-warn', label: 'Long' },
  over: { text: 'text-danger', bar: 'bg-danger', label: 'Too long' },
};

/**
 * Estimated spoken length (green fits comfortably, amber is fast, red does not fit). The bar spans the
 * hard limit; the tick marks the comfortable budget.
 */
export function PacingMeter({ pacing, id }: { pacing: Pacing; id?: string }) {
  const tone = TONE[pacing.level];
  const width = Math.min(1, pacing.ratio) * 100;
  const tick = pacing.maxSeconds > 0 ? (pacing.comfortableSeconds / pacing.maxSeconds) * 100 : 100;
  return (
    <div id={id} className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className={cn('font-medium', tone.text)}>
          {tone.label}
          <span className="sr-only">:</span>
        </span>
        <span className="text-muted tabular-nums">
          {pacing.words} {pacing.words === 1 ? 'word' : 'words'} · about {pacing.seconds.toFixed(1)}s of speech
          (comfortable up to {pacing.comfortableSeconds}s)
        </span>
      </div>
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-label="Estimated spoken length"
        aria-valuemin={0}
        aria-valuemax={pacing.maxSeconds}
        aria-valuenow={Math.min(pacing.seconds, pacing.maxSeconds)}
        aria-valuetext={`About ${pacing.seconds.toFixed(1)} seconds of speech, comfortable up to ${pacing.comfortableSeconds} seconds`}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', tone.bar)}
          style={{ width: `${width}%` }}
        />
        <span aria-hidden="true" className="absolute inset-y-0 w-px bg-fg/40" style={{ left: `${tick}%` }} />
      </div>
      <p className="text-xs text-muted">{pacingMessage(pacing)}</p>
    </div>
  );
}

/** One-line variant used for each part of the split. */
export function PacingInline({ pacing }: { pacing: Pacing }) {
  const tone = TONE[pacing.level];
  return (
    <span className={cn('text-xs tabular-nums', tone.text)}>
      about {pacing.seconds.toFixed(1)}s of {pacing.comfortableSeconds}s
      {pacing.level === 'tight' || pacing.level === 'over' ? `, ${tone.label.toLowerCase()}` : ''}
    </span>
  );
}
