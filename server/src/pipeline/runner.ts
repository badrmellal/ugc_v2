import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import {
  VideoModelError,
  type GenerationPatch,
  type GenerationRecord,
  type InteractionState,
  type MediaTools,
  type ScriptPlanner,
  type StorageDriver,
  type UploadedFileRef,
  type VideoModelClient,
  type VideoTurnRequest,
} from '../core/ports.js';
import type { GenerationRepository } from '../db/repository.js';
import { unlimitedTurns, type TurnLimiter } from '../db/turn-limiter.js';
import { actualCost, estimateCost, turnCostFromUsage } from '../pricing/pricing.js';
import { SEGMENT_SECONDS, type GenerationStage } from '../shared/api.js';
import { generationKeys } from '../storage/index.js';
import {
  JobCanceledError,
  LeaseLostError,
  ShutdownError,
  StepError,
  redactSecrets,
  toGenerationError,
} from './errors.js';
import { STAGE_WINDOWS, progressWithinStage, type StageTimings } from './progress.js';

export interface PipelineDeps {
  config: AppConfig;
  repo: GenerationRepository;
  video: VideoModelClient;
  planner: ScriptPlanner;
  storage: StorageDriver;
  media: MediaTools;
  logger: Logger;
  /** Cluster-wide cap on concurrent Omni turns. Defaults to unlimited. */
  turnLimiter?: TurnLimiter;
  /** Parent directory for per-job scratch space. Defaults to the OS temp dir. */
  workRoot?: string;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Live state shared between the worker (heartbeat) and the pipeline run. */
export interface JobContext {
  workerId: string;
  /** Aborted on worker shutdown or lease loss; `reason` is a ShutdownError or LeaseLostError. */
  signal: AbortSignal;
  /** Set by the heartbeat when the user requested cancellation. */
  cancelRequested: () => boolean;
}

/** Minimum remaining validity of an uploaded Files API reference before it is re-uploaded. */
const FILE_REUSE_MARGIN_MS = 60 * 60 * 1000;
/** Files API objects expire after 48h; used when the API does not report an expiry. */
const DEFAULT_FILE_TTL_MS = 47 * 60 * 60 * 1000;
/** Polls tolerate this many consecutive transient errors before failing the step. */
const MAX_POLL_ERRORS = 6;
/**
 * The extension turn normally returns the whole clip (part 1 + continuation, about 2x part 1). An output
 * shorter than this multiple of part 1 is treated as the new segment only and gets stitched.
 */
const FULL_OUTPUT_MIN_RATIO = 1.5;

type TurnKind = 'part1' | 'part2';

/** Extra polls when a turn completes without a video before treating it as blocked. */
const EMPTY_OUTPUT_RECHECKS = 3;

function hasVideo(state: InteractionState): boolean {
  return Boolean(state.video && (state.video.uri || state.video.inlineData));
}

export class GenerationPipeline {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly timings: StageTimings;

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? abortableSleep;
    this.timings = {
      turnSeconds: deps.config.gemini.mock ? Math.max(deps.config.gemini.mockTurnSeconds, 1) : 120,
    };
  }

