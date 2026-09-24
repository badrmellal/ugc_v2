/**
 * Deterministic script splitter, used when the text model is unavailable or returns something that
 * does not keep the script verbatim.
 *
 * 1. Parse the script into spoken text and stage directions (`[...]`, `(...)` cues, speaker labels).
 * 2. Split spoken text into sentences (., !, ?, ellipses, newlines, quotes, abbreviations, CJK).
 * 3. Pick the split point that best balances estimated speaking time between the two 10s parts,
 *    preferring sentence boundaries, then clause boundaries, then word boundaries.
 */
import { themedDefaults } from './themes.js';
import { countWords, LIMITS, type GenerationSettings, type ScriptPlan } from '../shared/api.js';
import { finalizePlan, sanitizeSettings } from './finalize.js';
import { defaultVoice, STYLE_DEFAULTS } from './prompts.js';
import { CJK_CHAR, cleanText } from './text.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ScriptUnit =
  | { type: 'speech'; text: string; /** Ends with sentence punctuation or a line break. */ endsSentence: boolean }
  | { type: 'direction'; text: string };

export interface ParsedScript {
  units: ScriptUnit[];
  /** All spoken text joined in order (directions and labels removed). */
  speech: string;
  directions: string[];
}

const LABEL =
  /^(?:hook|intro|introduction|body|main|cta|call to action|outro|close|closing|ending|scene\s*\d+|shot\s*\d+|part\s*\d+|beat\s*\d+|line\s*\d+|vo|v\.o\.|voice ?over|narrator|narration|speaker|creator|host|presenter|talent|dialogue|script|audio)\s*(?:\([^)]{0,30}\))?\s*[:-]\s*/i;
const CAPS_LABEL = /^[A-Z][A-Z0-9 ]{1,24}:\s+/;
const HEADING_ONLY = /^(?:scene|shot|part|beat)\s*\d+\s*:?$/i;
const TIMECODE_ONLY =
  /^\s*(?:\d{1,2}:)?\d{1,2}(?:\.\d+)?\s*s?\s*(?:-|\u2013|to)\s*(?:\d{1,2}:)?\d{1,2}(?:\.\d+)?\s*s?\s*$/i;
/** Leading timecodes such as "0:00-0:05" or "0-3s:" (a unit or colon is required so numbers in speech survive). */
const TIMECODE_PREFIX =
  /^(?:\d{1,2}:\d{2}\s*(?:-|\u2013)\s*\d{1,2}:\d{2}|\d{1,2}(?:\.\d)?s?\s*(?:-|\u2013)\s*\d{1,2}(?:\.\d)?s)\s*[:-]?\s+/i;
const DIRECTION_CUE =
  /^(?:smil|laugh|chuckl|giggl|paus|beat\b|hold|point|show|pick|lift|rais|turn|look|lean|nod|shrug|gestur|wink|sigh|gasp|whisper|excited|sarcastic|soft|cut\b|b-?roll|on[- ]?screen|text\b|caption|sfx|sound|music|zoom|close[- ]?up|camera|tap|sip|drink|appl|open|walk|sit|stand|wave|clap|hand|to camera|tone|holds?\b|reveal|demonstrat|puts?\b|places?\b|grabs?\b|touch|shak|squeez|pour|spray|rub|mix|stir|writ|draw|visual|graphic|shot\b|scene\b)/i;
