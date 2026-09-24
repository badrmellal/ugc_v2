import { Ban, Circle, CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import type { GenerationDTO } from '@shared/api';
import { formatDuration, secondsBetween } from '../lib/format';
import { computeSteps, type StepState } from '../lib/stages';
import { cn } from '../lib/cn';

const STATE_TEXT: Record<StepState, string> = {
  pending: 'Pending',
  active: 'In progress',
  done: 'Done',
  failed: 'Failed',
  canceled: 'Canceled',
};

function StepIcon({ state }: { state: StepState }) {
  const cls = 'size-5';
  switch (state) {
    case 'done':
      return <CircleCheck className={cn(cls, 'text-ok')} aria-hidden="true" />;
    case 'active':
      return <LoaderCircle className={cn(cls, 'animate-spin text-accent')} aria-hidden="true" />;
    case 'failed':
      return <CircleX className={cn(cls, 'text-danger')} aria-hidden="true" />;
    case 'canceled':
      return <Ban className={cn(cls, 'text-subtle')} aria-hidden="true" />;
    case 'pending':
      return <Circle className={cn(cls, 'text-line-strong')} aria-hidden="true" />;
  }
}

/** Vertical stepper for planning, upload, part 1, extension and finalizing. */
export function StageStepper({
  generation,
  now,
}: {
  generation: Pick<GenerationDTO, 'status' | 'stage' | 'events' | 'stageStartedAt' | 'regenerationMode'>;
  now: number;
}) {
  const steps = computeSteps(generation);
  return (
    <ol className="space-y-0" aria-label="Generation steps">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const reused =
          generation.regenerationMode === 'part2' && step.stage === 'generating_part1' && step.state === 'done';
        return (
          <li
            key={step.stage}
            className="relative flex gap-3 pb-4 last:pb-0"
            aria-current={step.state === 'active' ? 'step' : undefined}
          >
            {!last && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute top-6 bottom-0 left-[9.5px] w-px',
                  step.state === 'done' ? 'bg-ok/50' : 'bg-line-strong',
                )}
              />
            )}
            <span className="relative z-10 shrink-0 bg-surface">
              <StepIcon state={step.state} />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-sm',
                  step.state === 'pending' ? 'text-muted' : 'font-medium text-fg',
                  step.state === 'failed' && 'text-danger',
                )}
              >
                {step.label}
              </p>
              <p className="text-xs text-subtle">
                {STATE_TEXT[step.state]}
                {reused && ' (reused from the source video)'}
                {step.state === 'active' &&
                  generation.stageStartedAt &&
                  ` · ${formatDuration(secondsBetween(generation.stageStartedAt, now))}`}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
