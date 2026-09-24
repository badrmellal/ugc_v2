import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  VideoModelError,
  type InteractionState,
  type OutputVideoRef,
  type ScriptPlanner,
  type UploadedFileRef,
  type VideoModelClient,
  type VideoTurnRequest,
} from '../src/core/ports.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { GenerationRepository } from '../src/db/repository.js';
import { CaptionRenderer } from '../src/captions/index.js';
import { FfmpegMediaTools } from '../src/media/ffmpeg.js';
import { GenerationPipeline, type JobContext } from '../src/pipeline/runner.js';
import { LeaseLostError } from '../src/pipeline/errors.js';
import { Worker } from '../src/pipeline/worker.js';
import { estimateCost } from '../src/pricing/pricing.js';
import { DEFAULT_SETTINGS, type ScriptPlan } from '../src/shared/api.js';
import { generationKeys } from '../src/storage/index.js';
import { LocalStorage } from '../src/storage/local.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/omni_ugc_test';
const logger = pino({ level: 'silent' });
const media = new FfmpegMediaTools();

type TurnScript = {
  /** Status sequence returned by successive getInteraction calls; last entry repeats. */
  statuses?: InteractionState['status'][];
  /** Seconds of video returned when completed. */
  outputSeconds?: number;
  /** Return a completed state without any video. */
  emptyOutput?: boolean;
  /** Throw from startTurn. */
  startError?: VideoModelError;
  error?: InteractionState['error'];
};

/** Scriptable fake of the Omni client that renders real (tiny) MP4s with ffmpeg. */
class FakeVideoClient implements VideoModelClient {
  readonly model = 'fake-omni';
  readonly isMock = true;
  readonly started: VideoTurnRequest[] = [];
  readonly polled: string[] = [];
  readonly canceled: string[] = [];
  uploads = 0;
  private readonly interactions = new Map<string, { req: VideoTurnRequest; script: TurnScript; polls: number }>();
  private readonly scripts: TurnScript[] = [];

  constructor(private readonly dir: string) {}

  queue(...scripts: TurnScript[]): void {
    this.scripts.push(...scripts);
  }

  async uploadImage(): Promise<UploadedFileRef> {
    this.uploads += 1;
    return {
      uri: 'fake://image',
      mimeType: 'image/jpeg',
      name: 'files/fake',
      expiresAt: new Date(Date.now() + 47 * 3600e3),
    };
  }

  async startTurn(req: VideoTurnRequest): Promise<InteractionState> {
    const script = this.scripts.shift() ?? {};
    if (script.startError) throw script.startError;
    const id = `fake_${randomUUID()}`;
    this.started.push(req);
    this.interactions.set(id, { req, script, polls: 0 });
    return { id, status: 'in_progress', video: null, usage: null, error: null };
  }

  async getInteraction(id: string): Promise<InteractionState> {
    this.polled.push(id);
    const entry = this.interactions.get(id);
    if (!entry) throw new VideoModelError('not_found', 'unknown interaction', { retryable: false });
    const statuses = entry.script.statuses ?? ['completed'];
    const status = statuses[Math.min(entry.polls, statuses.length - 1)]!;
    entry.polls += 1;
    if (status !== 'completed') {
      return {
        id,
        status,
        video: null,
        usage: null,
        error: status === 'in_progress' ? null : (entry.script.error ?? null),
      };
    }
    if (entry.script.emptyOutput) return { id, status, video: null, usage: { outputTokens: 0 }, error: null };
    const seconds = entry.script.outputSeconds ?? (entry.req.kind === 'initial' ? 2 : 4);
    const file = join(this.dir, `${id}.mp4`);
    await media.synthesizeClip({ output: file, durationSec: seconds, width: 180, height: 320, label: id });
    return {
      id,
      status,
      video: { uri: file, mimeType: 'video/mp4' },
      usage: { outputTokens: seconds * 5792, videoOutputTokens: seconds * 5792, inputTokens: 1500 },
      error: null,
    };
  }

  async cancel(id: string): Promise<void> {
    this.canceled.push(id);
  }

  async downloadVideo(video: OutputVideoRef, destPath: string): Promise<void> {
    await copyFile(video.uri!, destPath);
  }
}

function makePlan(): ScriptPlan {
  const seg = (index: 1 | 2) => ({
    index,
    startSec: index === 1 ? 0 : 10,
    endSec: index === 1 ? 10 : 20,
    dialogue: `Line ${index}`,
    action: 'talks',
    camera: 'selfie',
    onScreenText: '',
    prompt: index === 1 ? 'part one prompt <IMAGE_REF_0>' : 'Extend this video. part two prompt',
  });
  return {
    source: 'user',
    character: 'c',
    setting: 's',
    voice: 'v',
    audio: 'a',
    language: 'en',
    segments: [seg(1), seg(2)],
    warnings: [],
    estimatedSpokenSeconds: 2,
  };
}

