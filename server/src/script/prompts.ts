/**
 * Deterministic builders for the two Omni prompts of a 20s video.
 *
 * Both prompts repeat the same continuity bible (character, setting, voice, audio) verbatim so the
 * extension keeps the same person, place and voice. Part 1 binds the character image with
 * `<IMAGE_REF_0>` (reference) or `<FIRST_FRAME>` (first frame). Part 2 starts with "Extend this
 * video." and uses timecodes that count from the start of the new part (0s = the 10s mark). Speech
 * ends by 8.5s in each part because the last frames of part 1 are regenerated at the seam.
 */
import { estimateSpokenSeconds, type GenerationSettings, type ScriptPlan, type VideoStyle } from '../shared/api.js';
import { isEnglish, languageName, quoteSafe, sentence } from './text.js';

/** Latest point (seconds into a 10s part) by which speech should be finished. */
export const SPEECH_END_SEC = 8.5;
const PART1_SPEECH_START = 1;
const PART2_SPEECH_START = 0.5;

export interface StyleDefaults {
  character: string;
  setting: string;
  voiceEnglish: string;
  voiceOther: (language: string) => string;
  audio: string;
  camera: string;
  action1: string;
  action2: string;
  opening: string;
  closing: string;
}

export const STYLE_DEFAULTS: Record<VideoStyle, StyleDefaults> = {
  ugc: {
    character: 'a relatable content creator with a natural, friendly and confident manner, casual everyday look',
    setting: 'a tidy, lived-in home interior with soft natural window light',
    voiceEnglish: 'a warm, clear, natural voice with a standard American accent, upbeat and conversational',
    voiceOther: (language) => `a warm, clear, natural voice with a native ${language} accent, upbeat and conversational`,
    audio: 'clean close-mic speech with quiet natural room tone',
    camera: "handheld selfie at arm's length, eye level, natural light, subtle natural hand movement",
    action1: 'talks straight to the camera with natural expressions and small hand gestures',
    action2: 'keeps talking to the camera with the same energy and natural gestures',
    opening: 'looks straight into the lens with a natural, engaged expression',
    closing: 'finishes speaking and ends with a warm, genuine smile at the camera',
  },
  scientific: {
    character: 'a knowledgeable science presenter with a calm, clear and trustworthy manner, neat professional look',
    setting: 'a clean, bright modern lab with soft even lighting and a simple uncluttered background',
    voiceEnglish: 'a calm, clear, confident voice with a standard American accent, measured and authoritative',
    voiceOther: (language) => `a calm, clear, confident voice with a native ${language} accent, measured and authoritative`,
    audio: 'crisp, clean studio speech with quiet room tone',
    camera: 'steady medium close-up at eye level, presenter centered and facing the camera',
    action1: 'explains to the camera with calm, open hand gestures',
    action2: 'continues explaining to the camera with measured, precise gestures',
    opening: 'faces the camera with a calm, confident expression',
    closing: 'finishes speaking and ends with a small confident nod to the camera',
  },
};

export function defaultVoice(style: VideoStyle, language: string): string {
  const d = STYLE_DEFAULTS[style];
  return isEnglish(language) ? d.voiceEnglish : d.voiceOther(languageName(language));
}