/** Leading pronoun subject of a cue such as "she leans in" (the prompt supplies the subject). */
const CUE_PRONOUN = /^(?:she|he|they|i|we)\s+(?=\p{L})/iu;
const ON_SCREEN =
  /^(?:on[- ]?screen(?:\s+text)?|text(?:\s+on\s+screen)?|caption|title|super|lower third)\s*[:-]\s*(.+)$/i;

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  const m = /^["\u201C](.*)["\u201D]$/s.exec(t);
  if (m && !/["\u201C\u201D]/.test(m[1] ?? '')) return m[1]!.trim();
  return t;
}

/** "(she leans in)", "(he laughs)": a third-person pronoun followed by a present-tense verb. */
const PRONOUN_CUE = /^(?:she|he|they|we)\s+\p{L}+(?:s|ing)\b/iu;

export interface ParseOptions {
  /** Treat every inline `(...)` as a stage direction (used to double-check model output). */
  allParenthesesAreDirections?: boolean;
}

function isDirectionText(inner: string, wholeLine: boolean, opts: ParseOptions): boolean {
  if (wholeLine || opts.allParenthesesAreDirections) return true;
  const t = inner.trim();
  return DIRECTION_CUE.test(t) || PRONOUN_CUE.test(t);
}

function pushSpeech(units: ScriptUnit[], text: string, endsSentence: boolean) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return;
  units.push({ type: 'speech', text: t, endsSentence });
}

function pushDirection(units: ScriptUnit[], text: string) {
  const t = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s:,-]+|[\s:,-]+$/g, '');
  if (!t || TIMECODE_ONLY.test(t)) return;
  units.push({ type: 'direction', text: t });
}

/** Splits a line into speech and inline direction pieces (`[...]` always, `(...)` when it reads like a cue). */
function parseLine(line: string, units: ScriptUnit[], nextLineContinues: boolean, opts: ParseOptions) {
  const whole = line.trim();
  const bracketed = /^\[(.*)\]$/s.exec(whole) ?? /^\((.*)\)$/s.exec(whole);
  if (bracketed && !/[[\]()]/.test(bracketed[1] ?? '')) {
    pushDirection(units, bracketed[1] ?? '');
    return;
  }
  const re = /\[([^\]]*)\]|\(([^)]*)\)/g;
  let last = 0;
  const pieces: ScriptUnit[] = [];
  for (let m = re.exec(whole); m; m = re.exec(whole)) {
    const square = m[1] !== undefined;
    const inner = (square ? m[1] : m[2]) ?? '';
    const atStart = whole.slice(0, m.index).trim() === '';
    if (!square && !isDirectionText(inner, atStart && m[0].length === whole.length, opts)) continue;
    pushSpeech(pieces, whole.slice(last, m.index), false);
    pushDirection(pieces, inner);
    last = m.index + m[0].length;
  }
  pushSpeech(pieces, whole.slice(last), false);
  // The last speech piece of a line ends a sentence unless the next line clearly continues it.
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i]!;
    if (p.type === 'speech') {
      p.endsSentence = !nextLineContinues || /[.!?\u2026\u3002\uFF01\uFF1F]["'\u201D\u2019)]*$/.test(p.text);
      break;
    }
  }
  units.push(...pieces);
}

export function parseScript(script: string, opts: ParseOptions = {}): ParsedScript {
  const text = stripOuterQuotes(cleanText(script, { multiline: true }));
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !HEADING_ONLY.test(l) && !TIMECODE_ONLY.test(l));
  const units: ScriptUnit[] = [];
  lines.forEach((raw, i) => {
    let line = raw.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '');
    line = line.replace(TIMECODE_PREFIX, '').replace(LABEL, '').replace(CAPS_LABEL, '');
    line = stripOuterQuotes(line);
    const next = lines[i + 1] ?? '';
    const continues = /[,;:]$/.test(line) || /^\p{Ll}/u.test(next);
    parseLine(line, units, continues, opts);
  });
  // Split each speech unit into sentences.
  const out: ScriptUnit[] = [];
  for (const u of units) {
    if (u.type === 'direction') {
      out.push(u);
      continue;
    }
    const sentences = splitSentences(u.text);
    sentences.forEach((s, i) => {
      const last = i === sentences.length - 1;
      out.push({ type: 'speech', text: s, endsSentence: last ? u.endsSentence || endsWithTerminal(s) : true });
    });
  }
  const speechUnits = out.filter((u) => u.type === 'speech');
  return {
    units: out,
    speech: joinSpeech(speechUnits.map((u) => u.text)),
    directions: out.filter((u) => u.type === 'direction').map((u) => u.text),
  };
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'eg',
  'ie',
  'approx',
  'fig',
  'figs',
  'inc',
  'ltd',
  'dept',
  'vol',
  'u.s',
  'u.k',
  'a.m',
  'p.m',
  'ca',
  'cf',
  'al',
]);
const LATIN_TERMINATORS = '.!?\u2026';
const CJK_TERMINATORS = '\u3002\uFF01\uFF1F';
const CLOSERS = '"\')]}\u201D\u2019\u00BB\u300D\u300F\uFF09';

