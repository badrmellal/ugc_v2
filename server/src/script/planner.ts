/**
 * Script planner: splits ONE 20s script into two coherent 10s Omni turns.
 *
 * The text model (strict JSON schema) writes the continuity bible and the split; the result is
 * validated with zod and checked to keep every spoken word verbatim and in order. Any failure
 * (transport, timeout, invalid JSON, dropped or invented words, a lopsided split) falls back to the
 * deterministic splitter. Both paths end in `finalizePlan`, which rebuilds the prompts server-side.
 */
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { ScriptPlanner, ScriptSplitResult, TextModelClient, UsageInfo } from '../core/ports.js';
import { redactSecrets } from '../pipeline/errors.js';
import { estimateSpokenSeconds, type GenerationSettings, type ScriptPlan } from '../shared/api.js';
import { fallbackPlan, parseScript } from './fallback.js';
import { finalizePlan, sanitizeSettings } from './finalize.js';
import { SPEECH_END_SEC } from './prompts.js';
import { checkVerbatim, cleanText, languageName } from './text.js';

export const SPLIT_TIMEOUT_MS = 45_000;
const SPLIT_TEMPERATURE = 0.4;

export const SCRIPT_START_MARKER = '<<<SCRIPT';
export const SCRIPT_END_MARKER = 'SCRIPT>>>';

/** Recovers the raw script from a planner prompt (used by the mock text model). */
export function extractScriptFromPlannerPrompt(prompt: string): string | null {
  const start = prompt.indexOf(SCRIPT_START_MARKER);
  const end = prompt.lastIndexOf(SCRIPT_END_MARKER);
  if (start < 0 || end <= start) return null;
  return prompt.slice(start + SCRIPT_START_MARKER.length, end).replace(/^\n/, '').replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// Model contract
// ---------------------------------------------------------------------------

const segmentSchema = {
  type: 'object',
  properties: {
    dialogue: {
      type: 'string',
      description: 'Exact words spoken in this part, copied verbatim from the script. Empty string if none.',
    },
    action: {
      type: 'string',
      description:
        'What the person does in this part: a verb phrase without the subject, starting with a lowercase verb, e.g. "holds up the jar and taps the label".',
    },
    camera: { type: 'string', description: 'Framing and camera behaviour for this part.' },
    onScreenText: {
      type: 'string',
      description: 'Short caption only if the script explicitly asks for on-screen text, otherwise an empty string.',
    },
  },
  required: ['dialogue', 'action', 'camera', 'onScreenText'],
} as const;

export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    character: {
      type: 'string',
      description: 'Manner, energy and wardrobe style of the on-camera person. No facial features, age or ethnicity.',
    },
    setting: { type: 'string', description: 'One specific location with lighting and a few props, same for both parts.' },
    voice: { type: 'string', description: 'Specific voice description: timbre, accent, pace and energy.' },
    audio: { type: 'string', description: 'Room tone, ambience and music (music only if the script asks for it).' },
    part1: { ...segmentSchema, description: 'Seconds 0-10.' },
    part2: { ...segmentSchema, description: 'Seconds 10-20, continuing the same shot.' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short notes for the user, e.g. when the script is too long for 20 seconds. Usually empty.',
    },
  },
  required: ['character', 'setting', 'voice', 'audio', 'part1', 'part2', 'warnings'],
};

const text = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v ?? '').slice(0, max));

const LlmSegment = z.object({
  dialogue: text(8000),
  action: text(2000),
  camera: text(1000),
  onScreenText: text(500),
});

const LlmPlan = z.object({
  character: text(2000),
  setting: text(2000),
  voice: text(1000),
  audio: text(1000),
  part1: LlmSegment,
  part2: LlmSegment,
  warnings: z
    .array(z.string())
    .nullish()
    .transform((v) => (v ?? []).slice(0, 3)),
});

export type LlmPlanOutput = z.infer<typeof LlmPlan>;

const STYLE_BRIEF: Record<GenerationSettings['style'], string> = {
  ugc: 'Authentic vertical selfie UGC: phone held at arm\'s length, eye level, natural light, the creator talks directly to the camera like a friend, casual and genuine.',
  scientific:
    'Clear science explainer: a presenter talks directly to the camera with calm, authoritative delivery in a clean lab, studio or classroom look. Simple on-screen labels only if the script asks for them.',
};

