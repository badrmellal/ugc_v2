/** Spoken-length estimate for scripts, used by the pacing meters. */
import { LIMITS, TOTAL_SECONDS, countWords, estimateSpokenSeconds } from '@shared/api';

export type PacingLevel = 'empty' | 'good' | 'tight' | 'over';

/** Scripts up to 20% longer than the target can still work with fast delivery (24s for a 20s video). */
export const PACING_TOLERANCE = 1.2;

export function classifyPacing(seconds: number, targetSeconds: number = TOTAL_SECONDS): PacingLevel {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'empty';
  if (seconds <= targetSeconds) return 'good';
  if (seconds <= targetSeconds * PACING_TOLERANCE) return 'tight';
  return 'over';
}

/** Words that fit in `seconds` at the comfortable pace (52 for 20s). */
export function wordsThatFit(seconds: number): number {
  return Math.floor(seconds * LIMITS.wordsPerSecond);
}

export interface Pacing {
  words: number;
  seconds: number;
  targetSeconds: number;
  level: PacingLevel;
  maxWords: number;
  /** seconds / target, not clamped. */
  ratio: number;
}

export function analyzePacing(text: string, targetSeconds: number = TOTAL_SECONDS): Pacing {
  const seconds = estimateSpokenSeconds(text);
  return {
    words: countWords(text),
    seconds,
    targetSeconds,
    level: classifyPacing(seconds, targetSeconds),
    maxWords: wordsThatFit(targetSeconds),
    ratio: targetSeconds > 0 ? seconds / targetSeconds : 0,
  };
}

export function pacingMessage(pacing: Pacing): string {
  const fit = `About ${pacing.maxWords} words fit in ${pacing.targetSeconds} seconds.`;
  switch (pacing.level) {
    case 'empty':
      return fit;
    case 'good':
      return `Fits in ${pacing.targetSeconds} seconds. ${fit}`;
    case 'tight':
      return `Slightly long: the delivery will be fast. ${fit}`;
    case 'over':
      return `Too long to speak naturally in ${pacing.targetSeconds} seconds. Cut about ${Math.max(
        1,
        pacing.words - pacing.maxWords,
      )} words.`;
  }
}