function endsWithTerminal(s: string): boolean {
  return /[.!?\u2026\u3002\uFF01\uFF1F]["'\u201D\u2019)\u300D\u300F\uFF09]*$/.test(s.trim());
}

function isLatinBoundary(text: string, sentenceStart: number, punctStart: number, punct: string, after: number) {
  const rest = text.slice(after).trimStart();
  if (!rest) return true;
  const next = rest.charAt(0);
  if (punct === '.') {
    const word = /([\p{L}.]+)$/u.exec(text.slice(sentenceStart, punctStart))?.[1] ?? '';
    const lower = word.toLowerCase();
    if (ABBREVIATIONS.has(lower)) return false;
    if (lower === 'no' && /^\d/.test(next)) return false;
    // Initials such as "J. K. Rowling" (but not "vitamin C." or "I.").
    if (/^\p{Lu}$/u.test(word) && word !== 'I') {
      const before = text.slice(sentenceStart, punctStart - 1);
      if (/(?:^|\s)\p{Lu}\.\s*$/u.test(before) || /^\p{Lu}\.(?:\s|$)/u.test(rest)) return false;
    }
  }
  // "etc. and", "e.g. vitamin", "so... what": a lowercase continuation is not a new sentence.
  if (/^[.\u2026]+$/.test(punct) && /^\p{Ll}/u.test(next)) return false;
  return true;
}

/** Splits text into sentences. Keeps punctuation and closing quotes with the sentence. */
export function splitSentences(input: string): string[] {
  const text = input.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const s = text.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  };
  while (i < text.length) {
    const ch = text.charAt(i);
    if (CJK_TERMINATORS.includes(ch)) {
      let j = i + 1;
      while (j < text.length && (CJK_TERMINATORS.includes(text.charAt(j)) || CLOSERS.includes(text.charAt(j)))) j++;
      push(j);
      i = j;
      continue;
    }
    if (LATIN_TERMINATORS.includes(ch)) {
      let j = i + 1;
      while (j < text.length && LATIN_TERMINATORS.includes(text.charAt(j))) j++;
      const punct = text.slice(i, j);
      while (j < text.length && CLOSERS.includes(text.charAt(j))) j++;
      if (j >= text.length || /\s/.test(text.charAt(j))) {
        if (isLatinBoundary(text, start, i, punct, j)) push(j);
      }
      i = j;
      continue;
    }
    i++;
  }
  push(text.length);
  return out;
}

// ---------------------------------------------------------------------------
// Split point selection
// ---------------------------------------------------------------------------

/** Extra cost, in seconds of imbalance, of splitting at each boundary level. */
const PENALTY = { sentence: 0, soft: 0.6, clause: 1, word: 2.5 } as const;

export interface SplitResult {
  part1: { dialogue: string; directions: string[] };
  part2: { dialogue: string; directions: string[] };
  level: keyof typeof PENALTY | 'none';
}

const CJK_PUNCT = /[\u3001\u3002\uFF01\uFF0C\uFF1A\uFF1B\uFF1F\u300C\u300D\u300E\u300F]/;

function isCjkEdge(ch: string): boolean {
  return CJK_CHAR.test(ch) || CJK_PUNCT.test(ch);
}

/** Joins speech pieces with spaces, except between CJK characters/punctuation. */
function joinSpeech(pieces: string[]): string {
  let out = '';
  for (const p of pieces) {
    const t = p.trim();
    if (!t) continue;
    if (!out) out = t;
    else out += isCjkEdge(out.charAt(out.length - 1)) && isCjkEdge(t.charAt(0)) ? t : ` ${t}`;
  }
  return out;
}

