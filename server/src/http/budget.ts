import type { GenerationRepository } from '../db/repository.js';
import { HttpError } from './errors.js';

export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Rejects a new job (402 budget_exceeded) when today's recorded spend, plus what queued and running
 * jobs are still expected to cost, plus this job's estimate would exceed DAILY_BUDGET_USD.
 */
export async function assertWithinBudget(
  repo: Pick<GenerationRepository, 'spendSince'>,
  dailyLimitUsd: number | null,
  estimateUsd: number,
  now: Date = new Date(),
): Promise<void> {
  const limit = dailyLimitUsd;
  if (limit === null) return;
  const { spentUsd, reservedUsd } = await repo.spendSince(startOfUtcDay(now));
  if (spentUsd + reservedUsd + estimateUsd <= limit) return;
  const remaining = Math.max(limit - spentUsd - reservedUsd, 0);
  throw new HttpError(
    402,
    'budget_exceeded',
    `This video is estimated at ${usd(estimateUsd)}, but only ${usd(remaining)} of today's ${usd(limit)} budget remains (${usd(spentUsd)} spent, ${usd(reservedUsd)} reserved by queued or running videos). The budget resets at 00:00 UTC.`,
    {
      dailyLimitUsd: limit,
      spentTodayUsd: Math.round(spentUsd * 1e4) / 1e4,
      reservedUsd: Math.round(reservedUsd * 1e4) / 1e4,
      estimateUsd,
      remainingUsd: Math.round(remaining * 1e4) / 1e4,
    },
  );
}

/** Rejects a new job (429 queue_full) when MAX_QUEUED_JOBS jobs are already queued or running. */
export async function assertQueueCapacity(
  repo: Pick<GenerationRepository, 'countActive'>,
  maxQueuedJobs: number,
): Promise<void> {
  const active = await repo.countActive();
  if (active < maxQueuedJobs) return;
  throw new HttpError(
    429,
    'queue_full',
    `${active} videos are already queued or generating (limit ${maxQueuedJobs}). Wait for one to finish or cancel one, then try again.`,
  );
}