const fakePlanner: ScriptPlanner = {
  async split() {
    return { plan: { ...makePlan(), source: 'llm' }, usage: null, costUsd: 0.002, model: 'fake-text' };
  },
  finalize(plan) {
    return plan;
  },
};

describe('generation pipeline', () => {
  let db: Db;
  let repo: GenerationRepository;
  let config: AppConfig;
  let dir: string;
  let storage: LocalStorage;
  let video: FakeVideoClient;
  let pipeline: GenerationPipeline;

  beforeAll(async () => {
    config = loadConfig({
      NODE_ENV: 'test',
      GEMINI_MOCK: 'true',
      DATABASE_URL,
      GEMINI_POLL_INTERVAL_SEC: '0.01',
      JOB_MAX_ATTEMPTS: '2',
    });
    db = createPool(config);
    await runMigrations(db);
    repo = new GenerationRepository(db);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE generations, generation_events, api_calls CASCADE');
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), 'omni-pipeline-test-'));
    storage = new LocalStorage(join(dir, 'storage'));
    video = new FakeVideoClient(dir);
    pipeline = new GenerationPipeline({
      config,
      repo,
      video,
      planner: fakePlanner,
      storage,
      media,
      logger,
      workRoot: dir,
      sleep: async () => undefined,
    });
  });

  async function createJob(overrides: { plan?: ScriptPlan | null } = {}) {
    const id = randomUUID();
    const keys = generationKeys(id);
    const img = join(dir, `${id}.png`);
    await media.synthesizeClip({
      output: join(dir, `${id}-src.mp4`),
      durationSec: 1,
      width: 64,
      height: 64,
      label: 'x',
    });
    await media.thumbnail(join(dir, `${id}-src.mp4`), img, 0);
    await storage.putFile(keys.characterImage, img, 'image/jpeg');
    return repo.insert({
      id,
      createdBy: 'test',
      title: 'Test video',
      script: 'Line 1. Line 2.',
      settings: { ...DEFAULT_SETTINGS },
      plan: overrides.plan === undefined ? null : overrides.plan,
      characterImageKey: keys.characterImage,
      characterImageMime: 'image/jpeg',
      characterImageSha256: 'x',
      estimatedCost: estimateCost(config.pricing, { resolution: '720p' }),
      parentId: null,
      regenerationMode: null,
      maxAttempts: config.worker.maxAttempts,
    });
  }

  async function claim() {
    const job = await repo.claimNext('w1', 60_000);
    expect(job).not.toBeNull();
    return job!;
  }

  function ctx(overrides: Partial<JobContext> = {}): JobContext {
    return { workerId: 'w1', signal: new AbortController().signal, cancelRequested: () => false, ...overrides };
  }

  it('splits, generates part 1, extends, and uses the full 20s output as the final video', async () => {
    const job = await createJob();
    video.queue({ outputSeconds: 2 }, { statuses: ['in_progress', 'in_progress', 'completed'], outputSeconds: 4 });
    await pipeline.run(await claim(), ctx());

    const g = (await repo.get(job.id))!;
    expect(g.status).toBe('succeeded');
    expect(g.stage).toBe('completed');
    expect(g.progress).toBe(100);
    expect(g.plan?.source).toBe('llm');
    expect(g.assembly).toBe('model_full');
    expect(g.durationSec).toBeGreaterThan(3.5);
    expect(g.finalVideoKey).toBe(generationKeys(job.id).final);
    expect(await storage.stat(g.thumbnailKey!)).not.toBeNull();
    expect(g.lockedBy).toBeNull();
    expect(g.actualCost?.totalUsd).toBeGreaterThan(0);

    expect(video.started).toHaveLength(2);
    const [turn1, turn2] = video.started;
    expect(turn1!.kind).toBe('initial');
    expect(turn1!.image?.uri).toBe('fake://image');
    expect(turn1!.aspectRatio).toBe('9:16');
    expect(turn2!.kind).toBe('extension');
    expect(turn2!.previousInteractionId).toBe(g.part1InteractionId);
    expect(turn2!.image).toBeNull();
    expect(video.uploads).toBe(1);

    const events = await repo.listEvents(job.id);
    expect(events.map((e) => e.message).join('\n')).toContain('Video ready');
    const ledger = await repo.ledgerCostsForGeneration(job.id);
    expect(ledger.split).toBeCloseTo(0.002);
    expect(ledger.part1).toBeGreaterThan(0);
    expect(ledger.part2).toBeGreaterThan(0);
  });

  it('stitches part 1 and part 2 when the extension returns only the new segment', async () => {
    const job = await createJob({ plan: makePlan() });
    // Extension returns only 2s instead of the combined 4s clip.
    video.queue({ outputSeconds: 2 }, { outputSeconds: 2 });
    await pipeline.run(await claim(), ctx());
    const g = (await repo.get(job.id))!;
    expect(g.status).toBe('succeeded');
    expect(g.assembly).toBe('concatenated');
    expect(g.durationSec).toBeGreaterThan(3.5);
    expect(g.plan?.source).toBe('user');
  });

  it('resumes an in-flight interaction after a crash instead of paying for a new one', async () => {
    const job = await createJob({ plan: makePlan() });
    video.queue({ statuses: ['in_progress', 'in_progress', 'in_progress', 'completed'] }, {});

    // First run: the worker is "killed" (lease lost) while part 1 is still generating.
    const controller = new AbortController();
    let polls = 0;
    const crashing = new GenerationPipeline({
      config,
      repo,
      video,
      planner: fakePlanner,
      storage,
      media,
      logger,
      workRoot: dir,
      sleep: async () => {
        polls += 1;
        if (polls === 2) controller.abort(new LeaseLostError());
      },
    });
    await crashing.run(await claim(), ctx({ signal: controller.signal }));
    const mid = (await repo.get(job.id))!;
    expect(mid.status).toBe('running');
    expect(mid.part1InteractionId).toBeTruthy();
    expect(video.started).toHaveLength(1);

    // Lease expires, another worker claims and resumes.
    await db.query(`UPDATE generations SET locked_until = now() - interval '1 second' WHERE id = $1`, [job.id]);
    const resumed = await repo.claimNext('w2', 60_000);
    expect(resumed?.id).toBe(job.id);
    expect(resumed?.attempts).toBe(1);
    await pipeline.run(resumed!, ctx({ workerId: 'w2' }));

    const g = (await repo.get(job.id))!;
    expect(g.status).toBe('succeeded');
    expect(g.part1Attempts).toBe(1);
    // Only one part 1 creation in total: the resumed worker polled the existing interaction.
    expect(video.started.filter((r) => r.kind === 'initial')).toHaveLength(1);
    expect(video.polled).toContain(mid.part1InteractionId);
  });

  it('requeues retryable failures with backoff and fails after max attempts', async () => {
    const job = await createJob({ plan: makePlan() });
    const rateLimited = new VideoModelError('rate_limited', 'Too many requests', { retryable: true, status: 429 });
    video.queue({ startError: rateLimited }, { startError: rateLimited });

    await pipeline.run(await claim(), ctx());
    let g = (await repo.get(job.id))!;
    expect(g.status).toBe('queued');
    expect(g.error?.code).toBe('rate_limited');
    expect(g.runAfter.getTime()).toBeGreaterThan(Date.now() + 10_000);

    await db.query(`UPDATE generations SET run_after = now() WHERE id = $1`, [job.id]);
    await pipeline.run(await claim(), ctx());
    g = (await repo.get(job.id))!;
    expect(g.status).toBe('failed');
    expect(g.error?.code).toBe('rate_limited');
    expect(g.completedAt).not.toBeNull();
  });

  it('fails fast without retry when Gemini returns no video (safety block)', async () => {
    const job = await createJob({ plan: makePlan() });
    video.queue({ emptyOutput: true });
    await pipeline.run(await claim(), ctx());
    const g = (await repo.get(job.id))!;
    expect(g.status).toBe('failed');
    expect(g.error?.code).toBe('empty_output');
    expect(g.error?.retryable).toBe(false);
    expect(video.started).toHaveLength(1);
  });

  it('fails the turn with the upstream error when the interaction fails', async () => {
    const job = await createJob({ plan: makePlan() });
    video.queue({
      statuses: ['in_progress', 'failed'],
      error: { code: 'safety_blocked', message: 'Blocked by policy', retryable: false },
    });
    await pipeline.run(await claim(), ctx());
    const g = (await repo.get(job.id))!;
    expect(g.status).toBe('failed');
    expect(g.error?.code).toBe('safety_blocked');
    expect(g.part1Status).toBe('failed');
  });

  it('cancels a running job at the next checkpoint and cancels the in-flight interaction', async () => {
    const job = await createJob({ plan: makePlan() });
    video.queue({ statuses: ['in_progress'] });
    let cancel = false;
    let sleeps = 0;
    const p = new GenerationPipeline({
      config,
      repo,
      video,
      planner: fakePlanner,
      storage,
      media,
      logger,
      workRoot: dir,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) cancel = true;
      },
    });
    await p.run(await claim(), ctx({ cancelRequested: () => cancel }));
    const g = (await repo.get(job.id))!;
    expect(g.status).toBe('canceled');
    expect(g.stage).toBe('canceled');
    expect(video.canceled).toEqual([g.part1InteractionId]);
  });

  it('part-2 regeneration reuses the source part 1 interaction and only runs the extension', async () => {
    const source = await createJob({ plan: makePlan() });
    video.queue({ outputSeconds: 2 }, { outputSeconds: 4 });
    await pipeline.run(await claim(), ctx());
    const done = (await repo.get(source.id))!;
    expect(done.status).toBe('succeeded');

    const regen = await repo.insert({
      id: randomUUID(),
      createdBy: 'test',
      title: done.title,
      script: done.script,
      settings: done.settings,
      plan: done.plan,
      characterImageKey: done.characterImageKey,
      characterImageMime: done.characterImageMime,
      characterImageSha256: done.characterImageSha256,
      geminiFileUri: done.geminiFileUri,
      geminiFileMime: done.geminiFileMime,
      geminiFileExpiresAt: done.geminiFileExpiresAt,
      part1InteractionId: done.part1InteractionId,
      part1Status: 'completed',
      part1VideoKey: done.part1VideoKey,
      part1Usage: done.part1Usage,
      estimatedCost: estimateCost(config.pricing, { resolution: '720p', mode: 'part2' }),
      parentId: done.id,
      regenerationMode: 'part2',
      maxAttempts: 2,
    });
    video.queue({ outputSeconds: 4 });
    await pipeline.run(await claim(), ctx());
    const g = (await repo.get(regen.id))!;
    expect(g.status).toBe('succeeded');
    expect(video.started).toHaveLength(3);
    expect(video.started[2]!.previousInteractionId).toBe(done.part1InteractionId);
    expect(video.uploads).toBe(1);
    // Part 1 was paid by the source generation.
    expect(g.actualCost?.items.some((i) => i.label.startsWith('Part 1'))).toBe(false);
  });

  it('stops writing once the lease is lost to another worker', async () => {
    const job = await createJob({ plan: makePlan() });
    await claim();
    // Another worker steals the job (e.g. lease expired during a long GC pause).
    await db.query(`UPDATE generations SET locked_by = 'w-other' WHERE id = $1`, [job.id]);
    video.queue({});
    const stale = (await repo.get(job.id))!;
    await pipeline.run(stale, ctx());
    const g = (await repo.get(job.id))!;
    expect(g.lockedBy).toBe('w-other');
    expect(g.status).toBe('running');
    expect(g.part1InteractionId).toBeNull();
  });

  it('burns captions into the final video and keeps a clean copy', async () => {
    const job = await createJob({ plan: makePlan() });
    video.queue({ outputSeconds: 2 }, { outputSeconds: 4 });
    const withCaptions = new GenerationPipeline({
      config,
      repo,
      video,
      planner: fakePlanner,
      storage,
      media,
      logger,
      workRoot: dir,
      sleep: async () => undefined,
      captions: new CaptionRenderer({ media, logger, pythonPath: null }),
    });
    await withCaptions.run(await claim(), ctx());
    const g = (await repo.get(job.id))!;
    expect(g.status).toBe('succeeded');
    expect(g.finalCleanKey).toBe(generationKeys(job.id).finalClean);
    expect(g.captionEngine).toBe('estimate');
    const [captioned, clean] = await Promise.all([storage.stat(g.finalVideoKey!), storage.stat(g.finalCleanKey!)]);
    expect(captioned!.size).toBeGreaterThan(0);
    expect(clean!.size).toBeGreaterThan(0);
    expect((await repo.listEvents(job.id)).map((e) => e.message).join('\n')).toContain('Captions added');
  });

  it('skips captions when the setting is off', async () => {
    const job = await createJob({ plan: makePlan() });
    await db.query(`UPDATE generations SET settings = settings || '{"captions": false}'::jsonb WHERE id = $1`, [
      job.id,
    ]);
    video.queue({ outputSeconds: 2 }, { outputSeconds: 4 });
    const withCaptions = new GenerationPipeline({
      config,
      repo,
      video,
      planner: fakePlanner,
      storage,
      media,
      logger,
      workRoot: dir,
      sleep: async () => undefined,
      captions: new CaptionRenderer({ media, logger, pythonPath: null }),
    });
    await withCaptions.run(await claim(), ctx());
    const g = (await repo.get(job.id))!;
    expect(g.status).toBe('succeeded');
    expect(g.finalCleanKey).toBeNull();
  });

  it('worker claims queued jobs and runs them to completion', async () => {
    const job = await createJob({ plan: makePlan() });
    video.queue({}, {});
    const worker = new Worker({ repo, pipeline, logger, concurrency: 1, pollIntervalMs: 20, leaseMs: 30_000 });
    worker.start();
    const deadline = Date.now() + 30_000;
    let g = (await repo.get(job.id))!;
    while (g.status !== 'succeeded' && g.status !== 'failed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      g = (await repo.get(job.id))!;
    }
    await worker.stop();
    expect(g.status).toBe('succeeded');
  });
});
