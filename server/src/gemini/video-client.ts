/**
 * Gemini Omni video adapter: Files API upload of the character image, Interactions API turns
 * (part 1 generation and part 2 extension chained with `previous_interaction_id`), polling,
 * cancellation and download of the output video.
 *
 * Turns run over one of three transports, chosen by `OMNI_TRANSPORT` and downgraded at runtime:
 * - `stream` (default): an SSE stream; the interaction id arrives with the first event, the rest of
 *   the stream is consumed in the background and `getInteraction` reads its state from memory.
 * - `background`: a background interaction polled with `interactions.get`.
 * - `blocking`: a plain call that returns when the video is done (last resort only).
 * A 400 that names `background` or `stream`, or a background interaction that cannot be polled,
 * switches the process to the next transport.
 */
import { createWriteStream } from 'node:fs';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
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
import { createGenAi, currentTurnSteps, isAsyncIterable, isRecord, type GenAiFile, type GenAiLike } from './genai.js';

export const GEMINI_FILES_HOST = 'generativelanguage.googleapis.com';
const FILES_DOWNLOAD_BASE = `https://${GEMINI_FILES_HOST}/v1beta/files`;
/** Uploaded files are kept for 48h; assume slightly less when the API does not say. */
const DEFAULT_FILE_TTL_MS = 47 * 60 * 60 * 1000;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Max wait for the first stream event (which carries the interaction id), and for a background create. */
const CREATE_ACK_TIMEOUT_MS = 120_000;
/** Finished stream turns are kept in memory this long so the pipeline can read their final state. */
const FINISHED_STREAM_TTL_MS = 30 * 60 * 1000;
const MAX_FINISHED_STREAMS = 16;

// ---------------------------------------------------------------------------
// Request building (pure)
// ---------------------------------------------------------------------------

export type OmniTransport = 'stream' | 'background' | 'blocking';

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
  stream?: boolean;
}

