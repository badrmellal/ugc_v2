/**
 * Gemini Omni video adapter: Files API upload of the character image, Interactions API turns
 * (part 1 generation and part 2 extension chained with `previous_interaction_id`), polling,
 * cancellation and download of the output video.
 */
import { createWriteStream } from 'node:fs';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import {
  VideoModelError,
  type InteractionState,
  type InteractionStatus,
  type OutputVideoRef,
  type UploadedFileRef,
  type VideoModelClient,
  type VideoModelErrorInfo,
  type VideoTurnRequest,
} from '../core/ports.js';
import { redactSecrets } from '../pipeline/errors.js';
import { normalizeUsage } from '../pricing/pricing.js';
import type { Resolution } from '../shared/api.js';
import { classifyGeminiError, looksLikeSafetyBlock, SAFETY_HINT } from './errors.js';
import { createGenAi, currentTurnSteps, isRecord, type GenAiFile, type GenAiLike } from './genai.js';

export const GEMINI_FILES_HOST = 'generativelanguage.googleapis.com';
const FILES_DOWNLOAD_BASE = `https://${GEMINI_FILES_HOST}/v1beta/files`;
/** Uploaded files are kept for 48h; assume slightly less when the API does not say. */
const DEFAULT_FILE_TTL_MS = 47 * 60 * 60 * 1000;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Request building (pure)
// ---------------------------------------------------------------------------

export interface OmniImagePart {
  type: 'image';
  uri: string;
  mime_type: string;
}

export interface OmniTextPart {
  type: 'text';
  text: string;
}

export interface OmniVideoResponseFormat {
  type: 'video';
  aspect_ratio?: '9:16' | '16:9';
  duration?: string;
  resolution?: Resolution;
  delivery?: 'uri';
}

/** Body of `interactions.create` for one Omni turn. */
export interface OmniTurnParams {
  model: string;
  input: string | Array<OmniImagePart | OmniTextPart>;
  response_format: OmniVideoResponseFormat;
  previous_interaction_id?: string;
  background?: boolean;
}

export interface BuildTurnOptions {
  background: boolean;
  /** Send `duration` on the extension turn (always sent on the initial turn). */
  includeDuration: boolean;
  /** Send `resolution` on the extension turn (default true; always sent on the initial turn). */
  includeExtensionResolution?: boolean;
  /** Request `delivery: 'uri'` (default true). When false the API default (inline data) applies. */
  uriDelivery?: boolean;
}

function durationString(sec: number): string {
  const s = Math.min(10, Math.max(3, Math.round(Number.isFinite(sec) ? sec : 10)));
  return `${s}s`;
}

/**
 * Makes sure an attached image is bound by a tag: an untagged image is silently ignored by Omni.
 * Prompts built by `script/prompts.ts` already carry the tag, so this is only a safety net.
 */
export function ensureImageTag(prompt: string, kind: 'initial' | 'extension', imageMode: 'reference' | 'first_frame') {
  if (kind === 'initial' && imageMode === 'first_frame') {
    return prompt.includes('<FIRST_FRAME>') ? prompt : `<FIRST_FRAME> ${prompt}`;
  }
  if (prompt.includes('<IMAGE_REF_0>')) return prompt;
  return kind === 'initial'
    ? `${prompt}\nThe main character is the person in <IMAGE_REF_0>.`
    : `${prompt}\nThe person is the same person shown in <IMAGE_REF_0>.`;
}

/**
 * Builds the exact `interactions.create` body for a turn.
 * - initial: image part (Files API URI) + text, `aspect_ratio`, `duration`, `resolution`, `delivery: uri`.
 * - extension: `previous_interaction_id` + text (plus the image only when re-sent for identity), no
 *   `aspect_ratio` and never `generation_config.video_config.task` (it would forbid chaining).
 */
