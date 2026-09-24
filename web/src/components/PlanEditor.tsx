import { RefreshCw, TriangleAlert, Undo2 } from 'lucide-react';
import { useId } from 'react';
import type { ScriptPlan, SegmentPlan } from '@shared/api';
import { analyzePacing, PART_BUDGET } from '../lib/pacing';
import {
  BIBLE_FIELDS,
  PLAN_SOURCE_LABELS,
  SEGMENT_FIELDS,
  updateBibleField,
  updateSegmentField,
  type SegmentField,
} from '../lib/plan';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { Collapsible } from './Collapsible';
import { inputClass } from './Field';
import { PacingInline } from './PacingMeter';
import { Tag } from './StatusBadge';

interface PlanEditorProps {
  plan: ScriptPlan;
  onChange: (plan: ScriptPlan) => void;
  /** The script or settings changed after this split was made. */
  stale: boolean;
  /** The user edited this split in the form. */
  edited: boolean;
  onRefresh: () => void;
  refreshing: boolean;
  onDiscard: () => void;
}

/** Editable review of the two-part split: continuity bible plus dialogue/action/camera/text for each part. */
export function PlanEditor({ plan, onChange, stale, edited, onRefresh, refreshing, onDiscard }: PlanEditorProps) {
  const id = useId();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Tag className={cn(edited && 'border-accent/40 text-accent-text')}>
            {edited ? PLAN_SOURCE_LABELS.user : PLAN_SOURCE_LABELS[plan.source]}
          </Tag>
          <span>Language: {plan.language}</span>
          <span aria-hidden="true">·</span>
          <span>Dialogue about {plan.estimatedSpokenSeconds.toFixed(1)}s</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={onRefresh}
            loading={refreshing}
            icon={<RefreshCw className="size-4" aria-hidden="true" />}
          >
            Refresh split
          </Button>
          <Button size="sm" variant="ghost" onClick={onDiscard} icon={<Undo2 className="size-4" aria-hidden="true" />}>
            Discard split
          </Button>
        </div>
      </div>

      {stale && (
        <div role="status" className="flex gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">This preview is out of date</p>
            <p className="mt-0.5 text-muted">
              The script or settings changed after the split was made.{' '}
              {edited
                ? 'Your edited split will be used as is unless you refresh it.'
                : 'If you generate now, the current script is split again automatically.'}
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={onRefresh}
              loading={refreshing}
              icon={<RefreshCw className="size-4" aria-hidden="true" />}
            >
              Refresh now
            </Button>
          </div>
        </div>
      )}

      {plan.warnings.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm">
          {plan.warnings.map((warning, index) => (
            <li key={`${index}-${warning}`} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
              <span className="text-muted">{warning}</span>
            </li>
          ))}
        </ul>
      )}

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Continuity bible</legend>
        <p className="text-xs text-muted">Shared by both parts so the character, scene and voice stay identical.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {BIBLE_FIELDS.map(({ field, label, hint }) => (
            <div key={field} className="space-y-1">
              <label htmlFor={`${id}-${field}`} className="text-xs font-medium text-muted">
                {label}
              </label>
              <textarea
                id={`${id}-${field}`}
                value={plan[field]}
                onChange={(event) => onChange(updateBibleField(plan, field, event.target.value))}
                rows={3}
                placeholder={hint}
                className={cn(inputClass, 'resize-y text-[13px]')}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 xl:grid-cols-2">
        {plan.segments.map((segment, index) => (
          <SegmentEditor
            key={segment.index}
            segment={segment}
            edited={edited}
            onChange={(field, value) => onChange(updateSegmentField(plan, index === 0 ? 0 : 1, field, value))}
          />
        ))}
      </div>
    </div>
  );
}

function SegmentEditor({
  segment,
  edited,
  onChange,
}: {
  segment: SegmentPlan;
  edited: boolean;
  onChange: (field: SegmentField, value: string) => void;
}) {
  const id = useId();
  const pacing = analyzePacing(segment.dialogue, PART_BUDGET);
  return (
    <fieldset className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <legend className="sr-only">
        Part {segment.index}, {segment.startSec} to {segment.endSec} seconds
      </legend>
      <div className="flex items-center justify-between gap-2" aria-hidden="true">
        <p className="text-sm font-semibold">
          Part {segment.index}{' '}
          <span className="font-normal text-muted">
            ({segment.startSec}-{segment.endSec}s)
          </span>
        </p>
        <span className="text-xs text-muted">{segment.index === 1 ? 'Generation' : 'Extension'}</span>
      </div>
      {SEGMENT_FIELDS.map(({ field, label, multiline }) => (
        <div key={field} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={`${id}-${field}`} className="text-xs font-medium text-muted">
              {label}
            </label>
            {field === 'dialogue' && <PacingInline pacing={pacing} />}
          </div>
          {multiline ? (
            <textarea
              id={`${id}-${field}`}
              value={segment[field]}
              onChange={(event) => onChange(field, event.target.value)}
              rows={field === 'dialogue' ? 4 : 3}
              className={cn(inputClass, 'resize-y text-[13px]')}
            />
          ) : (
            <input
              id={`${id}-${field}`}
              value={segment[field]}
              onChange={(event) => onChange(field, event.target.value)}
              placeholder={field === 'onScreenText' ? 'None' : undefined}
              className={cn(inputClass, 'text-[13px]')}
            />
          )}
        </div>
      ))}
      <Collapsible summary="Prompt sent to Omni" summaryClassName="text-xs">
        {edited && (
          <p className="mb-2 text-xs text-muted">
            Shown as previewed. The server rebuilds it from the fields above when you generate.
          </p>
        )}
        <pre
          tabIndex={0}
          className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted"
        >
          {segment.prompt}
        </pre>
      </Collapsible>
    </fieldset>
  );
}
