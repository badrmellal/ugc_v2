/**
 * Mock Gemini clients for GEMINI_MOCK=true (demos, tests, CI). No network calls: videos are
 * synthesized locally with ffmpeg through `MediaTools.synthesizeClip`, the splitter answer is derived
 * deterministically from the script. Usage numbers follow the real token rates so cost accounting is
 * exercised end to end.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import {
  VideoModelError,
  type InteractionState,
  type InteractionStatus,
  type MediaTools,
  type OutputVideoRef,
  type TextModelClient,
  type UploadedFileRef,
  type UsageInfo,
  type VideoModelClient,
  type VideoModelErrorInfo,
  type VideoTurnRequest,
} from '../core/ports.js';
import { normalizeUsage } from '../pricing/pricing.js';
import { DEFAULT_SETTINGS, SEGMENT_SECONDS, type GenerationSettings, type Resolution } from '../shared/api.js';
import { fallbackPlan } from '../script/fallback.js';
import { extractScriptFromPlannerPrompt } from '../script/planner.js';

export const MOCK_FILE_SCHEME = 'mock-file://';
const MOCK_FILE_TTL_MS = 47 * 60 * 60 * 1000;
const RECORD_TTL_MS = 6 * 60 * 60 * 1000;
const MOCK_THOUGHT_TOKENS = 320;

const MOCK_SIZE: Record<Resolution, [number, number]> = {
  '360p': [360, 640],
  '720p': [720, 1280],
  // Upscaled resolutions are rendered at 720p in mock mode to keep ffmpeg fast.
  '1080p': [720, 1280],
  '4k': [720, 1280],
};

interface MockInteraction {
  id: string;
  req: VideoTurnRequest;
  createdAt: number;
  status: InteractionStatus;
  videoFile: string | null;
  durationSec: number;
  usage: UsageInfo | null;
  error: VideoModelErrorInfo | null;
  failWith: VideoModelErrorInfo | null;
  render: Promise<void> | null;
}

export interface MockVideoClientOptions {
  config: AppConfig;
  logger: Logger;
  media: MediaTools;
  /** Directory for uploaded images and rendered clips (a fresh temp dir by default). */
  workDir?: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** The next `startTurn` throws this error (failure injection for tests). */
  failNextTurn?: Error | null;
  /** The next started turn finishes as `failed` with this error. */
  failNextCompletion?: VideoModelErrorInfo | null;
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

export class MockVideoClient implements VideoModelClient {
  readonly model: string;
  readonly isMock = true;
  private readonly config: AppConfig;
  private readonly media: MediaTools;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly interactions = new Map<string, MockInteraction>();
  /** Uploaded image files and when they were written, pruned after the Files API TTL. */
  private readonly uploads = new Map<string, number>();
  private dirPromise: Promise<string> | null = null;
  private readonly fixedDir: string | null;
  private failNextTurn: Error | null;
  private failNextCompletion: VideoModelErrorInfo | null;

  constructor(opts: MockVideoClientOptions) {
    this.config = opts.config;
    this.model = opts.config.gemini.videoModel;
    this.media = opts.media;
    this.log = opts.logger.child({ component: 'gemini-mock' });
    this.now = opts.now ?? (() => Date.now());
    this.fixedDir = opts.workDir ?? null;
    this.failNextTurn = opts.failNextTurn ?? null;
    this.failNextCompletion = opts.failNextCompletion ?? null;
  }

  /** Makes the next `startTurn` throw `err`. */
  failNextTurnWith(err: Error): void {
    this.failNextTurn = err;
  }

  /** Makes the next started turn end as `failed` with `error`. */
  failNextCompletionWith(error: VideoModelErrorInfo): void {
    this.failNextCompletion = error;
  }

  private dir(): Promise<string> {
    this.dirPromise ??= this.fixedDir
      ? mkdir(this.fixedDir, { recursive: true }).then(() => this.fixedDir as string)
      : mkdtemp(join(tmpdir(), 'omni-mock-'));
    return this.dirPromise;
  }

  /** Deletes the mock work directory. */
  async dispose(): Promise<void> {
    if (!this.dirPromise) return;
    const dir = await this.dirPromise;
    this.interactions.clear();
    await rm(dir, { recursive: true, force: true });
  }