export interface BuildTurnOptions {
  /** Create a background interaction (ignored when `stream` is set). */
  background: boolean;
  /** Stream the interaction as SSE events. */
  stream?: boolean;
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

const IMAGE_REF_TAG = /<IMAGE_REF_\d+>/;

/**
 * Makes sure an attached image is bound by a tag: an untagged image is silently ignored by Omni.
 * Prompts built by `script/prompts.ts` already carry the tag, so this is only a safety net.
 */
export function ensureImageTag(prompt: string, kind: 'initial' | 'extension', imageMode: 'reference' | 'first_frame') {
  if (kind === 'initial' && imageMode === 'first_frame') {
    return prompt.includes('<FIRST_FRAME>') ? prompt : `<FIRST_FRAME> ${prompt}`;
  }
  // A prompt built for first-frame mode must not bind the image a second way.
  prompt = prompt.replace(/<FIRST_FRAME>\s*/g, '').trim();
  if (prompt.includes('<IMAGE_REF_0>')) return prompt;
  return kind === 'initial'
    ? `${prompt}\nThe main character is the person in <IMAGE_REF_0>.`
    : `${prompt}\nThe person is the same person shown in <IMAGE_REF_0>.`;
}

/**
 * Removes image tags from a prompt sent without an image: a tag that points at no image makes the
 * request invalid. Lines that exist only to bind the image are dropped whole.
 */
export function stripImageTags(prompt: string): string {
  if (!IMAGE_REF_TAG.test(prompt) && !prompt.includes('<FIRST_FRAME>')) return prompt;
  return prompt
    .split('\n')
    .filter((line) => !IMAGE_REF_TAG.test(line))
    .join('\n')
    .replace(/<FIRST_FRAME>\s*/g, '')
    .trim();
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
  const mode = (params: OmniTurnParams): OmniTurnParams => {
    if (opts.stream) params.stream = true;
    else if (opts.background) params.background = true;
    return params;
  };

  if (req.kind === 'initial') {
    if (!req.image) {
      throw new VideoModelError('invalid_request', 'Part 1 needs the uploaded character image.', { retryable: false });
    }
    return mode({
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
    });
  }

  if (!req.previousInteractionId) {
    throw new VideoModelError('invalid_request', 'The extension turn needs the part 1 interaction id.', {
      retryable: false,
    });
  }
  const responseFormat: OmniVideoResponseFormat = { type: 'video', ...delivery };
  if (opts.includeExtensionResolution !== false) responseFormat.resolution = req.resolution;
  if (opts.includeDuration) responseFormat.duration = durationString(req.durationSec);
  let input: OmniTurnParams['input'];
  if (req.image) {
    input = [
      { type: 'image', uri: req.image.uri, mime_type: req.image.mimeType },
      { type: 'text', text: ensureImageTag(prompt, 'extension', 'reference') },
    ];
  } else {
    input = stripImageTags(prompt);
    if (!input)
      throw new VideoModelError('invalid_request', 'The prompt for this turn is empty.', { retryable: false });
  }
  return mode({
    model,
    previous_interaction_id: req.previousInteractionId,
    input,
    response_format: responseFormat,
  });
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
// Stream events (pure)
// ---------------------------------------------------------------------------

/** An Interaction assembled from SSE events; readable with `mapInteraction` once it has an id. */
export interface StreamedInteraction {
  id: string | null;
  status: string;
  steps: Record<string, unknown>[];
  usage?: unknown;
  errors: { code: string | null; message: string }[];
  /** Id of the last event, for logs. */
  lastEventId: string | null;
}

export function newStreamedInteraction(): StreamedInteraction {
  return { id: null, status: 'in_progress', steps: [], errors: [], lastEventId: null };
}

function isTerminalRawStatus(status: string): boolean {
  return mapStatus(status) !== 'in_progress';
}

function stepAt(acc: StreamedInteraction, index: number): Record<string, unknown> {
  const existing = acc.steps[index];
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = { type: 'model_output', content: [] };
  acc.steps[index] = created;
  return created;
}

function applyDelta(step: Record<string, unknown>, delta: Record<string, unknown>): void {
  const content = Array.isArray(step.content) ? (step.content as unknown[]) : (step.content = []);
  const last = content[content.length - 1];
  if (delta.type === 'video') {
    let item = isRecord(last) && last.type === 'video' && !last.uri ? last : null;
    if (!item || (typeof delta.uri === 'string' && delta.uri)) {
      item = { type: 'video' };
      content.push(item);
    }
    if (typeof delta.uri === 'string' && delta.uri) item.uri = delta.uri;
    // Inline video data may arrive in several chunks of one base64 string.
    if (typeof delta.data === 'string' && delta.data)
      item.data = `${typeof item.data === 'string' ? item.data : ''}${delta.data}`;
    if (typeof delta.mime_type === 'string' && delta.mime_type) item.mime_type = delta.mime_type;
  } else if (delta.type === 'text' && typeof delta.text === 'string') {
    if (isRecord(last) && last.type === 'text' && typeof last.text === 'string') last.text += delta.text;
    else content.push({ type: 'text', text: delta.text });
  }
}

/** Applies one SSE event (`InteractionSSEEvent`) to the assembled interaction. Unknown events are ignored. */
export function applyStreamEvent(acc: StreamedInteraction, event: unknown): void {
  if (!isRecord(event)) return;
  if (typeof event.event_id === 'string' && event.event_id) acc.lastEventId = event.event_id;
  const terminal = isTerminalRawStatus(acc.status);
  switch (event.event_type) {
    case 'interaction.created':
    case 'interaction.completed': {
      const it = event.interaction;
      if (!isRecord(it)) return;
      if (typeof it.id === 'string' && it.id) acc.id ??= it.id;
      if (typeof it.status === 'string' && (event.event_type === 'interaction.completed' || !terminal)) {
        acc.status = it.status;
      }
      if (it.usage !== undefined) acc.usage = it.usage;
      // Lifecycle payloads may omit steps. When present they replace the streamed ones, unless that
      // would drop a video already received through deltas.
      if (Array.isArray(it.steps)) {
        const incoming = (it.steps as unknown[]).filter(isRecord);
        const hasOutput = incoming.some((s) => s.type === 'model_output');
        if (findVideo({ steps: incoming }) || (hasOutput && !findVideo({ steps: acc.steps }))) acc.steps = incoming;
      }
      if (event.event_type === 'interaction.completed' && !isTerminalRawStatus(acc.status)) acc.status = 'completed';
      return;
    }
    case 'interaction.status_update':
      if (typeof event.interaction_id === 'string' && event.interaction_id) acc.id ??= event.interaction_id;
      if (typeof event.status === 'string' && !terminal) acc.status = event.status;
      return;
    case 'step.start':
      if (typeof event.index === 'number' && event.index >= 0 && isRecord(event.step)) {
        const step = { ...event.step };
        if (Array.isArray(step.content))
          step.content = (step.content as unknown[]).map((c) => (isRecord(c) ? { ...c } : c));
        acc.steps[event.index] = step;
      }
      return;
    case 'step.delta':
      if (typeof event.index === 'number' && event.index >= 0 && isRecord(event.delta)) {
        applyDelta(stepAt(acc, event.index), event.delta);
      }
      if (isRecord(event.metadata) && event.metadata.total_usage !== undefined) acc.usage = event.metadata.total_usage;
      return;
    case 'step.stop':
      if (event.usage !== undefined) acc.usage = event.usage;
      return;
    case 'error': {
      const e = isRecord(event.error) ? event.error : {};
      const message = typeof e.message === 'string' ? e.message.trim() : '';
      const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : null;
      acc.errors.push({ code, message: message || 'The Gemini stream reported an error.' });
      if (!terminal) acc.status = 'failed';
      return;
    }
    default:
      return;
  }
}

function streamedToRaw(acc: StreamedInteraction, id: string): Record<string, unknown> {
  return { id, status: acc.status, steps: acc.steps, usage: acc.usage, errors: acc.errors };
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
  /** Max wait for the interaction id after a create (first stream event or background response). */
  createAckTimeoutMs?: number;
  /**
   * Transports other workers found unusable (persisted). Read before each turn so the whole cluster
   * learns from one rejection. Errors are ignored.
   */
  loadUnsupportedTransports?: () => Promise<OmniTransport[]>;
  /** Called once when this process finds a transport unusable, so it can be persisted. */
  onTransportRejected?: (transport: OmniTransport, reason: string) => void;
}

/** A turn whose SSE stream this process is reading. */
interface StreamTurn {
  id: string;
  generationId: string;
  acc: StreamedInteraction;
  /** `open` while events arrive, `ended` after a terminal event, `broken` when cut before one. */
  phase: 'open' | 'ended' | 'broken';
  controller: AbortController;
  cancelled: boolean;
  finishedAt: number | null;
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

const TRANSPORT_FALLBACKS: Record<'stream' | 'background', OmniTransport[]> = {
  stream: ['stream', 'background', 'blocking'],
  background: ['background', 'stream', 'blocking'],
};

/** Counts bytes flowing through and fails once `max` is exceeded (servers can omit Content-Length). */
function byteLimit(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (seen > max) {
        done(new VideoModelError('invalid_output', 'The generated video is unexpectedly large.', { retryable: false }));
        return;
      }
      done(null, chunk);
    },
  });
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
  private readonly streamTimeoutMs: number;
  private readonly createAckTimeoutMs: number;
  private readonly fileActiveTimeoutMs: number;
  private readonly filePollIntervalMs: number;
  /** Transports in order of preference; rejected ones are skipped for the rest of the process. */
  private readonly transports: OmniTransport[];
  private readonly unsupportedTransports = new Set<OmniTransport>();
  /** Flips to false for the rest of the process if the API rejects `duration` on extension turns. */
  private extensionDurationSupported = true;
  /** Flips to false for the rest of the process if the API rejects `resolution` on extension turns. */
  private extensionResolutionSupported = true;
  /** Flips to false for the rest of the process if the API rejects `delivery: 'uri'` (inline data is then used). */
  private uriDeliverySupported = true;
  /** Turns streamed by this process, by interaction id. */
  private readonly streams = new Map<string, StreamTurn>();
  /** Background interactions created by this process that have not finished yet. */
  private readonly backgroundIds = new Set<string>();
  private readonly loadUnsupportedTransports: GeminiVideoClientOptions['loadUnsupportedTransports'];
  private readonly onTransportRejected: GeminiVideoClientOptions['onTransportRejected'];

