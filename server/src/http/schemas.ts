/**
 * Request validation. The schemas mirror the types in shared/api.ts; every string is bounded and
 * stripped of control characters (Postgres rejects NUL bytes in text columns).
 */
import { z } from 'zod';
import {
  DEFAULT_SETTINGS,
  GENERATION_STATUSES,
  IMAGE_MODES,
  LIMITS,
  REGENERATION_MODES,
  RESOLUTIONS,
  VIDEO_STYLES,
  VIDEO_THEMES,
  type GenerationSettings,
  type ScriptPlan,
} from '../shared/api.js';

/**
 * Removes C0 control characters except tab, line feed and carriage return, DEL, and unpaired UTF-16
 * surrogates. Postgres rejects NUL in text and both NUL and lone surrogates in jsonb, so without this
 * a single stray character in a script or setting would fail the insert with a 500.
 */
export function stripControlChars(value: string): string {
  let out = '';
  // Iterating by code point yields a paired surrogate as one character and a lone one on its own.
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) continue;
    if (c >= 0xd800 && c <= 0xdfff) continue;
    out += ch;
  }
  return out;
}

/** Bounded free text; trimmed and cleaned. */
const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((s) => stripControlChars(s).trim())
    .pipe(z.string().max(max));

/** Cleaned but untrimmed text (content that is rebuilt or only displayed, never trusted). */
const cleanString = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => stripControlChars(s));

/** Field-level text limit for plan fields (a single part can never be longer than the script). */
const PLAN_TEXT_MAX = LIMITS.scriptMaxChars;
/** Prompts are rebuilt server-side; the client copy is only bounded, never trusted. */
const PROMPT_MAX = 20_000;

export const languageSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/, 'Use a BCP-47 language tag such as en, fr, pt-BR');

export const scriptSchema = text(LIMITS.scriptMaxChars).pipe(
  z
    .string()
    .min(LIMITS.scriptMinChars, `The script must be at least ${LIMITS.scriptMinChars} characters.`)
    .max(LIMITS.scriptMaxChars, `The script must be at most ${LIMITS.scriptMaxChars} characters.`),
);

const settingsFields = {
  style: z.enum(VIDEO_STYLES),
  theme: z.enum(VIDEO_THEMES),
  resolution: z.enum(RESOLUTIONS),
  imageMode: z.enum(IMAGE_MODES),
  language: languageSchema,
  voiceHint: text(LIMITS.voiceHintMaxChars),
  extraDirections: text(LIMITS.extraDirectionsMaxChars),
  reinforceCharacterOnExtend: z.boolean(),
};

/** Full settings; omitted fields fall back to DEFAULT_SETTINGS (convenient for API clients). */
export const settingsSchema = z
  .object({
    style: settingsFields.style.default(DEFAULT_SETTINGS.style),
    theme: settingsFields.theme.default(DEFAULT_SETTINGS.theme),
    resolution: settingsFields.resolution.default(DEFAULT_SETTINGS.resolution),
    imageMode: settingsFields.imageMode.default(DEFAULT_SETTINGS.imageMode),
    language: settingsFields.language.default(DEFAULT_SETTINGS.language),
    voiceHint: settingsFields.voiceHint.default(DEFAULT_SETTINGS.voiceHint),
    extraDirections: settingsFields.extraDirections.default(DEFAULT_SETTINGS.extraDirections),
    reinforceCharacterOnExtend: settingsFields.reinforceCharacterOnExtend.default(
      DEFAULT_SETTINGS.reinforceCharacterOnExtend,
    ),
  })
  .default({ ...DEFAULT_SETTINGS }) satisfies z.ZodType<GenerationSettings, unknown>;

/** Partial settings for regeneration edits: omitted fields keep the source generation's values. */
export const settingsPatchSchema = z.object({
  style: settingsFields.style.optional(),
  theme: settingsFields.theme.optional(),
  resolution: settingsFields.resolution.optional(),
  imageMode: settingsFields.imageMode.optional(),
  language: settingsFields.language.optional(),
  voiceHint: settingsFields.voiceHint.optional(),
  extraDirections: settingsFields.extraDirections.optional(),
  reinforceCharacterOnExtend: settingsFields.reinforceCharacterOnExtend.optional(),
});

const segmentSchema = <I extends 1 | 2>(index: I) =>
  z.object({
    index: z.literal(index),
    startSec: z
      .number()
      .min(0)
      .max(20)
      .default(index === 1 ? 0 : 10),
    endSec: z
      .number()
      .min(0)
      .max(20)
      .default(index === 1 ? 10 : 20),
    dialogue: text(PLAN_TEXT_MAX).default(''),
    action: text(PLAN_TEXT_MAX).default(''),
    camera: text(PLAN_TEXT_MAX).default(''),
    onScreenText: text(PLAN_TEXT_MAX).default(''),
    prompt: cleanString(PROMPT_MAX).default(''),
  });

/** A user-provided (reviewed or edited) plan. The server re-finalizes it before use. */
export const planSchema = z.object({
  source: z.enum(['llm', 'fallback', 'user']).default('user'),
  // Empty bible fields are filled with style defaults by the planner's finalize().
  character: text(PLAN_TEXT_MAX).default(''),
  setting: text(PLAN_TEXT_MAX).default(''),
  voice: text(PLAN_TEXT_MAX).default(''),
  audio: text(PLAN_TEXT_MAX).default(''),
  language: languageSchema,
  segments: z.tuple([segmentSchema(1), segmentSchema(2)]),
  warnings: z.array(cleanString(1000)).max(50).default([]),
  estimatedSpokenSeconds: z.number().min(0).max(10_000).default(0),
}) satisfies z.ZodType<ScriptPlan, unknown>;

export const createGenerationPayloadSchema = z.object({
  script: scriptSchema,
  settings: settingsSchema,
  plan: planSchema.nullable().optional(),
});

export const planRequestSchema = z.object({
  script: scriptSchema,
  settings: settingsSchema,
});

export const estimateRequestSchema = z.object({
  settings: z.object({
    resolution: z.enum(RESOLUTIONS),
    reinforceCharacterOnExtend: z.boolean().optional(),
  }),
  mode: z.enum(REGENERATION_MODES).optional(),
  /** A reviewed split will be sent, so the backend does not need to call the splitter. */
  hasPlan: z.boolean().optional(),
});

export const regenerateRequestSchema = z.object({
  mode: z.enum(REGENERATION_MODES),
  script: scriptSchema.optional(),
  settings: settingsPatchSchema.optional(),
  plan: planSchema.nullable().optional(),
  part2: z
    .object({
      dialogue: text(PLAN_TEXT_MAX).optional(),
      action: text(PLAN_TEXT_MAX).optional(),
      camera: text(PLAN_TEXT_MAX).optional(),
      onScreenText: text(PLAN_TEXT_MAX).optional(),
    })
    .optional(),
});

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(512).optional(),
  status: z.enum(GENERATION_STATUSES).optional(),
});

export const loginSchema = z.object({
  password: z.string().min(1, 'Enter the password.').max(1024),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