/** Formats a timecode value: 8.5 -> "8.5", 6 -> "6". */
function tc(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Speech window for a part: long enough for the words, never past `SPEECH_END_SEC`. */
export function speechWindow(dialogue: string, start: number): [number, number] {
  const need = estimateSpokenSeconds(dialogue) * 1.1 + 0.5;
  const end = Math.round(Math.min(SPEECH_END_SEC, Math.max(start + 2, start + need)) * 2) / 2;
  return [start, Math.min(end, SPEECH_END_SEC)];
}

function mentionsMusic(audio: string): boolean {
  return /\bmusic|\bbeat\b|\bsoundtrack|\bsong\b|\bjingle/i.test(audio) && !/\bno (?:background )?music/i.test(audio);
}

function audioLine(plan: ScriptPlan, continuing: boolean): string {
  const parts = [`Audio: ${sentence(plan.audio)}`];
  if (continuing) parts.push('The same ambience continues.');
  if (!mentionsMusic(plan.audio)) parts.push('No background music.');
  parts.push('No extra sound effects.');
  return parts.join(' ');
}

function textLine(onScreenText: string, style: VideoStyle): string {
  if (!onScreenText) return 'No text overlay on screen.';
  const where = style === 'scientific' ? 'a clean, simple label' : 'a simple, clean caption';
  return `On-screen text: ${where} reading "${quoteSafe(onScreenText)}" in the lower third, no other text on screen.`;
}

function languageLine(language: string, subject: string): string | null {
  if (isEnglish(language)) return null;
  return `${subject} speaks ${languageName(language)}.`;
}

function header(style: VideoStyle): string {
  return style === 'scientific'
    ? 'Vertical 9:16 science explainer video in one continuous, unbroken shot, no scene cuts.'
    : 'Vertical 9:16 UGC selfie video in one continuous, unbroken handheld shot, no scene cuts.';
}

function extraLine(settings: GenerationSettings): string | null {
  const extra = settings.extraDirections.trim();
  return extra ? `Additional directions: ${sentence(extra)}` : null;
}

/** Lowercases a leading article so a description reads naturally after "the person in <IMAGE_REF_0>,". */
function descriptor(text: string): string {
  const t = sentence(text);
  return /^(?:A|An|The|This|Their|Her|His)\s/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/**
 * Joins the subject with an action. Verb phrases ("holds up the jar") read "The person holds up the
 * jar."; anything else ("Close-up of the jar") is kept as its own sentence.
 */
function actionSentence(subject: string, action: string): string {
  const a = action.trim().replace(/[.!?\s]+$/, '');
  if (!a) return '';
  const first = a.split(/\s+/)[0] ?? '';
  if (/^\p{Ll}/u.test(a) || /^[A-Z][a-z]+(?:s|es)$/.test(first)) {
    return `${subject} ${a.charAt(0).toLowerCase()}${a.slice(1)}.`;
  }
  return sentence(a);
}

function subjectNoun(style: VideoStyle): string {
  return style === 'scientific' ? 'presenter' : 'person';
}

/** Prompt for part 1 (0-10s), sent with the character image. */
export function buildPart1Prompt(plan: ScriptPlan, settings: GenerationSettings): string {
  const style = settings.style;
  const d = STYLE_DEFAULTS[style];
  const seg = plan.segments[0];
  const noun = subjectNoun(style);
  const firstFrame = settings.imageMode === 'first_frame';
  const ref = firstFrame ? 'the first frame' : '<IMAGE_REF_0>';
  const subject = `The ${noun}`;

  const lines: (string | null)[] = [
    firstFrame ? `<FIRST_FRAME> ${header(style)} The video starts exactly from this frame.` : header(style),
    `Character: the ${noun} in ${ref}, ${descriptor(plan.character)} Keep the face, hair and outfit exactly as in ${ref}.`,
    `Setting: ${sentence(plan.setting)}`,
    `Camera: ${sentence(seg.camera || d.camera)}`,
  ];
  if (seg.dialogue || plan.segments[1].dialogue) lines.push(`Voice: ${sentence(plan.voice)}`);
  lines.push(languageLine(plan.language, subject));

  const action = actionSentence(subject, seg.action || d.action1);
  if (seg.dialogue) {
    const [start, end] = speechWindow(seg.dialogue, PART1_SPEECH_START);
    const speaker = firstFrame ? subject : `The ${noun} in <IMAGE_REF_0>`;
    lines.push(`[0-${tc(start)}s] ${subject} ${d.opening}.`);
    lines.push(`[${tc(start)}-${tc(end)}s] ${action} ${speaker} says: "${quoteSafe(seg.dialogue)}"`);
    lines.push(
      `[${tc(end)}-10s] ${subject} finishes the sentence and holds a natural pause with relaxed eye contact, ready to continue.`,
    );
  } else {
    lines.push(`[0-10s] ${action} No dialogue.`);
  }
  lines.push(audioLine(plan, false), textLine(seg.onScreenText, style), extraLine(settings));
  return lines.filter((l): l is string => Boolean(l)).join('\n');
}

/** Prompt for part 2 (10-20s), sent with `previous_interaction_id` of part 1. */
export function buildPart2Prompt(plan: ScriptPlan, settings: GenerationSettings): string {
  const style = settings.style;
  const d = STYLE_DEFAULTS[style];
  const seg = plan.segments[1];
  const noun = subjectNoun(style);
  const subject = `The ${noun}`;
  const shot = style === 'scientific' ? 'shot' : 'handheld selfie shot';

  const lines: (string | null)[] = [
    `Extend this video. Continue the same single continuous ${shot} from the last frame, no scene cuts.`,
    `Same ${noun}, same outfit, same location and lighting, same voice.`,
  ];
  if (settings.reinforceCharacterOnExtend) {
    lines.push(`The ${noun} is the same person shown in <IMAGE_REF_0>; keep the face, hair and outfit exactly as in <IMAGE_REF_0>.`);
  }
  lines.push(
    `Character: the same ${noun}, ${descriptor(plan.character)}`,
    `Setting: ${sentence(plan.setting)}`,
    `Camera: ${sentence(seg.camera || d.camera)}`,
  );
  if (seg.dialogue || plan.segments[0].dialogue) lines.push(`Voice: ${sentence(plan.voice)}`);
  lines.push(languageLine(plan.language, subject));

  const action = actionSentence(subject, seg.action || d.action2);
  if (seg.dialogue) {
    const [start, end] = speechWindow(seg.dialogue, PART2_SPEECH_START);
    lines.push(`[0-${tc(start)}s] ${subject} continues naturally from the previous moment.`);
    lines.push(`[${tc(start)}-${tc(end)}s] ${action} ${subject} says: "${quoteSafe(seg.dialogue)}"`);
    lines.push(`[${tc(end)}-10s] ${subject} ${d.closing}.`);
  } else {
    lines.push(`[0-10s] ${action} At the end the ${noun} ${d.closing.replace(/^finishes speaking and /, '')}. No dialogue.`);
  }
  lines.push(audioLine(plan, true), textLine(seg.onScreenText, style), extraLine(settings));
  return lines.filter((l): l is string => Boolean(l)).join('\n');
}