  constructor(opts: GeminiVideoClientOptions) {
    const { config } = opts;
    this.model = config.gemini.videoModel;
    this.apiKey = config.gemini.apiKey ?? '';
    if (!opts.ai && !this.apiKey) {
      throw new Error('GEMINI_API_KEY is required for the Gemini video client.');
    }
    this.requestTimeoutMs = config.gemini.requestTimeoutMs;
    // A stream stays open for the whole turn; the pipeline enforces the turn deadline itself.
    this.streamTimeoutMs = Math.max(config.gemini.requestTimeoutMs, config.gemini.turnTimeoutMs) + 60_000;
    this.createAckTimeoutMs = opts.createAckTimeoutMs ?? CREATE_ACK_TIMEOUT_MS;
    this.ai = opts.ai ?? createGenAi(this.apiKey, this.requestTimeoutMs);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.log = opts.logger.child({ component: 'gemini-video' });
    this.fileActiveTimeoutMs = opts.fileActiveTimeoutMs ?? 120_000;
    this.filePollIntervalMs = opts.filePollIntervalMs ?? 2_000;
    this.transports = TRANSPORT_FALLBACKS[config.gemini.transport === 'background' ? 'background' : 'stream'];
    this.loadUnsupportedTransports = opts.loadUnsupportedTransports;
    this.onTransportRejected = opts.onTransportRejected;
  }

