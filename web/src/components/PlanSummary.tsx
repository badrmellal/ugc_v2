import { TriangleAlert } from 'lucide-react';
import type { ScriptPlan } from '@shared/api';
import { BIBLE_FIELDS, PLAN_SOURCE_LABELS } from '../lib/plan';
import { Collapsible } from './Collapsible';
import { Tag } from './StatusBadge';

/** Read-only view of the split that was used: continuity bible, both parts and their Omni prompts. */
export function PlanSummary({ plan }: { plan: ScriptPlan }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Tag>{PLAN_SOURCE_LABELS[plan.source]}</Tag>
        <span>Language: {plan.language}</span>
        <span aria-hidden="true">·</span>
        <span>Dialogue about {plan.estimatedSpokenSeconds.toFixed(1)}s</span>
      </div>
      {plan.warnings.length > 0 && (
        <ul className="space-y-1">
          {plan.warnings.map((warning) => (
            <li key={warning} className="flex gap-2 text-muted">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
              {warning}
            </li>
          ))}
        </ul>
      )}
      <dl className="grid gap-3 sm:grid-cols-2">
        {BIBLE_FIELDS.map(({ field, label }) => (
          <div key={field}>
            <dt className="text-xs font-medium text-muted">{label}</dt>
            <dd className="mt-0.5 break-words">{plan[field] || <span className="text-subtle">Not set</span>}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-3 lg:grid-cols-2">
        {plan.segments.map((segment) => (
          <article key={segment.index} className="space-y-2 rounded-xl border border-line p-3">
            <h3 className="text-sm font-semibold">
              Part {segment.index}{' '}
              <span className="font-normal text-muted">
                ({segment.startSec}-{segment.endSec}s)
              </span>
            </h3>
            <dl className="space-y-2">
              <div>
                <dt className="text-xs font-medium text-muted">Dialogue</dt>
                <dd className="mt-0.5 break-words">
                  {segment.dialogue ? `"${segment.dialogue}"` : <span className="text-subtle">No dialogue</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Action</dt>
                <dd className="mt-0.5 break-words">{segment.action || '-'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Camera</dt>
                <dd className="mt-0.5 break-words">{segment.camera || '-'}</dd>
              </div>
              {segment.onScreenText && (
                <div>
                  <dt className="text-xs font-medium text-muted">On-screen text</dt>
                  <dd className="mt-0.5 break-words">{segment.onScreenText}</dd>
                </div>
              )}
            </dl>
            <Collapsible summary="Prompt sent to Omni" summaryClassName="text-xs">
              <pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted">
                {segment.prompt}
              </pre>
            </Collapsible>
          </article>
        ))}
      </div>
    </div>
  );
}