function seconds(text: string): number {
  return countWords(text) / LIMITS.wordsPerSecond;
}

/** Same CJK ranges as `countWords` in the shared contract (two CJK characters count as one word). */
const COUNT_CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

/**
 * Word counts of every prefix of `text` (index i = words in `text.slice(0, i)`), computed in one pass
 * so scoring every boundary of a long sentence stays linear. Matches `countWords` up to CJK rounding.
 */
function prefixWords(text: string): Float64Array {
  const out = new Float64Array(text.length + 1);
  let latin = 0;
  let cjk = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (COUNT_CJK.test(ch)) {
      cjk += 1;
      inWord = false;
    } else if (/\s/.test(ch)) {
      inWord = false;
    } else if (!inWord) {
      latin += 1;
      inWord = true;
    }
    out[i + 1] = latin + cjk / 2;
  }
  return out;
}

interface Candidate {
  /** Unit index where the split happens. */
  unit: number;
  /** Character offset inside that unit (0 = before the unit). */
  offset: number;
  cost: number;
  level: keyof typeof PENALTY;
}

/** Clause (after , ; : or CJK commas, before a spaced dash) and word boundaries inside a sentence. */
function intraBoundaries(text: string): { offset: number; level: 'clause' | 'word' }[] {
  const out: { offset: number; level: 'clause' | 'word' }[] = [];
  for (let i = 1; i < text.length; i++) {
    const prev = text.charAt(i - 1);
    const ch = text.charAt(i);
    if (/\s/.test(ch)) {
      if (/[,;:]/.test(prev) || /^\s[-\u2013]\s/.test(text.slice(i, i + 3))) out.push({ offset: i, level: 'clause' });
      else if (!/\s/.test(prev)) out.push({ offset: i, level: 'word' });
    } else if (/[\u3001\uFF0C\uFF1B\uFF1A]/.test(prev) && !CLOSERS.includes(ch)) {
      out.push({ offset: i, level: 'clause' });
    } else if (CJK_CHAR.test(prev) && CJK_CHAR.test(ch)) {
      out.push({ offset: i, level: 'word' });
    }
  }
  return out;
}

