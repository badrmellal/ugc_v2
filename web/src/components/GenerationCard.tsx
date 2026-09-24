import { Clock, RefreshCw, Scissors } from 'lucide-react';
import { Link } from 'react-router';
import type { GenerationListItem } from '@shared/api';
import { formatDateTime, formatRelativeTime, formatUsd, formatVideoLength } from '../lib/format';
import { RESOLUTION_LABELS, STYLE_LABELS } from '../lib/options';
import { StatusBadge, Tag } from './StatusBadge';

export function GenerationCard({ item, now }: { item: GenerationListItem; now: number }) {
  const image = item.thumbnailUrl ?? item.characterImageUrl;
  const active = item.status === 'queued' || item.status === 'running';
  return (
    <li>
      <Link
        to={`/generations/${encodeURIComponent(item.id)}`}
        className="group block overflow-hidden rounded-2xl border border-line bg-surface shadow-xs transition-shadow hover:shadow-md"
      >
        <div className="relative aspect-[9/16] bg-surface-2">
          <img
            src={image}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
          <div className="absolute top-2 left-2">
            <StatusBadge status={item.status} progress={item.progress} className="shadow-sm" />
          </div>
          {item.durationSec !== null && (
            <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
              {formatVideoLength(item.durationSec)}
            </span>
          )}
          {active && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/30">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${item.progress}%` }} />
            </div>
          )}
        </div>
        <div className="space-y-1.5 p-3">
          <p className="line-clamp-2 text-sm leading-snug font-medium group-hover:text-accent-text">
            {item.title || 'Untitled'}
          </p>
          <p className="text-xs text-muted">
            {STYLE_LABELS[item.settings.style]} · {RESOLUTION_LABELS[item.settings.resolution]} ·{' '}
            <span className="tabular-nums">
              {item.actualCostUsd !== null ? formatUsd(item.actualCostUsd) : `est. ${formatUsd(item.estimatedCostUsd)}`}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <time
              dateTime={item.createdAt}
              title={formatDateTime(item.createdAt)}
              className="inline-flex items-center gap-1 text-xs text-subtle"
            >
              <Clock className="size-3" aria-hidden="true" />
              {formatRelativeTime(item.createdAt, now)}
            </time>
            {item.regenerationMode === 'full' && (
              <Tag className="px-1.5 py-0 text-[11px]">
                <RefreshCw className="size-3" aria-hidden="true" />
                Regenerated
              </Tag>
            )}
            {item.regenerationMode === 'part2' && (
              <Tag className="px-1.5 py-0 text-[11px]">
                <Scissors className="size-3" aria-hidden="true" />
                Part 2 regen
              </Tag>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}