  /** Marks transports as unusable for this process (e.g. learned by another worker). */
  markUnsupported(transports: readonly OmniTransport[]): void {
    for (const t of transports) {
      if (t !== 'blocking' && this.transports.includes(t)) this.unsupportedTransports.add(t);
    }
  }

  /** Transport used for the next turn. */
  get transport(): OmniTransport {
    return this.transports.find((t) => !this.unsupportedTransports.has(t)) ?? 'blocking';
  }

  /** Whether turns are currently created in background mode. */
  get usesBackground(): boolean {
    return this.transport === 'background';
  }

  private classify(err: unknown, context: Parameters<typeof classifyGeminiError>[2]): VideoModelError {
    return classifyGeminiError(err, this.apiKey, context);
  }

  private dropTransport(transport: OmniTransport, reason: string, generationId?: string): void {
    if (transport === 'blocking' || this.unsupportedTransports.has(transport)) return;
    this.unsupportedTransports.add(transport);
    try {
      this.onTransportRejected?.(transport, redactSecrets(reason, [this.apiKey]));
    } catch {
      // Persistence is best effort.
    }
    this.log.warn(
      { generationId, rejected: transport, next: this.transport, reason: redactSecrets(reason, [this.apiKey]) },
      'omni transport not usable, switching for the rest of this process',
    );
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
      if (
        file &&
        (!file.state || file.state === 'STATE_UNSPECIFIED' || file.state === 'ACTIVE' || file.state === 'FAILED')
      ) {
        return file;
      }
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
    this.pruneStreams();
    if (this.loadUnsupportedTransports) {
      try {
        this.markUnsupported(await this.loadUnsupportedTransports());
      } catch (err) {
        this.log.debug({ err: redactSecrets(String(err), [this.apiKey]) }, 'could not load unsupported transports');
      }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const transport = this.transport;
      const includeDuration = req.kind === 'initial' || this.extensionDurationSupported;
      const includeExtensionResolution = this.extensionResolutionSupported;
      const uriDelivery = this.uriDeliverySupported;
      const params = buildTurnRequest(req, this.model, {
        background: transport === 'background',
        stream: transport === 'stream',
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
          transport,
          includeDuration,
          promptChars: promptText.length,
          promptPreview: promptText.slice(0, 200),
        },
        'creating omni turn',
      );
      this.log.debug({ generationId: req.generationId, prompt: promptText }, 'omni turn prompt');
      try {
        const state =
          transport === 'stream' ? await this.createStreamed(params, req) : await this.createPlain(params, transport);
        this.log.info(
          { generationId: req.generationId, kind: req.kind, interactionId: state.id, status: state.status, transport },
          'omni turn created',
        );
        return state;
      } catch (err) {
        const e = this.classify(err, 'create');
        if (transport === 'background' && is400About(e, /\bbackground\b/i)) {
          this.dropTransport('background', e.message, req.generationId);
          continue;
        }
        if (transport === 'stream' && is400About(e, /\bstream(?:ing)?\b|event-stream/i)) {
          this.dropTransport('stream', e.message, req.generationId);
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
          { generationId: req.generationId, kind: req.kind, code: e.code, status: e.status, transport },
          'omni create failed',
        );
        throw e;
      }
    }
    throw new VideoModelError('invalid_request', 'Gemini rejected every variant of the video request.', {
      retryable: false,
    });
  }

  /** Background or blocking create. Never retried by the SDK: a retried create can be billed twice. */
  private async createPlain(params: OmniTurnParams, transport: OmniTransport): Promise<InteractionState> {
    const background = transport === 'background';
    const raw = await this.ai.interactions.create(params as unknown as Record<string, unknown>, {
      maxRetries: 0,
      timeout: background ? Math.min(this.requestTimeoutMs, this.createAckTimeoutMs) : this.requestTimeoutMs,
    });
    const state = mapInteraction(raw, [this.apiKey]);
    if (background && state.status === 'in_progress') this.backgroundIds.add(state.id);
    return state;
  }