  async uploadImage(input: { data: Buffer; mimeType: string; displayName: string }): Promise<UploadedFileRef> {
    const dir = await this.dir();
    const name = `upload-${randomUUID()}.${extensionFor(input.mimeType)}`;
    await writeFile(join(dir, name), input.data);
    this.uploads.set(name, this.now());
    return {
      uri: `${MOCK_FILE_SCHEME}${name}`,
      mimeType: input.mimeType,
      name: `files/${name}`,
      expiresAt: new Date(this.now() + MOCK_FILE_TTL_MS),
    };
  }

  async startTurn(req: VideoTurnRequest): Promise<InteractionState> {
    if (this.failNextTurn) {
      const err = this.failNextTurn;
      this.failNextTurn = null;
      throw err;
    }
    if (req.kind === 'initial' && !req.image) {
      throw new VideoModelError('invalid_request', 'Part 1 needs the uploaded character image.', { retryable: false });
    }
    if (req.kind === 'extension' && !req.previousInteractionId) {
      throw new VideoModelError('invalid_request', 'The extension turn needs the part 1 interaction id.', {
        retryable: false,
      });
    }
    await this.prune();
    const id = `mock_${randomUUID()}`;
    this.interactions.set(id, {
      id,
      req,
      createdAt: this.now(),
      status: 'in_progress',
      videoFile: null,
      durationSec: 0,
      usage: null,
      error: null,
      failWith: this.failNextCompletion,
      render: null,
    });
    this.failNextCompletion = null;
    this.log.info({ generationId: req.generationId, kind: req.kind, interactionId: id }, 'mock turn started');
    return { id, status: 'in_progress', video: null, usage: null, error: null };
  }

  async getInteraction(id: string): Promise<InteractionState> {
    const rec = this.interactions.get(id);
    if (!rec) {
      throw new VideoModelError('not_found', `The Gemini interaction was not found: ${id}`, {
        retryable: false,
        status: 404,
      });
    }
    if (rec.status === 'in_progress' && this.now() - rec.createdAt >= this.config.gemini.mockTurnSeconds * 1000) {
      await this.complete(rec);
    }
    return this.state(rec);
  }

  private state(rec: MockInteraction): InteractionState {
    const video: OutputVideoRef | null =
      rec.status === 'completed' && rec.videoFile
        ? { uri: `${MOCK_FILE_SCHEME}${rec.videoFile}`, mimeType: 'video/mp4', inlineData: null }
        : null;
    return { id: rec.id, status: rec.status, video, usage: rec.usage, error: rec.error };
  }