export function buildTurnRequest(req: VideoTurnRequest, model: string, opts: BuildTurnOptions): OmniTurnParams {
  const prompt = req.prompt.trim();
  if (!prompt) throw new VideoModelError('invalid_request', 'The prompt for this turn is empty.', { retryable: false });
  const delivery: Pick<OmniVideoResponseFormat, 'delivery'> = opts.uriDelivery === false ? {} : { delivery: 'uri' };

  if (req.kind === 'initial') {
    if (!req.image) {
      throw new VideoModelError('invalid_request', 'Part 1 needs the uploaded character image.', { retryable: false });
    }
    const params: OmniTurnParams = {
      model,
      input: [
        { type: 'image', uri: req.image.uri, mime_type: req.image.mimeType },
        { type: 'text', text: ensureImageTag(prompt, 'initial', req.imageMode) },
      ],
      response_format: {
        type: 'video',
        aspect_ratio: req.aspectRatio,
        duration: durationString(req.durationSec),
        resolution: req.resolution,
        ...delivery,
      },
    };
    if (opts.background) params.background = true;
    return params;
  }

  if (!req.previousInteractionId) {
    throw new VideoModelError('invalid_request', 'The extension turn needs the part 1 interaction id.', {
      retryable: false,
    });
  }
  const responseFormat: OmniVideoResponseFormat = { type: 'video', ...delivery };
  if (opts.includeExtensionResolution !== false) responseFormat.resolution = req.resolution;
  if (opts.includeDuration) responseFormat.duration = durationString(req.durationSec);
  const params: OmniTurnParams = {
    model,
    previous_interaction_id: req.previousInteractionId,
    input: req.image
      ? [
          { type: 'image', uri: req.image.uri, mime_type: req.image.mimeType },
          { type: 'text', text: ensureImageTag(prompt, 'extension', 'reference') },
        ]
      : prompt,
    response_format: responseFormat,
  };
  if (opts.background) params.background = true;
  return params;
}

// ---------------------------------------------------------------------------
// Response mapping (pure)
// ---------------------------------------------------------------------------

function mapStatus(status: unknown): InteractionStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'budget_exceeded':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'incomplete':
      return 'incomplete';
    default:
      // queued, in_progress, requires_action and unknown future states keep polling.
      return 'in_progress';
  }
}

function toVideoRef(item: unknown): OutputVideoRef | null {
  if (!isRecord(item) || item.type !== 'video') return null;
  const uri = typeof item.uri === 'string' && item.uri ? item.uri : null;
  const data = typeof item.data === 'string' && item.data ? item.data : null;
  if (!uri && !data) return null;
  return {
    uri,
    mimeType: typeof item.mime_type === 'string' && item.mime_type ? item.mime_type : 'video/mp4',
    inlineData: data,
  };
}

function findVideo(raw: Record<string, unknown>): OutputVideoRef | null {
  const direct = toVideoRef(raw.output_video);
  if (direct) return direct;
  for (const step of currentTurnSteps(raw)) {
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (let j = step.content.length - 1; j >= 0; j--) {
      const ref = toVideoRef(step.content[j]);
      if (ref) return ref;
    }
  }
  return null;
}

function collectErrorMessages(raw: Record<string, unknown>): { code: string | null; message: string }[] {
  const out: { code: string | null; message: string }[] = [];
  if (Array.isArray(raw.errors)) {
    for (const e of raw.errors) {
      if (!isRecord(e)) continue;
      const message = typeof e.message === 'string' ? e.message.trim() : '';
      const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : null;
      if (message || code) out.push({ code, message });
    }
  }
  for (const step of currentTurnSteps(raw)) {
    if (step.type !== 'model_output' || !isRecord(step.error)) continue;
    const message = typeof step.error.message === 'string' ? step.error.message.trim() : '';
    const code =
      typeof step.error.code === 'number' || typeof step.error.code === 'string' ? String(step.error.code) : null;
    if (message || (code && code !== '0')) out.push({ code, message });
  }
  return out;
}