export const SPLIT_SYSTEM_INSTRUCTION = [
  'You are an expert short-form video director for vertical UGC ads and science explainers generated with Gemini Omni.',
  'You receive ONE script to be spoken in a single continuous 20 second vertical video with one on-camera person. The video is generated in two 10 second parts: part 1 (0-10s) first, then part 2 (10-20s) extends the same continuous shot. Split the script into two coherent 10 second beats and write a continuity bible shared by both parts.',
  'Rules:',
  '1. Dialogue is sacred. Copy every spoken word verbatim and in the original order. Never paraphrase, summarize, translate, reorder, correct or add words. Never invent new claims, facts, numbers, results or product benefits: accuracy matters, especially for scientific statements.',
  '2. part1.dialogue followed by part2.dialogue must contain all spoken words of the script. Do not drop words. If the script is too long to speak in 20 seconds (about 52 words), still keep it verbatim and add a warning.',
  '3. Split at the most natural point that balances speaking time (about 2.6 words per second). Prefer a sentence boundary; split inside a sentence only at a clause boundary. Each part should need at most about 7.5 seconds of speech.',
  '4. Stage directions are not dialogue: text in [brackets], action cues in (parentheses) such as (smiles), speaker labels such as "Hook:" or "CTA:" and timecodes. Move directions into the action of the part where they occur and drop labels and timecodes.',
  '5. The person\'s face, hair and body come from a reference image you cannot see. In "character" describe only manner, energy and wardrobe style that fit the script, in under 40 words. Do not invent facial features, hair color, skin tone, age, ethnicity or a name.',
  '6. "setting": one specific place with lighting and a few props that fit the script, identical for both parts. "voice": a specific description of timbre, accent, pace and energy, e.g. "a warm, clear voice with a standard American accent, upbeat and friendly". Honor the user\'s voice direction. "audio": room tone and ambience; no music unless the script or the user asks for it.',
  '7. "action": a verb phrase without the subject, starting with a lowercase verb. One continuous shot: no cuts, no new locations, no other people. Part 2 continues naturally from part 1 and ends with a natural closing beat.',
  '8. "camera": framing and movement for that part, consistent with the style and with the other part.',
  '9. "onScreenText": only when the script or the user explicitly asks for on-screen text, otherwise an empty string.',
  '10. Write descriptions in English. Dialogue stays in the language of the script.',
  'Return only JSON that matches the schema.',
].join('\n');

export function buildSplitPrompt(script: string, settings: GenerationSettings): string {
  const s = sanitizeSettings(settings);
  return [
    `Style: ${s.style}. ${STYLE_BRIEF[s.style]}`,
    `Spoken language: ${languageName(s.language)} (${s.language})`,
    `Voice direction from the user: ${s.voiceHint || 'none'}`,
    `Extra directions from the user: ${s.extraDirections || 'none'}`,
    'Script (between the markers):',
    SCRIPT_START_MARKER,
    script.trim(),
    SCRIPT_END_MARKER,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class PlanRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanRejectedError';
  }
}

