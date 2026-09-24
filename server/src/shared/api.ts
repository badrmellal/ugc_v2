/**
 * Types and constants shared between the API server and the web client.
 *
 * This module must stay free of Node.js imports: the web app imports it
 * through the `@shared/*` alias and Vite bundles it for the browser.
 */

export const VIDEO_STYLES = ['ugc', 'scientific'] as const;
export type VideoStyle = (typeof VIDEO_STYLES)[number];

/**
 * Content theme, independent of the delivery style: it sets the default location, the on-camera role
 * and the ambience, and gives the script splitter subject-specific rules.
 */
export const VIDEO_THEMES = ['general', 'bandys_cars', 'tech_ai_robotics'] as const;
export type VideoTheme = (typeof VIDEO_THEMES)[number];

export const THEME_LABELS: Record<VideoTheme, string> = {
  general: 'General',
  bandys_cars: 'Bandys Cars',
  tech_ai_robotics: 'Technology, AI & Robotics',
};

export const THEME_DESCRIPTIONS: Record<VideoTheme, string> = {
  general: 'No preset: the scene follows your script.',
  bandys_cars: 'Car dealership: lot or showroom with a Bandys Cars sign, walkarounds, deals and test drives.',
  tech_ai_robotics: 'Tech studio or robotics lab: AI tools, gadgets, robots and automation.',
};

export const RESOLUTIONS = ['360p', '720p', '1080p', '4k'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/**
 * How the uploaded character image is bound in the first generation turn.
 * - `reference`: identity reference (<IMAGE_REF_0>); the model builds the scene around the character.
 * - `first_frame`: the image is used as the literal opening frame (<FIRST_FRAME>).
 */
export const IMAGE_MODES = ['reference', 'first_frame'] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];

export const GENERATION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/** Ordered pipeline stages. `completed`, `failed` and `canceled` are terminal. */
export const GENERATION_STAGES = [
  'queued',
  'planning',
  'uploading_image',
  'generating_part1',
  'extending_part2',
  'finalizing',
  'completed',
  'failed',
  'canceled',
] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number];

export const STAGE_LABELS: Record<GenerationStage, string> = {
  queued: 'Queued',
  planning: 'Splitting script into two 10s parts',
  uploading_image: 'Uploading character image',
  generating_part1: 'Generating part 1 (0-10s)',
  extending_part2: 'Extending to 20s (10-20s)',
  finalizing: 'Finalizing video',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
};

export const REGENERATION_MODES = ['full', 'part2'] as const;
/**
 * - `full`: new generation from scratch with the same (or edited) inputs.
 * - `part2`: keep part 1 (same interaction) and only re-run the 10s extension.
 */
export type RegenerationMode = (typeof REGENERATION_MODES)[number];

export const SEGMENT_SECONDS = 10;
export const TOTAL_SECONDS = 20;
/**
 * Seconds of speech that fit comfortably in one 20s video: each 10s part speaks for about 7.5s so that
 * roughly 2 seconds of silence surround the seam between part 1 and the extension (Omni regenerates the
 * last frames of part 1, and speech crossing the seam tends to get rewritten). About 40 words.
 */
export const SPEAKING_SECONDS = 15;
/** Speaking windows inside each part, in seconds relative to the start of that part. */
export const SPEECH_WINDOWS = {
  part1: { start: 0.5, end: 8 },
  part2: { start: 0.8, end: 8.5 },
} as const;

/** Limits applied to user input (validated on the server, mirrored in the UI). */
export const LIMITS = {
  scriptMinChars: 10,
  scriptMaxChars: 4000,
  extraDirectionsMaxChars: 1000,
  voiceHintMaxChars: 250,
  imageMaxBytes: 10 * 1024 * 1024,
  imageMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as readonly string[],
  /** Comfortable spoken pace for UGC voiceover, used to warn about overlong scripts. */
  wordsPerSecond: 2.6,
} as const;

export interface GenerationSettings {
  style: VideoStyle;
  theme: VideoTheme;
  resolution: Resolution;
  imageMode: ImageMode;
  /** BCP-47 language tag for the spoken dialogue, e.g. `en`, `fr`, `ar`. */
  language: string;
  /** Optional free-form voice direction ("warm, energetic female voice, American accent"). */
  voiceHint: string;
  /** Optional free-form extra directions applied to both parts (setting, props, wardrobe...). */
  extraDirections: string;
  /** Re-send the character image as a reference in the extension turn for stronger identity lock. */
  reinforceCharacterOnExtend: boolean;
  /** Burn in word-by-word captions with the spoken word highlighted in yellow. */
  captions: boolean;
}

export interface SegmentPlan {
  index: 1 | 2;
  startSec: number;
  endSec: number;
  /** Exact words spoken in this part. Empty string when there is no dialogue. */
  dialogue: string;
  /** What the character does and the visual beats of this part. */
  action: string;
  /** Framing and camera behaviour. */
  camera: string;
  /** Optional on-screen caption text. Empty string when none. */
  onScreenText: string;
  /** Final prompt sent to Gemini Omni for this turn. */
  prompt: string;
}

export interface ScriptPlan {
  /** Where the split came from: the LLM splitter, the deterministic fallback, or edited by the user. */
  source: 'llm' | 'fallback' | 'user';
  /** Continuity bible shared by both parts. */
  character: string;
  setting: string;
  voice: string;
  audio: string;
  language: string;
  segments: [SegmentPlan, SegmentPlan];
  warnings: string[];
  /** Estimated seconds needed to speak all dialogue at a natural pace. */
  estimatedSpokenSeconds: number;
}

