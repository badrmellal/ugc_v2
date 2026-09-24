/**
 * Module boundaries ("ports") between the pipeline and its adapters.
 * Adapters: Gemini (real + mock), storage (local + S3), media (ffmpeg), database repository.
 */
import type { Readable } from 'node:stream';
import type {
  CostBreakdown,
  GenerationError,
  GenerationSettings,
  GenerationStage,
  GenerationStatus,
  RegenerationMode,
  Resolution,
  ScriptPlan,
} from '../shared/api.js';

// ---------------------------------------------------------------------------
// Gemini video model (Omni)
// ---------------------------------------------------------------------------

/** Token usage as reported by the Interactions API, normalized. Unknown fields stay undefined. */
export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Output tokens attributed to video (and audio) modality when the API reports a breakdown. */
  videoOutputTokens?: number;
  textOutputTokens?: number;
  /** Thinking tokens, billed at the text output rate. Reported separately from output tokens. */
  thoughtTokens?: number;
  /** Input tokens attributed to video modality (e.g. previous-turn video context). */
  videoInputTokens?: number;
  imageInputTokens?: number;
  textInputTokens?: number;
  /** Raw usage object for auditing. */
  raw?: unknown;
}

export interface UploadedFileRef {
  /** Files API URI usable in interaction input parts. */
  uri: string;
  mimeType: string;
  /** Files API resource name, e.g. `files/abc123`. */
  name: string | null;
  expiresAt: Date | null;
}

export interface OutputVideoRef {
  uri: string | null;
  mimeType: string;
  /** Base64 data when delivery is inline. */
  inlineData?: string | null;
}

export type InteractionStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'incomplete';

export interface InteractionState {
  id: string;
  status: InteractionStatus;
  video: OutputVideoRef | null;
  usage: UsageInfo | null;
  error: VideoModelErrorInfo | null;
}

export interface VideoModelErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface VideoTurnRequest {
  /** Turn 1: fresh generation from prompt + character image. */
  kind: 'initial' | 'extension';
  prompt: string;
  resolution: Resolution;
  /** Seconds to generate in this turn (3-10). */
  durationSec: number;
  aspectRatio: '9:16' | '16:9';
  /** Character image; required for `initial`, optional for `extension` (identity reinforcement). */
  image: UploadedFileRef | null;
  imageMode: 'reference' | 'first_frame';
  /** Required for `extension`: the interaction whose video is extended. */
  previousInteractionId: string | null;
  /** Correlation id for logs and request labels. */
  generationId: string;
}

export interface VideoModelClient {
  readonly model: string;
  readonly isMock: boolean;
  uploadImage(input: { data: Buffer; mimeType: string; displayName: string }): Promise<UploadedFileRef>;
  /**
   * Starts a turn. Must return as soon as the interaction id is known.
   * If the backend only supports blocking calls, may return an already terminal state.
   */
  startTurn(req: VideoTurnRequest): Promise<InteractionState>;
  /** Fetches the current state of a (background) interaction. */
  getInteraction(id: string): Promise<InteractionState>;
  /** Best effort cancel of a running interaction. */
  cancel(id: string): Promise<void>;
  /** Downloads the output video to a local file path. */
  downloadVideo(video: OutputVideoRef, destPath: string): Promise<void>;
}

/** Error thrown by adapters. `retryable` drives the job retry policy. */
export class VideoModelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(code: string, message: string, opts: { retryable: boolean; status?: number | null; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = 'VideoModelError';
    this.code = code;
    this.retryable = opts.retryable;
    this.status = opts.status ?? null;
  }
}

// ---------------------------------------------------------------------------
// Text model used by the script splitter
// ---------------------------------------------------------------------------

