/**
 * Spoken-length estimate for scripts, used by the pacing meters.
 *
 * A 20s video does not have 20s of speech: each 10s part speaks inside a window of about 7.5s so that
 * roughly 2 seconds of silence surround the seam between part 1 and the extension (see SPEAKING_SECONDS
 * and SPEECH_WINDOWS in the shared contract). Up to that budget the length is comfortable; beyond it the
 * delivery gets fast and speech near the seam may be rewritten; beyond the hard limit it will not fit.
 */
import {
  LIMITS,
  SPEAKING_SECONDS,
  SPEECH_WINDOWS,
  TOTAL_SECONDS,
  countWords,
  estimateSpokenSeconds,
} from '@shared/api';

export type PacingLevel = 'empty' | 'good' | 'tight' | 'over';

export interface PacingBudget {
  /** Seconds of speech that fit comfortably. */
  comfortableSeconds: number;
  /** Above this the dialogue cannot be spoken naturally in the time available. */
  maxSeconds: number;
}

/** Whole script: about 15s of comfortable speech in a 20s video. */
export const SCRIPT_BUDGET: PacingBudget = { comfortableSeconds: SPEAKING_SECONDS, maxSeconds: TOTAL_SECONDS };

/** One 10s part: its speaking window (about 7.5s), and at most until the window of part 2 closes. */
export const PART_BUDGET: PacingBudget = {
  comfortableSeconds: SPEAKING_SECONDS / 2,
  maxSeconds: Math.max(SPEECH_WINDOWS.part1.end, SPEECH_WINDOWS.part2.end),
};

export function classifyPacing(seconds: number, budget: PacingBudget = SCRIPT_BUDGET): PacingLevel {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'empty';
  if (seconds <= budget.comfortableSeconds) return 'good';
  if (seconds <= budget.maxSeconds) return 'tight';
  return 'over';
}

/** Words that fit in `seconds` at the comfortable pace (39 for 15s of speech). */
export function wordsThatFit(seconds: number): number {
  return Math.floor(seconds * LIMITS.wordsPerSecond);
}

export interface Pacing {
  words: number;
  seconds: number;
  comfortableSeconds: number;
  maxSeconds: number;
  level: PacingLevel;
  /** Words that fit in the comfortable budget. */
  maxWords: number;
  /** seconds / maxSeconds, not clamped. */
  ratio: number;
}

export function analyzePacing(text: string, budget: PacingBudget = SCRIPT_BUDGET): Pacing {
  const seconds = estimateSpokenSeconds(text);
  return {
    words: countWords(text),
    seconds,
    comfortableSeconds: budget.comfortableSeconds,
    maxSeconds: budget.maxSeconds,
    level: classifyPacing(seconds, budget),
    maxWords: wordsThatFit(budget.comfortableSeconds),
    ratio: budget.maxSeconds > 0 ? seconds / budget.maxSeconds : 0,
  };
}

/** Guidance for the whole-script meter. */
export function pacingMessage(pacing: Pacing): string {
  const fit = `About ${pacing.maxWords} words (${pacing.comfortableSeconds}s of speech) fit comfortably, leaving a short pause around the 10-second seam.`;
  const cut = Math.max(1, pacing.words - pacing.maxWords);
  switch (pacing.level) {
    case 'empty':
      return fit;
    case 'good':
      return `Fits comfortably. ${fit}`;
    case 'tight':
      return `Long: the delivery will be fast and words near the 10-second seam may be cut. Consider cutting about ${cut} words.`;
    case 'over':
      return `Too long to speak in ${pacing.maxSeconds} seconds. Cut about ${cut} words.`;
  }
}