  /**
   * Opens the SSE stream and returns as soon as the interaction id is known. The rest of the stream is
   * read in the background; `getInteraction` serves its state from memory.
   */
  private async createStreamed(params: OmniTurnParams, req: VideoTurnRequest): Promise<InteractionState> {
    const controller = new AbortController();
    const result = await this.ai.interactions.create(params as unknown as Record<string, unknown>, {
      maxRetries: 0,
      timeout: this.streamTimeoutMs,
      signal: controller.signal,
    });
    if (!isAsyncIterable(result)) {
      // The server answered with a plain Interaction instead of a stream.
      return mapInteraction(result, [this.apiKey]);
    }
    const iterator = result[Symbol.asyncIterator]();
    const acc = newStreamedInteraction();
    let ackTimer: NodeJS.Timeout | undefined;
    const ackTimeout = new Promise<never>((_, reject) => {
      ackTimer = setTimeout(() => {
        reject(
          new VideoModelError(
            'timeout',
            `Gemini did not confirm the video request within ${Math.round(this.createAckTimeoutMs / 1000)}s.`,
            { retryable: true },
          ),
        );
      }, this.createAckTimeoutMs);
    });
    try {
      while (!acc.id) {
        const next = await Promise.race([iterator.next(), ackTimeout]);
        if (next.done) break;
        applyStreamEvent(acc, next.value);
        if (!acc.id && acc.errors.length) break;
      }
    } catch (err) {
      controller.abort();
      throw err;
    } finally {
      clearTimeout(ackTimer);
    }
    if (!acc.id) {
      controller.abort();
      const first = acc.errors[0];
      if (first) {
        // Rejected before an interaction existed (for example an input safety block). The code is a
        // URI naming the error type; an invalid-argument type is treated like an HTTP 400 so the
        // request downgrades (duration, resolution, delivery) still apply.
        const code = first.code ?? '';
        const status = Number(code) || (/invalid|argument|bad.?request/i.test(code) ? 400 : null);
        throw this.classify({ status, message: first.message }, 'create');
      }
      throw new VideoModelError('invalid_response', 'The Gemini stream ended before an interaction id was sent.', {
        retryable: true,
      });
    }
    const turn: StreamTurn = {
      id: acc.id,
      generationId: req.generationId,
      acc,
      phase: 'open',
      controller,
      cancelled: false,
      finishedAt: null,
    };
    this.streams.set(turn.id, turn);
    void this.readRest(turn, iterator);
    return mapInteraction(streamedToRaw(acc, turn.id), [this.apiKey]);
  }

