import type { GenerationRecord } from '../core/ports.js';
import { estimateRemainingSeconds, progressWithinStage, type StageTimings } from '../pipeline/progress.js';
import { isTerminalStatus, type GenerationDTO, type GenerationEvent, type GenerationListItem } from '../shared/api.js';

/**
 * Interactions are retained for 55 days on the paid tier; part 2 can only be re-run on top of a
 * part 1 interaction that is younger than this (one day of margin).
 */
export const PART1_REUSE_MAX_AGE_MS = 54 * 24 * 60 * 60 * 1000;

/** Typical seconds for one real Omni turn, used for progress interpolation and ETAs. */
export const REAL_TURN_SECONDS = 120;

export interface DtoOptions {
  /** Seconds per Omni turn for ETAs (120 for the real model, MOCK_TURN_SECONDS in mock mode). */
  turnSeconds?: number;
  /** When the reused part 1 interaction was created (defaults to the record's createdAt). */
  part1CreatedAt?: Date | null;
}

export function mediaUrls(id: string) {
  const base = `/api/generations/${id}`;
  return {
    video: `${base}/video`,
    download: `${base}/video?download=1`,
    part1: `${base}/part1`,
    thumbnail: `${base}/thumbnail`,
    character: `${base}/character`,
  };
}

/** Whether part 2 can be regenerated on top of this record's part 1 interaction. */
export function canRegeneratePart2(g: GenerationRecord, nowMs: number, part1CreatedAt?: Date | null): boolean {
  if (!g.part1VideoKey || !g.part1InteractionId || !g.plan) return false;
  if (!isTerminalStatus(g.status)) return false;
  const created = (part1CreatedAt ?? g.createdAt).getTime();
  return nowMs - created < PART1_REUSE_MAX_AGE_MS;
}

const ACTIVE_STAGES = new Set(['planning', 'uploading_image', 'generating_part1', 'extending_part2', 'finalizing']);

function liveProgress(g: GenerationRecord, nowMs: number, timings: StageTimings): number {
  if (g.status === 'succeeded') return 100;
  if (g.status !== 'running' || !ACTIVE_STAGES.has(g.stage) || !g.stageStartedAt) return g.progress;
  // The worker only persists progress on poll ticks; interpolate between them so the bar keeps moving.
  const elapsedSec = (nowMs - g.stageStartedAt.getTime()) / 1000;
  return Math.max(g.progress, progressWithinStage(g.stage, elapsedSec, timings));
}

function etaSeconds(g: GenerationRecord, nowMs: number, timings: StageTimings): number | null {
  if (g.status !== 'queued' && g.status !== 'running') return null;
  const elapsedSec = g.stageStartedAt ? Math.max((nowMs - g.stageStartedAt.getTime()) / 1000, 0) : 0;
  const remaining = estimateRemainingSeconds(g.stage, elapsedSec, timings, {
    part1Done: Boolean(g.part1VideoKey),
    skipPlanning: Boolean(g.plan),
  });
  if (remaining === null) return null;
  // A job waiting for a retry is not picked up before run_after.
  const waitSec = g.status === 'queued' ? Math.max((g.runAfter.getTime() - nowMs) / 1000, 0) : 0;
  return Math.round(remaining + waitSec);
}

export function toGenerationDTO(
  g: GenerationRecord,
  events: GenerationEvent[],
  now: Date | number = Date.now(),
  opts: DtoOptions = {},
): GenerationDTO {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const timings: StageTimings = { turnSeconds: opts.turnSeconds ?? REAL_TURN_SECONDS };
  const urls = mediaUrls(g.id);
  return {
    id: g.id,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    status: g.status,
    stage: g.stage,
    progress: Math.round(liveProgress(g, nowMs, timings) * 10) / 10,
    stageStartedAt: g.stageStartedAt?.toISOString() ?? null,
    etaSeconds: etaSeconds(g, nowMs, timings),
    title: g.title,
    script: g.script,
    settings: g.settings,
    plan: g.plan,
    characterImageUrl: urls.character,
    part1VideoUrl: g.part1VideoKey ? urls.part1 : null,
    videoUrl: g.finalVideoKey ? urls.video : null,
    downloadUrl: g.finalVideoKey ? urls.download : null,
    thumbnailUrl: g.thumbnailKey ? urls.thumbnail : null,
    durationSec: g.durationSec,
    assembly: g.assembly,
    estimatedCost: g.estimatedCost,
    actualCost: g.actualCost,
    error: g.error,
    parentId: g.parentId,
    regenerationMode: g.regenerationMode,
    canRegeneratePart2: canRegeneratePart2(g, nowMs, opts.part1CreatedAt),
    canCancel: (g.status === 'queued' || g.status === 'running') && !g.cancelRequested,
    events,
    startedAt: g.startedAt?.toISOString() ?? null,
    completedAt: g.completedAt?.toISOString() ?? null,
  };
}

export function toListItem(g: GenerationRecord): GenerationListItem {
  const urls = mediaUrls(g.id);
  return {
    id: g.id,
    createdAt: g.createdAt.toISOString(),
    status: g.status,
    stage: g.stage,
    progress: g.status === 'succeeded' ? 100 : g.progress,
    title: g.title,
    settings: g.settings,
    thumbnailUrl: g.thumbnailKey ? urls.thumbnail : null,
    characterImageUrl: urls.character,
    durationSec: g.durationSec,
    estimatedCostUsd: g.estimatedCostUsd,
    actualCostUsd: g.actualCostUsd,
    parentId: g.parentId,
    regenerationMode: g.regenerationMode,
    error: g.error,
  };
}
