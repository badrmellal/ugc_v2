import { describe, expect, it } from 'vitest';
import { analyzePacing, classifyPacing, PART_BUDGET, pacingMessage, SCRIPT_BUDGET, wordsThatFit } from './pacing';

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

describe('classifyPacing', () => {
  it('is green up to 15s of speech, amber up to 20s, red beyond', () => {
    expect(SCRIPT_BUDGET).toEqual({ comfortableSeconds: 15, maxSeconds: 20 });
    expect(classifyPacing(0)).toBe('empty');
    expect(classifyPacing(12)).toBe('good');
    expect(classifyPacing(15)).toBe('good');
    expect(classifyPacing(15.1)).toBe('tight');
    expect(classifyPacing(20)).toBe('tight');
    expect(classifyPacing(20.1)).toBe('over');
  });

  it('uses the speaking window of one part for the split', () => {
    expect(PART_BUDGET).toEqual({ comfortableSeconds: 7.5, maxSeconds: 8.5 });
    expect(classifyPacing(7.5, PART_BUDGET)).toBe('good');
    expect(classifyPacing(8, PART_BUDGET)).toBe('tight');
    expect(classifyPacing(9, PART_BUDGET)).toBe('over');
  });
});

describe('analyzePacing', () => {
  it('reports that about 39 words fit comfortably in a 20s video', () => {
    expect(wordsThatFit(15)).toBe(39);
    expect(pacingMessage(analyzePacing(''))).toContain('About 39 words (15s of speech) fit comfortably');
  });

  it('classifies scripts by estimated spoken length', () => {
    expect(analyzePacing(words(34)).level).toBe('good');
    expect(analyzePacing(words(39)).level).toBe('good');
    expect(analyzePacing(words(45)).level).toBe('tight');
    expect(analyzePacing(words(52)).level).toBe('tight');
    const long = analyzePacing(words(80));
    expect(long.level).toBe('over');
    expect(long.words).toBe(80);
    expect(pacingMessage(long)).toContain('Cut about 41 words');
  });
});
