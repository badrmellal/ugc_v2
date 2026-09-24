import { describe, expect, it } from 'vitest';
import { analyzePacing, classifyPacing, pacingMessage, wordsThatFit } from './pacing';

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

describe('classifyPacing', () => {
  it('is green up to the target, amber up to 20% over, red beyond', () => {
    expect(classifyPacing(0)).toBe('empty');
    expect(classifyPacing(12)).toBe('good');
    expect(classifyPacing(20)).toBe('good');
    expect(classifyPacing(20.1)).toBe('tight');
    expect(classifyPacing(24)).toBe('tight');
    expect(classifyPacing(24.1)).toBe('over');
  });

  it('scales with the target (10s parts)', () => {
    expect(classifyPacing(10, 10)).toBe('good');
    expect(classifyPacing(11.5, 10)).toBe('tight');
    expect(classifyPacing(13, 10)).toBe('over');
  });
});

describe('analyzePacing', () => {
  it('reports that 52 words fit in 20 seconds', () => {
    expect(wordsThatFit(20)).toBe(52);
    expect(pacingMessage(analyzePacing(''))).toContain('About 52 words fit in 20 seconds');
  });

  it('classifies scripts by estimated spoken length', () => {
    expect(analyzePacing(words(40)).level).toBe('good');
    expect(analyzePacing(words(52)).level).toBe('good');
    expect(analyzePacing(words(60)).level).toBe('tight');
    const long = analyzePacing(words(80));
    expect(long.level).toBe('over');
    expect(long.words).toBe(80);
    expect(pacingMessage(long)).toContain('Cut about 28 words');
  });
});
