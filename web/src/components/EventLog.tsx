import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { STAGE_LABELS, type GenerationEvent } from '@shared/api';
import { formatClock, formatDateTime, formatTime, secondsBetween } from '../lib/format';
import { cn } from '../lib/cn';

const LEVEL_ICON = {
  info: <Info className="size-3.5 text-info" aria-hidden="true" />,
  warn: <TriangleAlert className="size-3.5 text-warn" aria-hidden="true" />,
  error: <CircleAlert className="size-3.5 text-danger" aria-hidden="true" />,
} as const;

/** Chronological timeline of pipeline events, with offsets from the first event. */
export function EventLog({ events }: { events: GenerationEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted">No events yet.</p>;
  }
  const sorted = [...events].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const start = sorted[0]?.at ?? null;
  return (
    // Focusable so keyboard users can scroll a long log.
    <ol tabIndex={0} className="max-h-96 space-y-2 overflow-y-auto pr-1 text-sm" aria-label="Event log">
      {sorted.map((event, index) => (
        <li key={`${event.at}-${index}`} className="flex gap-3">
          <time
            dateTime={event.at}
            title={formatDateTime(event.at)}
            className="w-12 shrink-0 pt-px text-right font-mono text-xs text-subtle tabular-nums"
          >
            +{formatClock(start ? secondsBetween(start, event.at) : 0)}
          </time>
          <span className="mt-1 shrink-0">
            {LEVEL_ICON[event.level]}
            <span className="sr-only">{event.level}</span>
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn('break-words', event.level === 'error' ? 'text-danger' : 'text-fg')}>{event.message}</p>
            <p className="text-xs text-subtle">
              {STAGE_LABELS[event.stage] ?? event.stage} · {formatTime(event.at)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