/** Parses and validates model output against the script. Throws `PlanRejectedError` when unusable. */
export function planFromModelOutput(data: unknown, script: string): Omit<ScriptPlan, 'language' | 'estimatedSpokenSeconds'> {
  const parsed = LlmPlan.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlanRejectedError(`invalid plan JSON (${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown'})`);
  }
  const out = parsed.data;
  const d1 = cleanText(out.part1.dialogue);
  const d2 = cleanText(out.part2.dialogue);
  const speech = parseScript(script).speech;
  const check = checkVerbatim(speech, `${d1} ${d2}`);
  if (!check.ok) {
    throw new PlanRejectedError(
      `dialogue does not keep the script verbatim (${check.missing} missing, ${check.extra} extra of ${check.scriptTokens} words)`,
    );
  }
  const [t1, t2] = [estimateSpokenSeconds(d1), estimateSpokenSeconds(d2)];
  if (t1 + t2 >= 6 && (t1 === 0 || t2 === 0)) {
    throw new PlanRejectedError('one part has no dialogue');
  }
  if (Math.max(t1, t2) > SPEECH_END_SEC && Math.abs(t1 - t2) > 3) {
    throw new PlanRejectedError(`unbalanced split (${t1.toFixed(1)}s / ${t2.toFixed(1)}s)`);
  }
  const segment = (index: 1 | 2, s: LlmPlanOutput['part1']) => ({
    index,
    startSec: index === 1 ? 0 : 10,
    endSec: index === 1 ? 10 : 20,
    dialogue: s.dialogue,
    action: s.action,
    camera: s.camera,
    onScreenText: s.onScreenText,
    prompt: '',
  });
  return {
    source: 'llm',
    character: out.character,
    setting: out.setting,
    voice: out.voice,
    audio: out.audio,
    segments: [segment(1, out.part1), segment(2, out.part2)],
    // Pacing warnings are computed deterministically by finalizePlan; keep only other model notes.
    warnings: out.warnings.filter((w) => !/\b(?:long|short|rushed|pace|pacing|seconds?|words?)\b/i.test(w)),
  };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export interface PlannerOptions {
  /** Timeout of the text model call (default 45s). */
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`text model timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class DefaultScriptPlanner implements ScriptPlanner {
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(
    private readonly text: TextModelClient | null,
    private readonly config: AppConfig,
    logger: Logger,
    opts: PlannerOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? SPLIT_TIMEOUT_MS;
    this.log = logger.child({ component: 'script-planner' });
  }

  /** Cost of a text model call from its usage, or the configured per-call estimate. */
  splitCostUsd(usage: UsageInfo | null): number {
    const p = this.config.pricing;
    const hasCounts = usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined);
    if (!usage || !hasCounts) return p.splitterUsdPerCallEstimate;
    const input = usage.inputTokens ?? 0;
    const output = (usage.textOutputTokens ?? usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0);
    const usd = (input * p.inputUsdPerMillionTokens + output * p.textOutputUsdPerMillionTokens) / 1e6;
    return Math.round(usd * 1e6) / 1e6;
  }

  async split(input: { script: string; settings: GenerationSettings }): Promise<ScriptSplitResult> {
    const settings = sanitizeSettings(input.settings);
    const fallback = (): ScriptPlan => fallbackPlan(input.script, settings);
    if (!this.text) return { plan: fallback(), usage: null, costUsd: 0, model: null };

    let usage: UsageInfo | null = null;
    let responded = false;
    const started = Date.now();
    try {
      const result = await withTimeout(
        this.text.generateJson({
          systemInstruction: SPLIT_SYSTEM_INSTRUCTION,
          prompt: buildSplitPrompt(input.script, settings),
          jsonSchema: PLAN_JSON_SCHEMA,
          temperature: SPLIT_TEMPERATURE,
          timeoutMs: this.timeoutMs,
        }),
        this.timeoutMs + 2_000,
      );
      responded = true;
      usage = result.usage;
      const draft = planFromModelOutput(result.data, input.script);
      const plan = this.finalize({ ...draft, language: settings.language, estimatedSpokenSeconds: 0 }, settings);
      this.log.info(
        { model: this.text.model, ms: Date.now() - started, spokenSec: plan.estimatedSpokenSeconds },
        'script split by text model',
      );
      return { plan, usage, costUsd: this.splitCostUsd(usage), model: this.text.model };
    } catch (err) {
      // Clients may attach the usage of a billed but unusable answer to the error.
      if (!responded && err && typeof err === 'object' && 'usage' in err) {
        const errUsage = (err as { usage?: UsageInfo | null }).usage ?? null;
        if (errUsage) {
          responded = true;
          usage = errUsage;
        }
      }
      const reason = redactSecrets(err instanceof Error ? err.message : String(err), [this.config.gemini.apiKey]);
      this.log.warn(
        { model: this.text.model, ms: Date.now() - started, reason, responded },
        'text model split failed, using deterministic fallback',
      );
      // A call that returned an unusable answer was still billed; a failed call reports no cost.
      return responded
        ? { plan: fallback(), usage, costUsd: this.splitCostUsd(usage), model: this.text.model }
        : { plan: fallback(), usage: null, costUsd: 0, model: null };
    }
  }

  finalize(plan: ScriptPlan, settings: GenerationSettings): ScriptPlan {
    return finalizePlan(plan, settings);
  }
}

export function createPlanner(config: AppConfig, text: TextModelClient | null, logger: Logger): DefaultScriptPlanner {
  return new DefaultScriptPlanner(text, config, logger);
}
