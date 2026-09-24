/**
 * Normalizes any `ScriptPlan` (LLM output, deterministic fallback or user edits): sanitizes and caps
 * every field, fills empty bible fields from the style defaults, recomputes pacing and warnings, and
 * rebuilds both Omni prompts server-side. Pure and synchronous.
 */
import {
  LIMITS,
  SEGMENT_SECONDS,
  SPEAKING_SECONDS,
  SPEECH_WINDOWS,
  TOTAL_SECONDS,
  estimateSpokenSeconds,
  type GenerationSettings,
  type ScriptPlan,
  type SegmentPlan,
} from '../shared/api.js';
import { buildPart1Prompt, buildPart2Prompt, defaultVoice, STYLE_DEFAULTS } from './prompts.js';
import { cleanText, isEnglish, languageName, normalizeLanguage } from './text.js';

export const FIELD_LIMITS = {
  character: 400,
  setting: 300,
  voice: LIMITS.voiceHintMaxChars,
  audio: 250,
  action: 400,
  camera: 250,
  onScreenText: 100,
  dialogue: LIMITS.scriptMaxChars,
  warning: 300,
  warnings: 8,
} as const;

/** Seconds of speech that fit in each part's speaking window (about 7.5s). */
const PART_WINDOW_SEC = [
  SPEECH_WINDOWS.part1.end - SPEECH_WINDOWS.part1.start,
  SPEECH_WINDOWS.part2.end - SPEECH_WINDOWS.part2.start,
] as const;
/** Words that fit comfortably in `seconds` of speech (39 for the whole 20s video). */
export function wordsThatFit(seconds: number): number {
  return Math.floor(seconds * LIMITS.wordsPerSecond);
}

/** Warnings produced here; stripped from incoming plans before recomputing so they never pile up. */
const COMPUTED_WARNING = [
  /^Script needs about /,
  /^Part [12] dialogue needs about /,
  /^Script is short /,
  /^No dialogue found/,
  /^Speech in .+ is not officially evaluated/,
];

export function sanitizeSettings(settings: GenerationSettings): GenerationSettings {
  return {
    ...settings,
    style: settings.style === 'scientific' ? 'scientific' : 'ugc',
    imageMode: settings.imageMode === 'first_frame' ? 'first_frame' : 'reference',
    language: normalizeLanguage(settings.language),
    voiceHint: cleanText(settings.voiceHint, { max: FIELD_LIMITS.voice }),
    extraDirections: cleanText(settings.extraDirections, { max: LIMITS.extraDirectionsMaxChars }),
    reinforceCharacterOnExtend: Boolean(settings.reinforceCharacterOnExtend),
  };
}

function fmtSec(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Pacing and language warnings for a plan whose dialogue is final. */
export function computePlanWarnings(plan: Pick<ScriptPlan, 'segments' | 'language'>): string[] {
  const warnings: string[] = [];
  const [d1, d2] = [plan.segments[0].dialogue, plan.segments[1].dialogue];
  const total = estimateSpokenSeconds(`${d1} ${d2}`);
  if (total > SPEAKING_SECONDS) {
    const effect =
      total > TOTAL_SECONDS
        ? 'it will not fit and speech will be rushed or cut'
        : 'it may sound rushed near the 10s seam';
    warnings.push(
      `Script needs about ${fmtSec(total)}s of speech but about ${SPEAKING_SECONDS}s fits in a 20s video; ${effect}. Aim for about ${wordsThatFit(SPEAKING_SECONDS)} words.`,
    );
  }
  [d1, d2].forEach((d, i) => {
    const s = estimateSpokenSeconds(d);
    const window = PART_WINDOW_SEC[i] ?? SPEAKING_SECONDS / 2;
    if (s > window) {
      warnings.push(
        `Part ${i + 1} dialogue needs about ${fmtSec(s)}s but its speaking window is about ${fmtSec(window)}s; it may sound rushed. Aim for about ${wordsThatFit(window)} words in this part.`,
      );
    }
  });
  if (total === 0) {
    warnings.push('No dialogue found in the script; the video will have no speech.');
  } else if (total < 5) {
    warnings.push(`Script is short (about ${fmtSec(total)}s of speech) for a 20s video; expect long silent moments.`);
  }
  if (!isEnglish(plan.language)) {
    warnings.push(
      `Speech in ${languageName(plan.language)} is not officially evaluated by Gemini Omni (English is fully supported); pronunciation and lip sync may be less accurate.`,
    );
  }
  return warnings;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function cleanSegment(raw: unknown, index: 1 | 2): Omit<SegmentPlan, 'prompt'> {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    index,
    startSec: index === 1 ? 0 : SEGMENT_SECONDS,
    endSec: index === 1 ? SEGMENT_SECONDS : 2 * SEGMENT_SECONDS,
    dialogue: cleanText(asString(s.dialogue), { max: FIELD_LIMITS.dialogue }),
    action: cleanText(asString(s.action), { max: FIELD_LIMITS.action }),
    camera: cleanText(asString(s.camera), { max: FIELD_LIMITS.camera }),
    onScreenText: cleanText(asString(s.onScreenText), { max: FIELD_LIMITS.onScreenText }),
  };
}

/**
 * Validates and normalizes a plan and rebuilds both prompts from its fields. The dialogue is never
 * rewritten beyond whitespace/control-character cleanup (and em dashes, which become commas).
 */
export function finalizePlan(plan: ScriptPlan, rawSettings: GenerationSettings): ScriptPlan {
  const settings = sanitizeSettings(rawSettings);
  const d = STYLE_DEFAULTS[settings.style];
  const p = (plan && typeof plan === 'object' ? plan : {}) as Partial<ScriptPlan>;
  const segs: unknown[] = Array.isArray(p.segments) ? p.segments : [];
  const language = settings.language;
  const source: ScriptPlan['source'] = p.source === 'llm' || p.source === 'user' ? p.source : 'fallback';

  const segments: [SegmentPlan, SegmentPlan] = [
    { ...cleanSegment(segs[0], 1), prompt: '' },
    { ...cleanSegment(segs[1], 2), prompt: '' },
  ];
  const draft: ScriptPlan = {
    source,
    character: cleanText(p.character, { max: FIELD_LIMITS.character }) || d.character,
    setting: cleanText(p.setting, { max: FIELD_LIMITS.setting }) || d.setting,
    voice:
      cleanText(p.voice, { max: FIELD_LIMITS.voice }) || settings.voiceHint || defaultVoice(settings.style, language),
    audio: cleanText(p.audio, { max: FIELD_LIMITS.audio }) || d.audio,
    language,
    segments,
    warnings: [],
    estimatedSpokenSeconds: estimateSpokenSeconds(`${segments[0].dialogue} ${segments[1].dialogue}`),
  };

  const kept = (Array.isArray(p.warnings) ? p.warnings : [])
    .map((w) => cleanText(w, { max: FIELD_LIMITS.warning }))
    .filter((w) => w && !COMPUTED_WARNING.some((re) => re.test(w)));
  draft.warnings = [...new Set([...computePlanWarnings(draft), ...kept])].slice(0, FIELD_LIMITS.warnings);

  segments[0].prompt = buildPart1Prompt(draft, settings);
  segments[1].prompt = buildPart2Prompt(draft, settings);
  return draft;
}
