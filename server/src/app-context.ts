import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { MediaTools, ScriptPlanner, StorageDriver, TextModelClient, VideoModelClient } from './core/ports.js';
import { createPool, type Db } from './db/pool.js';
import { GenerationRepository } from './db/repository.js';
import { createTextClient, createVideoClient } from './gemini/index.js';
import { createLogger } from './logger.js';
import { createMediaTools } from './media/ffmpeg.js';
import { createTransportStore } from './db/transport-store.js';
import { PgTurnLimiter } from './db/turn-limiter.js';
import { GenerationPipeline } from './pipeline/runner.js';
import { Worker } from './pipeline/worker.js';
import { createPlanner } from './script/planner.js';
import { createStorage } from './storage/index.js';

/** Every long-lived dependency of a process (API, worker, or both). */
export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  repo: GenerationRepository;
  storage: StorageDriver;
  media: MediaTools;
  video: VideoModelClient;
  text: TextModelClient;
  planner: ScriptPlanner;
  pipeline: GenerationPipeline;
  /** Present only when this process runs jobs (`ROLE=all` or `ROLE=worker`). */
  worker: Worker | null;
}

/**
 * How long a stopping worker waits for its jobs to release their leases. Cloud Run sends SIGKILL 10s
 * after SIGTERM, so this stays below that; a job still busy after it keeps its lease until the lease
 * expires, and another worker then resumes it from its last checkpoint.
 */
export const WORKER_SHUTDOWN_GRACE_MS = 8_000;

/** Whether a process with this role runs the job worker. */
export function runsWorker(role: AppConfig['role']): boolean {
  return role === 'all' || role === 'worker';
}

/**
 * Wires the application. Any dependency can be replaced through `overrides` (tests, tools); the
 * real implementation of a dependency is only constructed when it is not overridden.
 */
export function createAppContext(config: AppConfig, overrides: Partial<AppContext> = {}): AppContext {
  const logger = overrides.logger ?? createLogger(config);
  const db = overrides.db ?? createPool(config);
  const repo = overrides.repo ?? new GenerationRepository(db);
  const storage = overrides.storage ?? createStorage(config);
  const media = overrides.media ?? createMediaTools(config);
  const video = overrides.video ?? createVideoClient(config, logger, media, createTransportStore(repo, logger));
  const text = overrides.text ?? createTextClient(config, logger);
  const planner = overrides.planner ?? createPlanner(config, text, logger);
  const pipeline =
    overrides.pipeline ??
    new GenerationPipeline({
      config,
      repo,
      video,
      planner,
      storage,
      media,
      logger,
      // Cluster-wide cap on concurrent Omni turns (parallel streams on one key are reported to be cut).
      turnLimiter: new PgTurnLimiter(db, config.gemini.maxConcurrentTurns),
    });

  let worker: Worker | null;
  if ('worker' in overrides) {
    worker = overrides.worker ?? null;
  } else if (runsWorker(config.role)) {
    worker = new Worker({
      repo,
      pipeline,
      logger,
      concurrency: config.worker.concurrency,
      pollIntervalMs: config.worker.pollIntervalMs,
      leaseMs: config.worker.leaseMs,
      shutdownGraceMs: WORKER_SHUTDOWN_GRACE_MS,
    });
  } else {
    worker = null;
  }

  return { config, logger, db, repo, storage, media, video, text, planner, pipeline, worker };
}

const closed = new WeakSet<AppContext>();

/** Stops the worker (which releases job leases) and then closes the database pool. Idempotent. */
export async function closeAppContext(ctx: AppContext): Promise<void> {
  if (closed.has(ctx)) return;
  closed.add(ctx);
  try {
    await ctx.worker?.stop();
  } catch (err) {
    ctx.logger.error({ err }, 'failed to stop the worker cleanly');
  }
  await ctx.db.end();
}