function errorInfoFor(
  rawStatus: string,
  status: InteractionStatus,
  errors: { code: string | null; message: string }[],
  secrets: (string | null | undefined)[],
): VideoModelErrorInfo | null {
  const joined = redactSecrets(
    errors
      .map((e) => e.message || e.code || '')
      .filter(Boolean)
      .join('; '),
    secrets,
  );
  const codes = errors.map((e) => e.code ?? '').join(' ');
  if (status === 'completed' || status === 'in_progress') return null;
  if (rawStatus === 'budget_exceeded') {
    return {
      code: 'budget_exceeded',
      message: `Gemini stopped the interaction because a spending budget was exceeded${joined ? ` (${joined})` : ''}. Check the billing budget of the Google Cloud project.`,
      retryable: false,
    };
  }
  if (joined && (looksLikeSafetyBlock(joined) || looksLikeSafetyBlock(codes))) {
    return {
      code: 'safety_blocked',
      message: `Gemini blocked the video for safety or policy reasons (${joined}). ${SAFETY_HINT}`,
      retryable: false,
    };
  }
  if (/resource.?exhausted|quota|rate limit|429/i.test(`${joined} ${codes}`)) {
    return { code: 'rate_limited', message: `Gemini rate or spending limit reached (${joined}).`, retryable: true };
  }
  if (status === 'cancelled') {
    return errors.length
      ? { code: 'interaction_cancelled', message: `Gemini cancelled the interaction (${joined}).`, retryable: true }
      : null;
  }
  if (status === 'incomplete') {
    return {
      code: 'interaction_incomplete',
      message: `Gemini stopped before the video was finished${joined ? ` (${joined})` : ''}.`,
      retryable: true,
    };
  }
  return {
    code: 'generation_failed',
    message: joined
      ? `Gemini could not generate the video: ${joined}`
      : 'Gemini reported that the video generation failed.',
    retryable: true,
  };
}