/** Chooses where to split the script into two parts of balanced speaking time. */
export function chooseSplit(units: ScriptUnit[]): SplitResult {
  const speechIdx = units.map((u, i) => (u.type === 'speech' ? i : -1)).filter((i) => i >= 0);
  const collect = (from: number, to: number, headText?: string, tailText?: string) => {
    const dialogue: string[] = [];
    const directions: string[] = [];
    if (tailText !== undefined) dialogue.push(tailText);
    for (let i = from; i < to; i++) {
      const u = units[i]!;
      if (u.type === 'speech') dialogue.push(u.text);
      else directions.push(u.text);
    }
    if (headText !== undefined) dialogue.push(headText);
    return { dialogue: joinSpeech(dialogue), directions };
  };

  const totalSec = speechIdx.reduce((s, i) => s + seconds(units[i]!.text), 0);
  const totalWords = speechIdx.reduce((s, i) => s + countWords(units[i]!.text), 0);
  if (speechIdx.length === 0 || totalWords < 12) {
    // Nothing (or too little) to split: keep all speech in part 1, later directions go to part 2.
    const cut = speechIdx.length ? speechIdx[speechIdx.length - 1]! + 1 : Math.ceil(units.length / 2);
    return { part1: collect(0, cut), part2: collect(cut, units.length), level: 'none' };
  }

  // Prefix speaking time before each unit.
  const before: number[] = [];
  let acc = 0;
  units.forEach((u, i) => {
    before[i] = acc;
    if (u.type === 'speech') acc += seconds(u.text);
  });

  let best: Candidate | null = null;
  const consider = (c: Candidate) => {
    if (!best || c.cost < best.cost - 1e-9) best = c;
  };
  for (let i = 1; i < units.length; i++) {
    const left = before[i]!;
    if (left <= 0 || left >= totalSec) continue;
    // The nearest speech unit before this boundary decides whether it is a sentence boundary.
    let prevSpeech: ScriptUnit | undefined;
    for (let k = i - 1; k >= 0; k--) {
      if (units[k]!.type === 'speech') {
        prevSpeech = units[k];
        break;
      }
    }
    const level = prevSpeech && prevSpeech.type === 'speech' && prevSpeech.endsSentence ? 'sentence' : 'soft';
    consider({ unit: i, offset: 0, cost: Math.abs(totalSec - 2 * left) + PENALTY[level], level });
  }
  for (const i of speechIdx) {
    const u = units[i] as Extract<ScriptUnit, { type: 'speech' }>;
    const words = prefixWords(u.text);
    const unitWords = words[u.text.length] ?? 0;
    for (const b of intraBoundaries(u.text)) {
      const headWords = words[b.offset] ?? 0;
      if (headWords <= 0 || unitWords - headWords <= 0) continue;
      const left = before[i]! + headWords / LIMITS.wordsPerSecond;
      consider({ unit: i, offset: b.offset, cost: Math.abs(totalSec - 2 * left) + PENALTY[b.level], level: b.level });
    }
  }

  const chosen = best as Candidate | null;
  if (!chosen) {
    return { part1: collect(0, units.length), part2: { dialogue: '', directions: [] }, level: 'none' };
  }
  if (chosen.offset === 0) {
    return { part1: collect(0, chosen.unit), part2: collect(chosen.unit, units.length), level: chosen.level };
  }
  const u = units[chosen.unit] as Extract<ScriptUnit, { type: 'speech' }>;
  const head = u.text.slice(0, chosen.offset).trim();
  const tail = u.text.slice(chosen.offset).trim();
  return {
    part1: collect(0, chosen.unit, head),
    part2: collect(chosen.unit + 1, units.length, undefined, tail),
    level: chosen.level,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function directionsToSegment(directions: string[]): { action: string; onScreenText: string; audio: string[] } {
  const actions: string[] = [];
  const texts: string[] = [];
  const audio: string[] = [];
  for (const d of directions) {
    const onScreen = ON_SCREEN.exec(d);
    if (onScreen) {
      texts.push((onScreen[1] ?? '').replace(/^["'\u201C\u2018]|["'\u201D\u2019]$/g, '').trim());
    } else if (/\bmusic\b|\bsfx\b|sound effect/i.test(d)) {
      audio.push(d);
    } else {
      const action = d.replace(/[.\s]+$/, '').replace(CUE_PRONOUN, '');
      if (action) actions.push(action);
    }
  }
  return { action: actions.join('; '), onScreenText: texts.filter(Boolean).join(' / '), audio };
}

/** Deterministic split of a script into a finalized two-part plan (`source: 'fallback'`). */
export function fallbackPlan(script: string, rawSettings: GenerationSettings): ScriptPlan {
  const settings = sanitizeSettings(rawSettings);
  const d = themedDefaults(STYLE_DEFAULTS[settings.style], settings);
  const parsed = parseScript(script);
  const split = chooseSplit(parsed.units);
  const s1 = directionsToSegment(split.part1.directions);
  const s2 = directionsToSegment(split.part2.directions);
  const audioCues = [...s1.audio, ...s2.audio];
  const plan: ScriptPlan = {
    source: 'fallback',
    character: d.character,
    setting: d.setting,
    voice: settings.voiceHint || defaultVoice(settings.style, settings.language),
    audio: audioCues.length ? `${d.audio}, with ${audioCues.join(', ').toLowerCase()}` : d.audio,
    language: settings.language,
    segments: [
      {
        index: 1,
        startSec: 0,
        endSec: 10,
        dialogue: split.part1.dialogue,
        action: s1.action,
        camera: d.camera,
        onScreenText: s1.onScreenText,
        prompt: '',
      },
      {
        index: 2,
        startSec: 10,
        endSec: 20,
        dialogue: split.part2.dialogue,
        action: s2.action,
        camera: d.camera,
        onScreenText: s2.onScreenText,
        prompt: '',
      },
    ],
    warnings: [],
    estimatedSpokenSeconds: 0,
  };
  return finalizePlan(plan, settings);
}