  /** Runs (or resumes) a claimed job to a terminal state, a requeue, or a lease release. */
  async run(job: GenerationRecord, ctx: JobContext): Promise<void> {
    const log = this.deps.logger.child({ generationId: job.id, worker: ctx.workerId });
    const workDir = await mkdtemp(join(this.deps.workRoot ?? tmpdir(), `omni-${job.id.slice(0, 8)}-`));
    const run = new JobRun(this.deps, job, ctx, log, workDir, this.timings, this.now, this.sleep);
    try {
      await run.execute();
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

class JobRun {
  private g: GenerationRecord;
  private readonly keys: ReturnType<typeof generationKeys>;
  private inFlightInteraction: string | null = null;

  constructor(
    private readonly deps: PipelineDeps,
    job: GenerationRecord,
    private readonly ctx: JobContext,
    private readonly log: Logger,
    private readonly workDir: string,
    private readonly timings: StageTimings,
    private readonly now: () => number,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  ) {
    this.g = job;
    this.keys = generationKeys(job.id);
  }

  async execute(): Promise<void> {
    try {
      this.throwIfStopped();
      await this.planStep();
      await this.part1Step();
      await this.part2Step();
      await this.finalizeStep();
    } catch (err) {
      await this.handleFailure(err);
    }
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  private async planStep(): Promise<void> {
    if (this.g.plan) return;
    await this.enterStage('planning');
    const result = await this.deps.planner.split({ script: this.g.script, settings: this.g.settings });
    await this.checkpoint({ plan: result.plan });
    await this.deps.repo.recordApiCall({
      generationId: this.g.id,
      kind: 'split',
      model: result.model ?? 'fallback',
      interactionId: null,
      status: 'completed',
      usage: result.usage,
      costUsd: result.costUsd,
      costBasis: result.usage ? 'actual' : 'estimate',
    });
    await this.event(
      'info',
      result.plan.source === 'llm'
        ? 'Script split into two 10s parts'
        : result.model
          ? 'The text model split did not keep the script verbatim, used the sentence-based split instead'
          : 'Script split with the sentence-based fallback (text model unavailable)',
    );
    for (const warning of result.plan.warnings) await this.event('warn', warning);
  }

  private async part1Step(): Promise<void> {
    if (this.g.part1VideoKey) return;
    const image = await this.ensureImage();
    await this.enterStage('generating_part1');
    const plan = this.requirePlan();
    const state = await this.runTurn('part1', {
      kind: 'initial',
      prompt: plan.segments[0].prompt,
      resolution: this.g.settings.resolution,
      durationSec: SEGMENT_SECONDS,
      aspectRatio: '9:16',
      image,
      imageMode: this.g.settings.imageMode,
      previousInteractionId: null,
      generationId: this.g.id,
    });
    const local = join(this.workDir, 'part1.mp4');
    await this.downloadOutput(state, local, 'part1');
    const info = await this.deps.storage.putFile(this.keys.part1, local, 'video/mp4');
    await this.checkpoint({ part1VideoKey: info.key, part1Status: 'completed', part1Usage: state.usage });
    await this.event('info', 'Part 1 (0-10s) generated');
  }

  private async part2Step(): Promise<void> {
    if (this.g.part2VideoKey) return;
    if (!this.g.part1InteractionId) {
      throw new StepError('missing_part1', 'Part 1 interaction is missing, cannot extend the video.', false);
    }
    const image = this.g.settings.reinforceCharacterOnExtend ? await this.ensureImage() : null;
    await this.enterStage('extending_part2');
    const plan = this.requirePlan();
    const state = await this.runTurn('part2', {
      kind: 'extension',
      prompt: plan.segments[1].prompt,
      resolution: this.g.settings.resolution,
      durationSec: SEGMENT_SECONDS,
      aspectRatio: '9:16',
      image,
      imageMode: 'reference',
      previousInteractionId: this.g.part1InteractionId,
      generationId: this.g.id,
    });
    const local = join(this.workDir, 'part2.mp4');
    await this.downloadOutput(state, local, 'part2');
    const info = await this.deps.storage.putFile(this.keys.part2, local, 'video/mp4');
    await this.checkpoint({ part2VideoKey: info.key, part2Status: 'completed', part2Usage: state.usage });
    await this.event('info', 'Extension (10-20s) generated');
  }

  private async finalizeStep(): Promise<void> {
    await this.enterStage('finalizing');
    const { media, storage } = this.deps;
    const part1 = join(this.workDir, 'final-part1.mp4');
    const part2 = join(this.workDir, 'final-part2.mp4');
    await storage.downloadToFile(this.g.part1VideoKey!, part1);
    await storage.downloadToFile(this.g.part2VideoKey!, part2);
    const [p1, p2] = await Promise.all([media.probe(part1), media.probe(part2)]);

    const finalLocal = join(this.workDir, 'final.mp4');
    let assembly: 'model_full' | 'concatenated';
    if (p2.durationSec >= p1.durationSec * FULL_OUTPUT_MIN_RATIO) {
      assembly = 'model_full';
      // Keep Google's original bytes (no remux) so embedded provenance metadata is preserved.
      await copyFile(part2, finalLocal);
    } else {
      assembly = 'concatenated';
      await this.event(
        'info',
        `Extension returned ${p2.durationSec.toFixed(1)}s, stitching part 1 and part 2 into one video`,
      );
      await media.concat([part1, part2], finalLocal);
    }
    this.throwIfStopped();
    const finalProbe = await media.probe(finalLocal);
    const thumbLocal = join(this.workDir, 'thumbnail.jpg');
    await media.thumbnail(finalLocal, thumbLocal, Math.min(1.5, finalProbe.durationSec / 2));
    const finalInfo = await storage.putFile(this.keys.final, finalLocal, 'video/mp4');
    const thumbInfo = await storage.putFile(this.keys.thumbnail, thumbLocal, 'image/jpeg');

    const cost = await this.computeActualCost();
    await this.checkpoint({
      status: 'succeeded',
      stage: 'completed',
      progress: 100,
      stageStartedAt: new Date(this.now()),
      completedAt: new Date(this.now()),
      finalVideoKey: finalInfo.key,
      thumbnailKey: thumbInfo.key,
      durationSec: Math.round(finalProbe.durationSec * 100) / 100,
      assembly,
      actualCost: cost,
      actualCostUsd: cost.totalUsd,
      error: null,
      lockedBy: null,
      lockedUntil: null,
    });
    await this.event(
      'info',
      `Video ready: ${finalProbe.durationSec.toFixed(1)}s ${finalProbe.width ?? '?'}x${finalProbe.height ?? '?'} (${assembly === 'model_full' ? 'returned whole by the model' : 'stitched'})`,
    );
    if (Math.abs(finalProbe.durationSec - 2 * SEGMENT_SECONDS) > 3) {
      await this.event('warn', `Final duration is ${finalProbe.durationSec.toFixed(1)}s instead of about 20s`);
    }
  }

  // -------------------------------------------------------------------------
  // Omni turns
  // -------------------------------------------------------------------------

  /** Runs one Omni turn while holding a cluster-wide turn slot. */
  private async runTurn(kind: TurnKind, req: VideoTurnRequest): Promise<InteractionState> {
    const limiter = this.deps.turnLimiter ?? unlimitedTurns;
    const waitStart = this.now();
    const acquire = limiter.acquire(this.ctx.signal);
    const slow = setTimeout(() => {
      void this.event('info', 'Waiting for a free Gemini slot (another video is generating)');
    }, 3000);
    let release: () => Promise<void>;
    try {
      release = await acquire;
    } finally {
      clearTimeout(slow);
    }
    const waitedMs = this.now() - waitStart;
    try {
      return await this.runTurnLocked(kind, req, waitedMs);
    } finally {
      await release();
    }
  }

  /** Creates (or resumes) one Omni turn and waits for a terminal state. */
  private async runTurnLocked(kind: TurnKind, req: VideoTurnRequest, waitedMs: number): Promise<InteractionState> {
    const { video, config } = this.deps;
    const idField = kind === 'part1' ? 'part1InteractionId' : 'part2InteractionId';
    const statusField = kind === 'part1' ? 'part1Status' : 'part2Status';
    const attemptsField = kind === 'part1' ? 'part1Attempts' : 'part2Attempts';

    let state: InteractionState | null = null;
    const existingId = this.g[idField];
    if (existingId && this.g[statusField] !== 'failed') {
      // Resume: a previous run already paid for this interaction, poll it instead of re-creating.
      await this.event('info', `Resuming ${kind === 'part1' ? 'part 1' : 'extension'} interaction`);
      try {
        state = await video.getInteraction(existingId);
      } catch (err) {
        if (err instanceof VideoModelError && (err.code === 'not_found' || err.code === 'interaction_lost')) {
          await this.event('warn', 'Previous interaction can no longer be retrieved, starting a new one');
          state = null;
        } else {
          throw err;
        }
      }
    }

    if (!state) {
      const used = this.g[attemptsField];
      if (used >= config.worker.maxAttempts) {
        throw new StepError(
          'attempts_exhausted',
          `${kind === 'part1' ? 'Part 1' : 'The extension'} failed after ${used} attempts.`,
          false,
        );
      }
      await this.checkpoint({ [attemptsField]: used + 1 } as GenerationPatch);
      this.throwIfStopped();
      state = await video.startTurn(req);
      this.inFlightInteraction = state.id;
      await this.checkpoint({ [idField]: state.id, [statusField]: state.status } as GenerationPatch);
      await this.deps.repo.recordApiCall({
        generationId: this.g.id,
        kind,
        model: video.model,
        interactionId: state.id,
        status: state.status,
        usage: state.usage,
        costUsd: this.turnEstimateUsd(kind),
        costBasis: 'estimate',
      });
    }
    this.inFlightInteraction = state.id;

    const stageStart = this.g.stageStartedAt?.getTime() ?? this.now();
    const deadline = stageStart + waitedMs + config.gemini.turnTimeoutMs;
    let pollErrors = 0;
    while (state.status === 'in_progress') {
      await this.sleep(config.gemini.pollIntervalMs, this.ctx.signal);
      this.throwIfStopped();
      if (this.now() > deadline) {
        await video.cancel(state.id).catch(() => undefined);
        await this.checkpoint({ [statusField]: 'failed' } as GenerationPatch);
        throw new StepError(
          'turn_timeout',
          `Gemini did not finish ${kind === 'part1' ? 'part 1' : 'the extension'} within ${Math.round(config.gemini.turnTimeoutMs / 60000)} minutes.`,
          true,
        );
      }
      try {
        state = await video.getInteraction(state.id);
        pollErrors = 0;
      } catch (err) {
        if (err instanceof VideoModelError && err.code === 'interaction_lost') {
          // The adapter cannot retrieve this interaction any more (e.g. transport switched): recreate it.
          await this.checkpoint({ [statusField]: 'failed' } as GenerationPatch);
          throw new StepError('interaction_lost', err.message, true, err);
        }
        pollErrors += 1;
        const retryable = !(err instanceof VideoModelError) || err.retryable;
        if (!retryable || pollErrors >= MAX_POLL_ERRORS) throw err;
        this.log.warn({ err: this.safeErr(err), pollErrors }, 'transient error while polling interaction');
      }
      await this.touchProgress();
    }
    // The output can lag behind the completed status: re-check a few times before failing.
    for (let i = 0; i < EMPTY_OUTPUT_RECHECKS && state.status === 'completed' && !hasVideo(state); i += 1) {
      await this.sleep(config.gemini.pollIntervalMs, this.ctx.signal);
      this.throwIfStopped();
      const current: InteractionState = state;
      state = await video.getInteraction(current.id).catch(() => current);
    }
    this.inFlightInteraction = null;

    const usageCost = turnCostFromUsage(this.deps.config.pricing, state.usage);
    await this.deps.repo.recordApiCall({
      generationId: this.g.id,
      kind,
      model: video.model,
      interactionId: state.id,
      status: state.status,
      usage: state.usage,
      costUsd: usageCost?.usd ?? (state.status === 'completed' ? this.turnEstimateUsd(kind) : 0),
      costBasis: usageCost ? 'actual' : 'estimate',
    });

    if (state.status === 'completed') {
      if (!hasVideo(state)) {
        await this.checkpoint({ [statusField]: 'failed' } as GenerationPatch);
        throw new StepError(
          'empty_output',
          'Gemini finished without returning a video. The request was most likely blocked by safety filters (for example a real person or unsafe content in the image or script), or video features are not available in your region.',
          false,
        );
      }
      await this.checkpoint({ [statusField]: 'completed' } as GenerationPatch);
      return state;
    }

    await this.checkpoint({ [statusField]: 'failed' } as GenerationPatch);
    const e = state.error;
    if (state.status === 'cancelled' && !e) {
      throw new StepError('interaction_cancelled', 'The Gemini interaction was cancelled.', true);
    }
    throw new StepError(
      e?.code ?? `interaction_${state.status}`,
      e?.message ?? `Gemini reported status "${state.status}" for ${kind === 'part1' ? 'part 1' : 'the extension'}.`,
      e?.retryable ?? state.status === 'incomplete',
    );
  }

  private async downloadOutput(state: InteractionState, dest: string, kind: TurnKind): Promise<void> {
    await this.deps.video.downloadVideo(state.video!, dest);
    const probe = await this.deps.media.probe(dest).catch((err: unknown) => {
      throw new StepError('invalid_output', `The ${kind} video returned by Gemini could not be read.`, true, err);
    });
    if (!(probe.durationSec > 0.5) || !probe.width) {
      throw new StepError('invalid_output', `The ${kind} video returned by Gemini is empty or corrupt.`, true);
    }
    this.log.info({ kind, probe }, 'downloaded turn output');
  }

  private async ensureImage(): Promise<UploadedFileRef> {
    const g = this.g;
    const validUntil = g.geminiFileExpiresAt?.getTime() ?? 0;
    if (g.geminiFileUri && g.geminiFileMime && validUntil - this.now() > FILE_REUSE_MARGIN_MS) {
      return { uri: g.geminiFileUri, mimeType: g.geminiFileMime, name: null, expiresAt: g.geminiFileExpiresAt };
    }
    await this.enterStage('uploading_image');
    const data = await this.deps.storage.getBuffer(g.characterImageKey);
    const ref = await this.deps.video.uploadImage({
      data,
      mimeType: g.characterImageMime,
      displayName: `character-${g.id}`,
    });
    const expiresAt = ref.expiresAt ?? new Date(this.now() + DEFAULT_FILE_TTL_MS);
    await this.checkpoint({ geminiFileUri: ref.uri, geminiFileMime: ref.mimeType, geminiFileExpiresAt: expiresAt });
    await this.event('info', 'Character image uploaded to Gemini');
    return { ...ref, expiresAt };
  }

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  private async handleFailure(err: unknown): Promise<void> {
    const reason = this.ctx.signal.aborted ? this.ctx.signal.reason : null;
    if (err instanceof LeaseLostError || reason instanceof LeaseLostError) {
      this.log.warn('lease lost, abandoning job to its new owner');
      return;
    }
    if (err instanceof ShutdownError || reason instanceof ShutdownError) {
      this.log.info('worker shutting down, releasing job for resume');
      await this.deps.repo.releaseLease(this.g.id, this.ctx.workerId).catch(() => undefined);
      return;
    }
    if (err instanceof JobCanceledError || this.ctx.cancelRequested()) {
      await this.finishCanceled();
      return;
    }

    const error = toGenerationError(err, [this.deps.config.gemini.apiKey]);
    this.log.error({ err: this.safeErr(err), error }, 'generation step failed');
    const canRetry = error.retryable && this.g.attempts < this.g.maxAttempts;
    try {
      if (canRetry) {
        const delayMs = Math.min(30_000 * 2 ** Math.max(this.g.attempts - 1, 0), 10 * 60_000);
        await this.event('warn', `${error.message} Retrying in ${Math.round(delayMs / 1000)}s.`);
        const requeued = await this.deps.repo.requeue(this.g.id, this.ctx.workerId, delayMs, {
          stage: 'queued',
          stageStartedAt: new Date(this.now()),
          error,
        });
        if (!requeued) this.log.warn('could not requeue, lease already lost');
        return;
      }
      const cost = await this.computeActualCost().catch(() => null);
      // Logged before the stage flips to `failed` so the event records where the job stopped.
      await this.event('error', error.message);
      await this.checkpoint({
        status: 'failed',
        stage: 'failed',
        completedAt: new Date(this.now()),
        stageStartedAt: new Date(this.now()),
        error,
        actualCost: cost,
        actualCostUsd: cost?.totalUsd ?? null,
        lockedBy: null,
        lockedUntil: null,
      });
    } catch (inner) {
      if (!(inner instanceof LeaseLostError)) {
        this.log.error({ err: this.safeErr(inner) }, 'failed to record job failure');
      }
    }
  }

  private async finishCanceled(): Promise<void> {
    if (this.inFlightInteraction) {
      await this.deps.video.cancel(this.inFlightInteraction).catch(() => undefined);
    }
    const cost = await this.computeActualCost().catch(() => null);
    try {
      await this.event('info', 'Generation canceled');
      await this.checkpoint({
        status: 'canceled',
        stage: 'canceled',
        completedAt: new Date(this.now()),
        stageStartedAt: new Date(this.now()),
        error: null,
        actualCost: cost,
        actualCostUsd: cost?.totalUsd ?? null,
        lockedBy: null,
        lockedUntil: null,
      });
    } catch (err) {
      if (!(err instanceof LeaseLostError)) throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requirePlan() {
    if (!this.g.plan) throw new StepError('missing_plan', 'The script has not been split yet.', true);
    return this.g.plan;
  }

  private throwIfStopped(): void {
    if (this.ctx.signal.aborted) {
      const reason: unknown = this.ctx.signal.reason;
      throw reason instanceof Error ? reason : new ShutdownError();
    }
    if (this.ctx.cancelRequested()) throw new JobCanceledError();
  }

  /** Persists a patch while still holding the lease; throws LeaseLostError when fenced out. */
  private async checkpoint(patch: GenerationPatch): Promise<void> {
    const updated = await this.deps.repo.update(this.g.id, patch, { lockedBy: this.ctx.workerId });
    if (!updated) throw new LeaseLostError();
    this.g = updated;
  }

  private async enterStage(stage: GenerationStage): Promise<void> {
    this.throwIfStopped();
    if (this.g.stage === stage && this.g.stageStartedAt) return;
    await this.checkpoint({ stage, stageStartedAt: new Date(this.now()), progress: STAGE_WINDOWS[stage][0] });
    this.log.info({ stage }, 'stage started');
  }

  private async touchProgress(): Promise<void> {
    const started = this.g.stageStartedAt?.getTime() ?? this.now();
    const progress = progressWithinStage(this.g.stage, (this.now() - started) / 1000, this.timings);
    if (progress > this.g.progress) await this.checkpoint({ progress });
  }

  private async event(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    await this.deps.repo
      .addEvent(this.g.id, this.g.stage, level, redactSecrets(message, [this.deps.config.gemini.apiKey]))
      .catch((err: unknown) => this.log.warn({ err: this.safeErr(err) }, 'failed to write event'));
  }

  private turnEstimateUsd(kind: TurnKind): number {
    const estimate = estimateCost(this.deps.config.pricing, {
      resolution: this.g.settings.resolution,
      mode: 'full',
      needsSplit: false,
      reinforceCharacterOnExtend: this.g.settings.reinforceCharacterOnExtend,
    });
    const prefix = kind === 'part1' ? 'Part 1' : 'Part 2';
    return estimate.items.filter((i) => i.label.startsWith(prefix)).reduce((s, i) => s + i.amountUsd, 0);
  }

  private async computeActualCost() {
    const spend = await this.splitCostUsd();
    const inherited = this.g.regenerationMode === 'part2';
    return actualCost(this.deps.config.pricing, {
      resolution: this.g.settings.resolution,
      splitCostUsd: spend,
      // Part 1 of a part-2 regeneration was paid for by the source generation.
      part1:
        inherited || !this.g.part1InteractionId
          ? null
          : { usage: this.g.part1Usage, completed: this.g.part1Status === 'completed' },
      part2: this.g.part2InteractionId
        ? { usage: this.g.part2Usage, completed: this.g.part2Status === 'completed' }
        : null,
    });
  }

  private async splitCostUsd(): Promise<number | null> {
    const ledger = await this.deps.repo.ledgerCostsForGeneration(this.g.id);
    return ledger.split > 0 ? ledger.split : null;
  }

  private safeErr(err: unknown): { name: string; message: string; code?: string } {
    const e = err instanceof Error ? err : new Error(String(err));
    const code = (e as { code?: unknown }).code;
    return {
      name: e.name,
      message: redactSecrets(e.message, [this.deps.config.gemini.apiKey]),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new ShutdownError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new ShutdownError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
