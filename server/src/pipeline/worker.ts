import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { GenerationRecord } from '../core/ports.js';
import type { GenerationRepository } from '../db/repository.js';
import { LeaseLostError, ShutdownError } from './errors.js';
import { abortableSleep, type GenerationPipeline, type JobContext } from './runner.js';

export interface WorkerOptions {
  repo: GenerationRepository;
  pipeline: Pick<GenerationPipeline, 'run'>;
  logger: Logger;
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  /** Max time to wait for running jobs to release their leases on shutdown. */
  shutdownGraceMs?: number;
}

interface ActiveJob {
  id: string;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Claims jobs from Postgres and runs them with bounded concurrency. Each job holds a lease that a
 * heartbeat renews; losing the lease aborts the local run (another worker has taken over).
 */
export class Worker {
  readonly id = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly active = new Map<string, ActiveJob>();
  private running = false;
  private loopDone: Promise<void> | null = null;
  private readonly stopController = new AbortController();
  private wake: (() => void) | null = null;

  constructor(private readonly opts: WorkerOptions) {}

  get activeCount(): number {
    return this.active.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.logger.info({ worker: this.id, concurrency: this.opts.concurrency }, 'worker started');
    this.loopDone = this.loop();
  }

  /** Wakes the claim loop immediately (e.g. right after a job was enqueued in the same process). */
  notify(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopController.abort(new ShutdownError());
    this.wake?.();
    for (const job of this.active.values()) job.controller.abort(new ShutdownError());
    const grace = this.opts.shutdownGraceMs ?? 20_000;
    await Promise.race([
      Promise.allSettled([...this.active.values()].map((j) => j.done)),
      new Promise((r) => setTimeout(r, grace).unref()),
    ]);
    await this.loopDone?.catch(() => undefined);
    this.opts.logger.info({ worker: this.id }, 'worker stopped');
  }

  private async loop(): Promise<void> {
    let backoffMs = this.opts.pollIntervalMs;
    while (this.running) {
      if (this.active.size >= this.opts.concurrency) {
        await this.idle(this.opts.pollIntervalMs);
        continue;
      }
      let job: GenerationRecord | null;
      try {
        job = await this.opts.repo.claimNext(this.id, this.opts.leaseMs);
        backoffMs = this.opts.pollIntervalMs;
      } catch (err) {
        this.opts.logger.error({ err }, 'failed to claim job');
        backoffMs = Math.min(backoffMs * 2, 30_000);
        await this.idle(backoffMs);
        continue;
      }
      if (!job) {
        await this.idle(this.opts.pollIntervalMs);
        continue;
      }
      this.launch(job);
    }
  }

  private launch(job: GenerationRecord): void {
    const controller = new AbortController();
    let cancelRequested = job.cancelRequested;
    const log = this.opts.logger.child({ generationId: job.id, worker: this.id });
    log.info({ attempts: job.attempts, stage: job.stage }, 'job claimed');

    const heartbeatEvery = Math.max(Math.floor(this.opts.leaseMs / 3), 1000);
    const heartbeat = setInterval(() => {
      this.opts.repo
        .heartbeat(job.id, this.id, this.opts.leaseMs)
        .then((fresh) => {
          if (!fresh) {
            controller.abort(new LeaseLostError());
            return;
          }
          if (fresh.cancelRequested) cancelRequested = true;
        })
        .catch((err: unknown) => log.warn({ err }, 'heartbeat failed'));
    }, heartbeatEvery);
    heartbeat.unref();

    const ctx: JobContext = {
      workerId: this.id,
      signal: controller.signal,
      cancelRequested: () => cancelRequested,
    };

    const done = this.opts.pipeline
      .run(job, ctx)
      .catch((err: unknown) => log.error({ err }, 'job crashed'))
      .finally(() => {
        clearInterval(heartbeat);
        this.active.delete(job.id);
        this.wake?.();
      });
    this.active.set(job.id, { id: job.id, controller, done });
  }

  private async idle(ms: number): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      abortableSleep(ms, this.stopController.signal).then(resolve, resolve);
    });
    this.wake = null;
  }
}
