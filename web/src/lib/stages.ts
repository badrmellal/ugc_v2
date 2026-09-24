/** Maps a generation's status/stage/events to the progress stepper. */
import { STAGE_LABELS, type GenerationDTO, type GenerationStage } from '@shared/api';

export const PIPELINE_STAGES = [
  'planning',
  'uploading_image',
  'generating_part1',
  'extending_part2',
  'finalizing',
] as const satisfies readonly GenerationStage[];

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type StepState = 'pending' | 'active' | 'done' | 'failed' | 'canceled';

export interface Step {
  stage: PipelineStage;
  label: string;
  state: StepState;
}

function pipelineIndex(stage: GenerationStage): number {
  return (PIPELINE_STAGES as readonly GenerationStage[]).indexOf(stage);
}

/** Index of the last pipeline stage the job reached, based on its current stage or its event log. */
function lastReachedIndex(
  g: Pick<GenerationDTO, 'stage' | 'events'> & Partial<Pick<GenerationDTO, 'failedStage'>>,
): number {
  const current = pipelineIndex(g.stage);
  if (current >= 0) return current;
  if (g.failedStage) {
    const stopped = pipelineIndex(g.failedStage);
    if (stopped >= 0) return stopped;
  }
  let reached = -1;
  for (const event of g.events) {
    reached = Math.max(reached, pipelineIndex(event.stage));
  }
  return reached;
}

export function computeSteps(
  g: Pick<GenerationDTO, 'status' | 'stage' | 'events'> & Partial<Pick<GenerationDTO, 'failedStage'>>,
): Step[] {
  const build = (stateAt: (index: number) => StepState): Step[] =>
    PIPELINE_STAGES.map((stage, index) => ({ stage, label: STAGE_LABELS[stage], state: stateAt(index) }));

  if (g.status === 'succeeded' || g.stage === 'completed') return build(() => 'done');

  const reached = lastReachedIndex(g);
  // Queued: a new job has no pipeline events yet; a job waiting for a retry keeps the stages it finished.
  if (g.status === 'queued') return build((i) => (i < reached ? 'done' : 'pending'));

  if (g.status === 'running') {
    if (reached < 0) return build(() => 'pending');
    return build((i) => (i < reached ? 'done' : i === reached ? 'active' : 'pending'));
  }

  // failed or canceled: mark where it stopped.
  const terminal: StepState = g.status === 'failed' ? 'failed' : 'canceled';
  if (reached < 0) {
    return build((i) => (terminal === 'failed' && i === 0 ? 'failed' : 'pending'));
  }
  return build((i) => (i < reached ? 'done' : i === reached ? terminal : 'pending'));
}