export interface CostLineItem {
  label: string;
  quantity: number;
  unit: string;
  unitPriceUsd: number;
  amountUsd: number;
}

export interface CostBreakdown {
  currency: 'USD';
  items: CostLineItem[];
  totalUsd: number;
  /** `estimate` is computed before generation, `actual` from reported token usage. */
  basis: 'estimate' | 'actual';
  notes: string[];
}

export interface GenerationError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface GenerationEvent {
  at: string;
  stage: GenerationStage;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface GenerationDTO {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: GenerationStatus;
  stage: GenerationStage;
  /** 0-100 overall progress. */
  progress: number;
  stageStartedAt: string | null;
  /** For failed or canceled generations: the pipeline stage that was active when it stopped. */
  failedStage: GenerationStage | null;
  /** Rough remaining seconds, null when unknown or finished. */
  etaSeconds: number | null;
  title: string;
  script: string;
  settings: GenerationSettings;
  plan: ScriptPlan | null;
  characterImageUrl: string;
  part1VideoUrl: string | null;
  videoUrl: string | null;
  downloadUrl: string | null;
  /** The final video without burned-in captions (null when it has no captions). */
  cleanVideoUrl: string | null;
  cleanDownloadUrl: string | null;
  /** Whether the final video has burned-in captions, and how their timing was found. */
  hasCaptions: boolean;
  captionTiming: 'aligned' | 'estimated' | null;
  /** Captions can be added to (or redone on) the finished video. */
  canAddCaptions: boolean;
  thumbnailUrl: string | null;
  durationSec: number | null;
  /** How the final file was produced: returned whole by the model, or stitched from both parts. */
  assembly: 'model_full' | 'concatenated' | null;
  estimatedCost: CostBreakdown;
  actualCost: CostBreakdown | null;
  error: GenerationError | null;
  parentId: string | null;
  regenerationMode: RegenerationMode | null;
  canRegeneratePart2: boolean;
  canCancel: boolean;
  events: GenerationEvent[];
  startedAt: string | null;
  completedAt: string | null;
}

export interface GenerationListItem {
  id: string;
  createdAt: string;
  status: GenerationStatus;
  stage: GenerationStage;
  progress: number;
  title: string;
  settings: GenerationSettings;
  thumbnailUrl: string | null;
  characterImageUrl: string;
  durationSec: number | null;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  parentId: string | null;
  regenerationMode: RegenerationMode | null;
  error: GenerationError | null;
}

export interface GenerationListResponse {
  items: GenerationListItem[];
  nextCursor: string | null;
}

/** Body of the `payload` field in POST /api/generations (multipart) or JSON body of /api/plan. */
export interface CreateGenerationPayload {
  script: string;
  settings: GenerationSettings;
  /** Optional reviewed/edited split. When omitted the backend splits the script automatically. */
  plan?: ScriptPlan | null;
}

export interface PlanRequest {
  script: string;
  settings: GenerationSettings;
}

export interface RegenerateRequest {
  mode: RegenerationMode;
  /** Only for `full`: optional edits. Omitted fields reuse the source generation's values. */
  script?: string;
  settings?: Partial<GenerationSettings>;
  plan?: ScriptPlan | null;
  /** Only for `part2`: optional replacement prompt/dialogue for the extension. */
  part2?: Partial<Pick<SegmentPlan, 'dialogue' | 'action' | 'camera' | 'onScreenText'>>;
}

export interface EstimateRequest {
  settings: Pick<GenerationSettings, 'resolution'> & Partial<Pick<GenerationSettings, 'reinforceCharacterOnExtend'>>;
  mode?: RegenerationMode;
  /** True when a reviewed split will be sent with the job, so no splitter call is needed. */
  hasPlan?: boolean;
}

export interface PricingInfo {
  /** Omni video output price per second of generated video, by resolution. */
  videoOutputUsdPerSecond: Record<Resolution, number>;
  videoOutputUsdPerMillionTokens: number;
  inputUsdPerMillionTokens: number;
  textOutputUsdPerMillionTokens: number;
  splitterUsdPerCallEstimate: number;
  /** Whether the extension turn is billed for the full returned video or only the new seconds. */
  extensionBilling: 'new_seconds' | 'full_output';
  source: string;
}

export interface AppConfigResponse {
  mock: boolean;
  models: { video: string; splitter: string };
  pricing: PricingInfo;
  defaults: GenerationSettings;
  limits: typeof LIMITS;
  resolutions: readonly Resolution[];
  styles: readonly VideoStyle[];
  themes: readonly VideoTheme[];
  budget: {
    dailyLimitUsd: number | null;
    spentTodayUsd: number;
    reservedUsd: number;
  };
  authRequired: boolean;
}

export interface SessionResponse {
  authenticated: boolean;
  authRequired: boolean;
  user: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const DEFAULT_SETTINGS: GenerationSettings = {
  style: 'ugc',
  theme: 'general',
  resolution: '720p',
  imageMode: 'reference',
  language: 'en',
  voiceHint: '',
  extraDirections: '',
  reinforceCharacterOnExtend: false,
  captions: true,
};

export function isTerminalStatus(status: GenerationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // Treat CJK characters as individual words so pacing estimates stay sane.
  const cjk = trimmed.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g)?.length ?? 0;
  const latin = trimmed
    .replace(/[぀-ヿ㐀-䶿一-鿿가-힯]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return latin + Math.ceil(cjk / 2);
}

export function estimateSpokenSeconds(text: string): number {
  return Math.round((countWords(text) / LIMITS.wordsPerSecond) * 10) / 10;
}
