import type { GenerationStage } from '../shared/api.js';

/** Overall progress window [start, end] (percent) owned by each active stage. */
export const STAGE_WINDOWS: Record<GenerationStage, [number, number]> = {
  queued: [0, 0],
  planning: [1, 6],
  uploading_image: [6, 10],
  generating_part1: [10, 50],
  extending_part2: [50, 90],
  finalizing: [90, 99],
  completed: [100, 100],
  failed: [0, 0],
  canceled: [0, 0],
};

export interface StageTimings {
  /** Typical seconds for one Omni turn (used for time-based progress inside generation stages). */
  turnSeconds: number;
}

/** Typical duration of each stage in seconds. Only used for progress interpolation and ETAs. */
export function expectedStageSeconds(stage: GenerationStage, t: StageTimings): number {
  switch (stage) {
    case 'queued':
      return 5;
    case 'planning':
      return 8;
    case 'uploading_image':
      return 4;
    case 'generating_part1':
    case 'extending_part2':
      return t.turnSeconds;
    case 'finalizing':
      return 10;
    default:
      return 0;
  }
}

/**
 * Progress inside a stage, interpolated by elapsed time on an ease-out curve that approaches (but
 * never reaches) the end of the stage window, so the bar keeps moving on slow turns.
 */
export function progressWithinStage(stage: GenerationStage, elapsedSec: number, t: StageTimings): number {
  const [start, end] = STAGE_WINDOWS[stage];
  if (end <= start) return start;
  const expected = Math.max(expectedStageSeconds(stage, t), 1);
  const ratio = 1 - Math.exp(-Math.max(elapsedSec, 0) / expected);
  return Math.round((start + (end - start) * Math.min(ratio, 0.97)) * 10) / 10;
}

const ACTIVE_ORDER: GenerationStage[] = [
  'queued',
  'planning',
  'uploading_image',
  'generating_part1',
  'extending_part2',
  'finalizing',
];

/** Remaining seconds, or null for terminal stages. */
export function estimateRemainingSeconds(
  stage: GenerationStage,
  stageElapsedSec: number,
  t: StageTimings,
  opts: { part1Done?: boolean; skipPlanning?: boolean } = {},
): number | null {
  const idx = ACTIVE_ORDER.indexOf(stage);
  if (idx < 0) return null;
  let remaining = Math.max(expectedStageSeconds(stage, t) - stageElapsedSec, stage === 'finalizing' ? 2 : 5);
  for (const next of ACTIVE_ORDER.slice(idx + 1)) {
    if (next === 'generating_part1' && opts.part1Done) continue;
    if (next === 'planning' && opts.skipPlanning) continue;
    remaining += expectedStageSeconds(next, t);
  }
  return Math.round(remaining);
}