  private async complete(rec: MockInteraction): Promise<void> {
    rec.render ??= this.render(rec).then(
      () => undefined,
      (err: unknown) => {
        rec.status = 'failed';
        rec.error = {
          code: 'mock_render_failed',
          message: `Mock video rendering failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        };
      },
    );
    await rec.render;
  }

  private async render(rec: MockInteraction): Promise<void> {
    if (rec.failWith) {
      rec.status = 'failed';
      rec.error = rec.failWith;
      return;
    }
    const dir = await this.dir();
    const { req } = rec;
    const [width, height] = MOCK_SIZE[req.resolution] ?? MOCK_SIZE['720p'];
    const seconds = Math.min(10, Math.max(3, Math.round(req.durationSec || SEGMENT_SECONDS)));
    const imagePath = this.localImage(dir, req);

    if (req.kind === 'initial') {
      const file = `${rec.id}.mp4`;
      await this.media.synthesizeClip({
        output: join(dir, file),
        durationSec: seconds,
        width,
        height,
        label: 'Mock part 1 0-10s',
        imagePath,
      });
      rec.videoFile = file;
      rec.durationSec = seconds;
    } else {
      const partFile = `${rec.id}-new.mp4`;
      await this.media.synthesizeClip({
        output: join(dir, partFile),
        durationSec: seconds,
        width,
        height,
        label: 'Mock part 2 10-20s',
        imagePath,
      });
      if (this.config.gemini.mockExtensionReturnsFull) {
        // Like Omni: the extension returns the previous clip plus the new seconds as one video.
        const previous = await this.previousClip(dir, req, width, height, imagePath);
        const file = `${rec.id}.mp4`;
        try {
          await this.media.concat([join(dir, previous.file), join(dir, partFile)], join(dir, file));
        } finally {
          await rm(join(dir, partFile), { force: true });
          if (previous.standIn) await rm(join(dir, previous.file), { force: true });
        }
        rec.videoFile = file;
        rec.durationSec = previous.durationSec + seconds;
      } else {
        rec.videoFile = partFile;
        rec.durationSec = seconds;
      }
    }
    rec.usage = this.fakeUsage(req, req.kind === 'extension' ? seconds : rec.durationSec, rec.durationSec);
    rec.status = 'completed';
    this.log.info({ interactionId: rec.id, durationSec: rec.durationSec }, 'mock turn completed');
  }

  /** Video of the previous turn; after a restart (unknown id) a stand-in 10s clip is synthesized. */
  private async previousClip(
    dir: string,
    req: VideoTurnRequest,
    width: number,
    height: number,
    imagePath: string | null,
  ): Promise<{ file: string; durationSec: number; standIn: boolean }> {
    const prev = req.previousInteractionId ? this.interactions.get(req.previousInteractionId) : undefined;
    if (prev && prev.status === 'in_progress') await this.complete(prev);
    if (prev?.videoFile && existsSync(join(dir, prev.videoFile))) {
      return { file: prev.videoFile, durationSec: prev.durationSec, standIn: false };
    }
    const file = `standin-${randomUUID()}.mp4`;
    await this.media.synthesizeClip({
      output: join(dir, file),
      durationSec: SEGMENT_SECONDS,
      width,
      height,
      label: 'Mock part 1 stand-in',
      imagePath,
    });
    return { file, durationSec: SEGMENT_SECONDS, standIn: true };
  }

  private localImage(dir: string, req: VideoTurnRequest): string | null {
    const uri = req.image?.uri;
    if (!uri || !uri.startsWith(MOCK_FILE_SCHEME)) return null;
    const name = uri.slice(MOCK_FILE_SCHEME.length);
    if (!/^[\w.-]+$/.test(name)) return null;
    const path = join(dir, name);
    return existsSync(path) ? path : null;
  }

  /**
   * Usage in the shape the Interactions API reports. The extension is billed like the configured
   * `EXTENSION_BILLING`: the new seconds only (the previous clip counts as input context), or the
   * whole returned clip.
   */
  private fakeUsage(req: VideoTurnRequest, newSeconds: number, returnedSeconds: number): UsageInfo | null {
    const pricing = this.config.pricing;
    const tps = pricing.videoTokensPerSecond[req.resolution];
    const promptTokens = Math.ceil(req.prompt.length / 4);
    const imageTokens = req.image ? pricing.imageInputTokens : 0;
    const videoIn = req.kind === 'extension' ? SEGMENT_SECONDS * pricing.videoInputTokensPerSecond : 0;
    const billedSeconds =
      req.kind === 'extension' && pricing.extensionBilling === 'full_output' ? returnedSeconds : newSeconds;
    const videoOut = Math.round(billedSeconds * tps);
    const input = promptTokens + imageTokens + videoIn;
    const inputByModality = [
      { modality: 'text', tokens: promptTokens },
      ...(imageTokens ? [{ modality: 'image', tokens: imageTokens }] : []),
      ...(videoIn ? [{ modality: 'video', tokens: videoIn }] : []),
    ];
    return normalizeUsage({
      total_input_tokens: input,
      total_output_tokens: videoOut,
      total_thought_tokens: MOCK_THOUGHT_TOKENS,
      total_tokens: input + videoOut + MOCK_THOUGHT_TOKENS,
      input_tokens_by_modality: inputByModality,
      output_tokens_by_modality: [{ modality: 'video', tokens: videoOut }],
      mock: true,
    });
  }

  async cancel(id: string): Promise<void> {
    const rec = this.interactions.get(id);
    if (rec && rec.status === 'in_progress' && !rec.render) {
      rec.status = 'cancelled';
      this.log.info({ interactionId: id }, 'mock turn cancelled');
    }
  }

  async downloadVideo(video: OutputVideoRef, destPath: string): Promise<void> {
    if (video.inlineData) {
      await writeFile(destPath, Buffer.from(video.inlineData, 'base64'));
      return;
    }
    const uri = video.uri ?? '';
    const name = uri.startsWith(MOCK_FILE_SCHEME) ? uri.slice(MOCK_FILE_SCHEME.length) : '';
    const dir = await this.dir();
    if (!name || !/^[\w.-]+$/.test(name) || !existsSync(join(dir, name))) {
      throw new VideoModelError('output_not_found', 'The mock video file no longer exists.', { retryable: true });
    }
    await copyFile(join(dir, name), destPath);
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - RECORD_TTL_MS;
    const dir = this.dirPromise ? await this.dirPromise : null;
    for (const [id, rec] of this.interactions) {
      if (rec.createdAt >= cutoff || rec.status === 'in_progress') continue;
      this.interactions.delete(id);
      if (dir && rec.videoFile) await rm(join(dir, rec.videoFile), { force: true }).catch(() => undefined);
    }
    const uploadCutoff = this.now() - MOCK_FILE_TTL_MS;
    for (const [name, at] of this.uploads) {
      if (at >= uploadCutoff) continue;
      this.uploads.delete(name);
      if (dir) await rm(join(dir, name), { force: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Text model
// ---------------------------------------------------------------------------

type GenerateJsonInput = Parameters<TextModelClient['generateJson']>[0];

export interface MockTextClientOptions {
  config?: AppConfig;
  /** Overrides the answer (failure injection): return any JSON value or throw. */
  respond?: (input: GenerateJsonInput) => unknown;
  /** Simulated latency in milliseconds. */
  delayMs?: number;
}

function settingsFromPrompt(prompt: string): GenerationSettings {
  const style = /^Style: (ugc|scientific)\b/m.exec(prompt)?.[1];
  const language = /^Spoken language: .*\(([^)]+)\)\s*$/m.exec(prompt)?.[1];
  const voice = /^Voice direction from the user: (.*)$/m.exec(prompt)?.[1];
  return {
    ...DEFAULT_SETTINGS,
    style: style === 'scientific' ? 'scientific' : 'ugc',
    language: language ?? 'en',
    voiceHint: voice && voice !== 'none' ? voice : '',
  };
}

/** Deterministic splitter answer in the LLM schema, derived from the script inside the prompt. */
export function mockSplitAnswer(prompt: string): Record<string, unknown> {
  const script = extractScriptFromPlannerPrompt(prompt) ?? prompt;
  const settings = settingsFromPrompt(prompt);
  const plan = fallbackPlan(script, settings);
  const seg = (i: 0 | 1) => ({
    dialogue: plan.segments[i].dialogue,
    action:
      plan.segments[i].action || (i === 0 ? 'talks to the camera with natural gestures' : 'keeps talking and smiles'),
    camera: plan.segments[i].camera,
    onScreenText: plan.segments[i].onScreenText,
  });
  return {
    character: plan.character,
    setting: plan.setting,
    voice: plan.voice,
    audio: plan.audio,
    part1: seg(0),
    part2: seg(1),
    warnings: [],
  };
}

export class MockTextClient implements TextModelClient {
  readonly model: string;
  private readonly respond: MockTextClientOptions['respond'];
  private readonly delayMs: number;

  constructor(opts: MockTextClientOptions = {}) {
    this.model = opts.config?.gemini.splitterModel ?? 'mock-text-model';
    this.respond = opts.respond;
    this.delayMs = opts.delayMs ?? 0;
  }

  async generateJson(input: GenerateJsonInput): Promise<{ data: unknown; usage: UsageInfo | null }> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const data = this.respond ? await this.respond(input) : mockSplitAnswer(input.prompt);
    const inputTokens = Math.ceil((input.systemInstruction.length + input.prompt.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(data ?? null).length / 4);
    const usage = normalizeUsage({
      total_input_tokens: inputTokens,
      total_output_tokens: outputTokens,
      total_thought_tokens: 0,
      total_tokens: inputTokens + outputTokens,
      output_tokens_by_modality: [{ modality: 'text', tokens: outputTokens }],
      input_tokens_by_modality: [{ modality: 'text', tokens: inputTokens }],
      mock: true,
    });
    return { data, usage };
  }
}