export interface TextModelClient {
  readonly model: string;
  /** Returns parsed JSON conforming to `jsonSchema`. Throws on transport/parse failure. */
  generateJson(input: {
    systemInstruction: string;
    prompt: string;
    jsonSchema: Record<string, unknown>;
    temperature?: number;
    timeoutMs?: number;
  }): Promise<{ data: unknown; usage: UsageInfo | null }>;
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

export interface StoredObjectInfo {
  key: string;
  size: number;
  contentType: string;
}

export interface ReadRange {
  start: number;
  end: number; // inclusive
}

export interface StorageDriver {
  readonly kind: 'local' | 's3';
  putFile(key: string, localPath: string, contentType: string): Promise<StoredObjectInfo>;
  putBuffer(key: string, data: Buffer, contentType: string): Promise<StoredObjectInfo>;
  /** Copies the object to a local path (for ffmpeg processing). */
  downloadToFile(key: string, localPath: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer>;
  stat(key: string): Promise<StoredObjectInfo | null>;
  createReadStream(key: string, range?: ReadRange): Promise<Readable>;
  copy(srcKey: string, destKey: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Presigned GET URL when supported and enabled, else null (caller streams through the API). */
  getSignedUrl(key: string, opts: { downloadFileName?: string; contentType?: string }): Promise<string | null>;
  healthCheck(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Media processing (ffmpeg / ffprobe)
// ---------------------------------------------------------------------------

export interface ProbeResult {
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

export interface MediaTools {
  probe(path: string): Promise<ProbeResult>;
  /** Re-mux (no re-encode when possible) with +faststart for progressive web playback. */
  faststart(input: string, output: string): Promise<void>;
  /** Concatenate clips (re-encoding to a common format) into one MP4. */
  concat(inputs: string[], output: string): Promise<void>;
  /** Extract a JPEG poster frame at `atSec`. */
  thumbnail(input: string, output: string, atSec: number): Promise<void>;
  /** Normalize an uploaded image: auto-orient, strip metadata, cap longest side, output JPEG. */
  normalizeImage(input: string, output: string, maxSide: number): Promise<{ width: number; height: number }>;
  /** Mock mode: synthesize a vertical test clip with tone audio and a caption. */
  synthesizeClip(opts: {
    output: string;
    durationSec: number;
    width: number;
    height: number;
    label: string;
    imagePath?: string | null;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface GenerationRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  status: GenerationStatus;
  stage: GenerationStage;
  progress: number;
  stageStartedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  title: string;
  script: string;
  settings: GenerationSettings;
  plan: ScriptPlan | null;
  characterImageKey: string;
  characterImageMime: string;
  characterImageSha256: string;
  geminiFileUri: string | null;
  geminiFileMime: string | null;
  geminiFileExpiresAt: Date | null;
  part1InteractionId: string | null;
  part1Status: string | null;
  part1VideoKey: string | null;
  part1Usage: UsageInfo | null;
  part1Attempts: number;
  part2InteractionId: string | null;
  part2Status: string | null;
  part2VideoKey: string | null;
  part2Usage: UsageInfo | null;
  part2Attempts: number;
  finalVideoKey: string | null;
  /** The final video without captions, set when captions were burned into `finalVideoKey`. */
  finalCleanKey: string | null;
  /** How caption timing was found ('pocketsphinx' or 'estimate'); null without captions. */
  captionEngine: string | null;
  thumbnailKey: string | null;
  durationSec: number | null;
  assembly: 'model_full' | 'concatenated' | null;
  estimatedCost: CostBreakdown;
  estimatedCostUsd: number;
  actualCost: CostBreakdown | null;
  actualCostUsd: number | null;
  error: GenerationError | null;
  parentId: string | null;
  regenerationMode: RegenerationMode | null;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  cancelRequested: boolean;
}

export type GenerationPatch = Partial<
  Omit<GenerationRecord, 'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'error'>
> & { error?: GenerationError | null };

export interface NewGeneration {
  id: string;
  createdBy: string | null;
  title: string;
  script: string;
  settings: GenerationSettings;
  plan: ScriptPlan | null;
  characterImageKey: string;
  characterImageMime: string;
  characterImageSha256: string;
  geminiFileUri?: string | null;
  geminiFileMime?: string | null;
  geminiFileExpiresAt?: Date | null;
  part1InteractionId?: string | null;
  part1Status?: string | null;
  part1VideoKey?: string | null;
  part1Usage?: UsageInfo | null;
  estimatedCost: CostBreakdown;
  parentId: string | null;
  regenerationMode: RegenerationMode | null;
  maxAttempts: number;
}

export interface ApiCallRecord {
  generationId: string | null;
  kind: 'split' | 'part1' | 'part2' | 'upload';
  model: string;
  interactionId: string | null;
  status: string;
  usage: UsageInfo | null;
  costUsd: number;
  costBasis: 'estimate' | 'actual';
}

// ---------------------------------------------------------------------------
// Script planner (splits one 20s script into two coherent 10s turns)
// ---------------------------------------------------------------------------

export interface ScriptSplitResult {
  plan: ScriptPlan;
  usage: UsageInfo | null;
  /** Cost of the split call (0 for the deterministic fallback). */
  costUsd: number;
  /** Model used, or null for the deterministic fallback. */
  model: string | null;
}

export interface ScriptPlanner {
  /** Splits the script with the LLM, falling back to the deterministic splitter on any failure. */
  split(input: { script: string; settings: GenerationSettings }): Promise<ScriptSplitResult>;
  /**
   * Validates and normalizes a plan (e.g. user-edited), then rebuilds both segment prompts from its
   * fields so the prompt format is always produced server-side. Pure and synchronous.
   */
  finalize(plan: ScriptPlan, settings: GenerationSettings): ScriptPlan;
}