  private async readRest(turn: StreamTurn, iterator: AsyncIterator<unknown>): Promise<void> {
    let failure: VideoModelError | null = null;
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        applyStreamEvent(turn.acc, next.value);
      }
    } catch (err) {
      if (!turn.cancelled) failure = this.classify(err, 'get');
    } finally {
      turn.phase = isTerminalRawStatus(turn.acc.status) ? 'ended' : 'broken';
      turn.finishedAt = Date.now();
      turn.controller.abort();
    }
    const log = { generationId: turn.generationId, interactionId: turn.id, status: turn.acc.status };
    if (turn.phase === 'broken' && !turn.cancelled) {
      this.log.warn({ ...log, code: failure?.code ?? null }, 'omni stream ended before the turn finished');
    } else {
      this.log.info({ ...log, lastEventId: turn.acc.lastEventId }, 'omni stream finished');
    }
  }

  /** Drops finished stream turns that the pipeline has had time to read (they can hold inline video). */
  private pruneStreams(): void {
    const now = Date.now();
    const finished = [...this.streams.values()]
      .filter((t) => t.finishedAt !== null)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    finished.forEach((t, i) => {
      if (now - (t.finishedAt ?? now) > FINISHED_STREAM_TTL_MS || finished.length - i > MAX_FINISHED_STREAMS) {
        this.streams.delete(t.id);
      }
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
    const turn = this.streams.get(id);
    if (turn) return this.streamedState(turn);
    return this.fetchInteraction(id);
  }

  private async streamedState(turn: StreamTurn): Promise<InteractionState> {
    const state = mapInteraction(streamedToRaw(turn.acc, turn.id), [this.apiKey]);
    if (turn.phase === 'open') return state;
    if (turn.phase === 'ended') {
      if (state.status === 'completed' && !state.video) {
        // The stream carried no video part: read the stored interaction, which has the output.
        const stored = await this.fetchInteraction(turn.id).catch(() => null);
        if (stored?.video) return stored;
      }
      this.logFinished(state);
      return state;
    }
    // Cut before a terminal event: continue with plain polling when the interaction can be read.
    this.streams.delete(turn.id);
    try {
      return await this.fetchInteraction(turn.id);
    } catch (err) {
      const e = err instanceof VideoModelError ? err : this.classify(err, 'get');
      if (e.retryable && e.code !== 'interaction_lost') {
        // Transient: keep the turn so the next poll tries again.
        this.streams.set(turn.id, turn);
        throw e;
      }
      throw new VideoModelError(
        'interaction_lost',
        `The connection to Gemini was lost while this part was generating and its result cannot be read (${e.message}). It will be started again.`,
        { retryable: true, status: e.status, cause: e },
      );
    }
  }

  /** Reads a stored interaction with `interactions.get`. */
  private async fetchInteraction(id: string): Promise<InteractionState> {
    let raw: unknown;
    try {
      raw = await this.ai.interactions.get(id, { timeout: Math.min(this.requestTimeoutMs, 300_000) });
    } catch (err) {
      const e = this.classify(err, 'get');
      if (e.status !== 400 && e.status !== 403 && e.status !== 404) throw e;
      if (this.backgroundIds.has(id)) {
        // Created a moment ago but cannot be polled (reported for some newer API keys): stream instead.
        this.backgroundIds.delete(id);
        this.dropTransport('background', e.message);
        throw new VideoModelError(
          'interaction_lost',
          `Gemini accepted the background request but its status cannot be read (${e.message}). It will be started again over a streaming connection.`,
          { retryable: true, status: e.status, cause: e },
        );
      }
      // The interaction exists (it was created with this key) but cannot be read any more, for example
      // a streamed turn after a worker restart. The pipeline starts the turn again instead of failing.
      throw new VideoModelError('interaction_lost', `${e.message} The turn will be started again.`, {
        retryable: true,
        status: e.status,
        cause: e,
      });
    }
    const state = mapInteraction(raw, [this.apiKey]);
    if (state.status !== 'in_progress') {
      this.backgroundIds.delete(id);
      this.logFinished(state);
    }
    return state;
  }

  private logFinished(state: InteractionState): void {
    this.log.info(
      {
        interactionId: state.id,
        status: state.status,
        hasVideo: Boolean(state.video),
        videoDelivery: state.video ? (state.video.inlineData ? 'inline' : 'uri') : null,
        errorCode: state.error?.code ?? null,
      },
      'omni turn finished',
    );
  }

  async cancel(id: string): Promise<void> {
    if (id.startsWith('mock_')) return;
    const turn = this.streams.get(id);
    if (turn && turn.phase === 'open') {
      turn.cancelled = true;
      if (!isTerminalRawStatus(turn.acc.status)) turn.acc.status = 'cancelled';
      turn.controller.abort();
    }
    this.backgroundIds.delete(id);
    try {
      await this.ai.interactions.cancel(id, { maxRetries: 1, timeout: 30_000 });
      this.log.info({ interactionId: id }, 'omni interaction cancelled');
    } catch (err) {
      const e = this.classify(err, 'cancel');
      // Already finished, streamed/blocking (not cancellable) or unknown interactions: nothing to cancel.
      if (e.status === 400 || e.status === 404 || e.status === 409 || e.code === 'not_found') return;
      if (turn) return; // The stream is closed; the server-side cancel is best effort only.
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
        const target = new URL(url);
        if (target.protocol !== 'https:') {
          throw new VideoModelError('invalid_output', 'The video download was redirected to an insecure address.', {
            retryable: false,
          });
        }
        const headers: Record<string, string> =
          target.hostname === GEMINI_FILES_HOST ? { 'x-goog-api-key': this.apiKey } : {};
        res = await this.fetchImpl(url, { headers, redirect: 'manual', signal });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel().catch(() => undefined);
          if (hop === MAX_REDIRECTS) {
            throw new VideoModelError('download_failed', 'The video download was redirected too many times.', {
              retryable: true,
            });
          }
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
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeReadableStream),
        byteLimit(MAX_VIDEO_BYTES),
        createWriteStream(partPath),
      );
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