/** Maps a raw Interaction (SDK object or REST JSON) to the adapter-neutral `InteractionState`. */
export function mapInteraction(raw: unknown, secrets: (string | null | undefined)[] = []): InteractionState {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
    throw new VideoModelError('invalid_response', 'Gemini returned an interaction without an id.', { retryable: true });
  }
  const rawStatus = typeof raw.status === 'string' ? raw.status : 'in_progress';
  let status = mapStatus(rawStatus);
  const video = status === 'completed' ? findVideo(raw) : null;
  const errors = collectErrorMessages(raw);
  // A "completed" turn without any video but with recorded errors is a failure worth explaining.
  if (status === 'completed' && !video && errors.length) status = 'failed';
  return {
    id: raw.id,
    status,
    video,
    usage: normalizeUsage(raw.usage),
    error: errorInfoFor(rawStatus, status, errors, secrets),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface GeminiVideoClientOptions {
  config: AppConfig;
  logger: Logger;
  /** Injectable SDK client (tests). Defaults to a real `GoogleGenAI` built from the config API key. */
  ai?: GenAiLike;
  /** Injectable fetch used to download output videos (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Max wait for an uploaded or generated file to become ACTIVE. */
  fileActiveTimeoutMs?: number;
  filePollIntervalMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fileIdFromUri(uri: string): string | null {
  if (uri.startsWith('files/')) return /^files\/([A-Za-z0-9_-]+)/.exec(uri)?.[1] ?? null;
  try {
    const url = new URL(uri);
    if (url.hostname !== GEMINI_FILES_HOST) return null;
    return /\/files\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function is400About(err: VideoModelError, word: RegExp): boolean {
  return err.status === 400 && word.test(err.message);
}

export class GeminiVideoClient implements VideoModelClient {
  readonly model: string;
  readonly isMock = false;
  private readonly ai: GenAiLike;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;
  private readonly requestTimeoutMs: number;
  private readonly fileActiveTimeoutMs: number;
  private readonly filePollIntervalMs: number;
  /** Flips to false for the rest of the process if the API rejects `background: true`. */
  private backgroundSupported = true;
  /** Flips to false for the rest of the process if the API rejects `duration` on extension turns. */
  private extensionDurationSupported = true;
  /** Flips to false for the rest of the process if the API rejects `resolution` on extension turns. */
  private extensionResolutionSupported = true;
  /** Flips to false for the rest of the process if the API rejects `delivery: 'uri'` (inline data is then used). */
  private uriDeliverySupported = true;

  constructor(opts: GeminiVideoClientOptions) {
    const { config } = opts;
    this.model = config.gemini.videoModel;
    this.apiKey = config.gemini.apiKey ?? '';
    if (!opts.ai && !this.apiKey) {
      throw new Error('GEMINI_API_KEY is required for the Gemini video client.');
    }
    this.requestTimeoutMs = config.gemini.requestTimeoutMs;
    this.ai = opts.ai ?? createGenAi(this.apiKey, this.requestTimeoutMs);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.log = opts.logger.child({ component: 'gemini-video' });
    this.fileActiveTimeoutMs = opts.fileActiveTimeoutMs ?? 120_000;
    this.filePollIntervalMs = opts.filePollIntervalMs ?? 2_000;
  }

  /** Whether turns are currently created in background mode (false after a rejected background create). */
  get usesBackground(): boolean {
    return this.backgroundSupported;
  }

  private classify(err: unknown, context: Parameters<typeof classifyGeminiError>[2]): VideoModelError {
    return classifyGeminiError(err, this.apiKey, context);
  }

  async uploadImage(input: { data: Buffer; mimeType: string; displayName: string }): Promise<UploadedFileRef> {
    const displayName = input.displayName.slice(0, 500);
    let file: GenAiFile;
    try {
      file = await this.ai.files.upload({
        file: new Blob([new Uint8Array(input.data)], { type: input.mimeType }),
        config: { mimeType: input.mimeType, displayName },
      });
    } catch (err) {
      throw this.classify(err, 'upload');
    }
    if (file.name && file.state && file.state !== 'ACTIVE') {
      file = (await this.waitForActive(file.name, file, 'upload')) ?? file;
    }
    if (file.state === 'FAILED') {
      throw new VideoModelError(
        'upload_failed',
        `Gemini could not process the character image${file.error?.message ? `: ${redactSecrets(file.error.message, [this.apiKey])}` : '.'}`,
        { retryable: true },
      );
    }
    if (!file.uri) {
      throw new VideoModelError('upload_failed', 'Gemini accepted the character image but returned no file URI.', {
        retryable: true,
      });
    }
    const expires = file.expirationTime ? new Date(file.expirationTime) : null;
    const ref: UploadedFileRef = {
      uri: file.uri,
      mimeType: file.mimeType || input.mimeType,
      name: file.name ?? null,
      expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : new Date(Date.now() + DEFAULT_FILE_TTL_MS),
    };
    this.log.info({ file: ref.name, mimeType: ref.mimeType, bytes: input.data.length }, 'character image uploaded');
    return ref;
  }

  /**
   * Polls `files.get` until the file is ACTIVE or FAILED, or the bounded wait elapses. For downloads a
   * failing `files.get` is not fatal (returns null): the download request itself decides.
   */
  private async waitForActive(
    name: string,
    initial: GenAiFile | null,
    context: 'upload' | 'download',
  ): Promise<GenAiFile | null> {
    const deadline = Date.now() + this.fileActiveTimeoutMs;
    let file = initial;
    for (;;) {
      if (!file) {
        try {
          file = await this.ai.files.get({ name });
        } catch (err) {
          const e = this.classify(err, context);
          if (context === 'download') {
            this.log.debug({ file: name, code: e.code }, 'files.get failed before download');
            return null;
          }
          if (!e.retryable) throw e;
        }
      }
      if (file && (!file.state || file.state === 'ACTIVE' || file.state === 'FAILED')) return file;
      if (Date.now() >= deadline) {
        if (context === 'upload') {
          throw new VideoModelError('upload_timeout', 'Gemini did not finish processing the character image in time.', {
            retryable: true,
          });
        }
        this.log.warn({ file: name }, 'generated file still not ACTIVE, trying to download anyway');
        return file;
      }
      await this.sleep(this.filePollIntervalMs);
      file = null;
    }
  }

  async startTurn(req: VideoTurnRequest): Promise<InteractionState> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const background = this.backgroundSupported;
      const includeDuration = req.kind === 'initial' || this.extensionDurationSupported;
      const includeExtensionResolution = this.extensionResolutionSupported;
      const uriDelivery = this.uriDeliverySupported;
      const params = buildTurnRequest(req, this.model, {
        background,
        includeDuration,
        includeExtensionResolution,
        uriDelivery,
      });
      const promptText = req.prompt.trim();
      this.log.info(
        {
          generationId: req.generationId,
          kind: req.kind,
          model: this.model,
          resolution: req.resolution,
          durationSec: req.durationSec,
          imageMode: req.imageMode,
          withImage: Boolean(req.image),
          previousInteractionId: req.previousInteractionId,
          background,
          includeDuration,
          promptChars: promptText.length,
          promptPreview: promptText.slice(0, 200),
        },
        'creating omni turn',
      );
      this.log.debug({ generationId: req.generationId, prompt: promptText }, 'omni turn prompt');
      try {
        const raw = await this.ai.interactions.create(params as unknown as Record<string, unknown>, {
          // Never let the SDK retry a paid video create: a retried request can be billed twice.
          maxRetries: 0,
          timeout: background ? Math.min(this.requestTimeoutMs, 120_000) : this.requestTimeoutMs,
        });
        const state = mapInteraction(raw, [this.apiKey]);
        this.log.info(
          { generationId: req.generationId, kind: req.kind, interactionId: state.id, status: state.status },
          'omni turn created',
        );
        return state;
      } catch (err) {
        const e = this.classify(err, 'create');
        if (background && is400About(e, /background/i)) {
          this.backgroundSupported = false;
          this.log.warn(
            { generationId: req.generationId, reason: e.message },
            'background interactions rejected, switching to blocking calls for this process',
          );
          continue;
        }
        if (req.kind === 'extension' && includeDuration && is400About(e, /duration/i)) {
          this.extensionDurationSupported = false;
          this.log.warn(
            { generationId: req.generationId, reason: e.message },
            'duration rejected on extension turns, omitting it for this process',
          );
          continue;
        }
        if (req.kind === 'extension' && includeExtensionResolution && is400About(e, /resolution/i)) {
          this.extensionResolutionSupported = false;
          this.log.warn(
            { generationId: req.generationId, reason: e.message },
            'resolution rejected on extension turns, omitting it for this process',
          );
          continue;
        }
        if (uriDelivery && is400About(e, /delivery/i)) {
          this.uriDeliverySupported = false;
          this.log.warn(
            { generationId: req.generationId, reason: e.message },
            'uri delivery rejected, falling back to inline video data for this process',
          );
          continue;
        }
        this.log.warn(
          { generationId: req.generationId, kind: req.kind, code: e.code, status: e.status },
          'omni create failed',
        );
        throw e;
      }
    }
    throw new VideoModelError('invalid_request', 'Gemini rejected every variant of the video request.', {
      retryable: false,
    });
  }

  async getInteraction(id: string): Promise<InteractionState> {
    if (id.startsWith('mock_')) {
      // Created by the mock client before GEMINI_MOCK was turned off: Google has never seen it.
      throw new VideoModelError(
        'interaction_lost',
        'This interaction was created in mock mode and cannot be resumed.',
        {
          retryable: true,
        },
      );
    }
    let raw: unknown;
    try {
      raw = await this.ai.interactions.get(id, { timeout: Math.min(this.requestTimeoutMs, 300_000) });
    } catch (err) {
      throw this.classify(err, 'get');
    }
    const state = mapInteraction(raw, [this.apiKey]);
    if (state.status !== 'in_progress') {
      this.log.info(
        {
          interactionId: id,
          status: state.status,
          hasVideo: Boolean(state.video),
          videoDelivery: state.video ? (state.video.inlineData ? 'inline' : 'uri') : null,
          errorCode: state.error?.code ?? null,
        },
        'omni turn finished',
      );
    }
    return state;
  }

  async cancel(id: string): Promise<void> {
    if (id.startsWith('mock_')) return;
    try {
      await this.ai.interactions.cancel(id, { maxRetries: 1, timeout: 30_000 });
      this.log.info({ interactionId: id }, 'omni interaction cancelled');
    } catch (err) {
      const e = this.classify(err, 'cancel');
      // Already finished, blocking (not cancellable) or unknown interactions: nothing to cancel.
      if (e.status === 400 || e.status === 404 || e.status === 409 || e.code === 'not_found') return;
      this.log.warn({ interactionId: id, code: e.code }, 'omni cancel failed');
      throw e;
    }
  }

  async downloadVideo(video: OutputVideoRef, destPath: string): Promise<void> {
    if (video.inlineData) {
      const data = Buffer.from(video.inlineData, 'base64');
      if (data.length === 0) {
        throw new VideoModelError('empty_output', 'Gemini returned an empty inline video.', { retryable: true });
      }
      if (data.length > MAX_VIDEO_BYTES) {
        throw new VideoModelError('invalid_output', 'Gemini returned an unexpectedly large video.', {
          retryable: false,
        });
      }
      await writeFile(destPath, data);
      this.log.info({ bytes: data.length, delivery: 'inline' }, 'output video saved');
      return;
    }
    if (!video.uri) {
      throw new VideoModelError('empty_output', 'Gemini returned no video to download.', { retryable: false });
    }
    const fileId = fileIdFromUri(video.uri);
    let url: string;
    if (fileId) {
      await this.waitForActive(`files/${fileId}`, null, 'download');
      url = `${FILES_DOWNLOAD_BASE}/${fileId}:download?alt=media`;
    } else if (/^https:\/\//i.test(video.uri)) {
      url = video.uri;
    } else {
      throw new VideoModelError('invalid_output', 'Gemini returned a video URI that cannot be downloaded.', {
        retryable: false,
      });
    }
    await this.streamToFile(url, destPath);
  }

  /** Streams a URL to disk. The API key is only sent to the Gemini API host, never to redirects elsewhere. */
  private async streamToFile(startUrl: string, destPath: string): Promise<void> {
    const partPath = `${destPath}.part`;
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    let url = startUrl;
    try {
      let res: Response | null = null;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const host = new URL(url).hostname;
        const headers: Record<string, string> = host === GEMINI_FILES_HOST ? { 'x-goog-api-key': this.apiKey } : {};
        res = await this.fetchImpl(url, { headers, redirect: 'manual', signal });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel().catch(() => undefined);
          url = new URL(location, url).toString();
          continue;
        }
        break;
      }
      if (!res) throw new Error('no response');
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw this.classify({ status: res.status, message: text || res.statusText }, 'download');
      }
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
        await res.body.cancel().catch(() => undefined);
        throw new VideoModelError('invalid_output', 'The generated video is unexpectedly large.', { retryable: false });
      }
      await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream), createWriteStream(partPath));
      const { size } = await stat(partPath);
      if (size === 0) {
        throw new VideoModelError('empty_output', 'The downloaded video is empty.', { retryable: true });
      }
      if (Number.isFinite(declared) && declared > 0 && size !== declared) {
        throw new VideoModelError(
          'download_incomplete',
          `The video download stopped early (${size} of ${declared} bytes).`,
          {
            retryable: true,
          },
        );
      }
      await rename(partPath, destPath);
      this.log.info({ bytes: size, delivery: 'uri' }, 'output video saved');
    } catch (err) {
      await rm(partPath, { force: true }).catch(() => undefined);
      throw err instanceof VideoModelError ? err : this.classify(err, 'download');
    }
  }
}
