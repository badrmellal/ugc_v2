import { describe, expect, it } from 'vitest';
import { chooseSplit, fallbackPlan, parseScript, splitSentences } from '../src/script/fallback.js';
import { DEFAULT_SETTINGS, countWords, estimateSpokenSeconds, type GenerationSettings } from '../src/shared/api.js';

const EM_DASH = String.fromCharCode(0x2014);
const settings = (over: Partial<GenerationSettings> = {}): GenerationSettings => ({ ...DEFAULT_SETTINGS, ...over });
const words = (text: string) => text.split(/\s+/).filter(Boolean);

describe('splitSentences', () => {
  it('handles abbreviations, decimals, initials, ellipses and quotes', () => {
    expect(
      splitSentences(
        'Dr. Smith moved to the U.S. last year. It costs $19.99, e.g. less than lunch. Wait... what? J. K. Rowling agrees. She said "wow." Take vitamin C. Then rest!',
      ),
    ).toEqual([
      'Dr. Smith moved to the U.S. last year.',
      'It costs $19.99, e.g. less than lunch.',
      'Wait... what?',
      'J. K. Rowling agrees.',
      'She said "wow."',
      'Take vitamin C.',
      'Then rest!',
    ]);
  });

  it('splits on ellipses followed by a capital and on CJK punctuation', () => {
    expect(splitSentences('I tried it... Honestly? It works.')).toEqual(['I tried it...', 'Honestly?', 'It works.']);
    expect(splitSentences('今天很好。你呢？我很开心！')).toEqual(['今天很好。', '你呢？', '我很开心！']);
  });
});

describe('parseScript', () => {
  it('separates stage directions, labels and timecodes from speech', () => {
    const parsed = parseScript(
      [
        'Hook: Stop scrolling if your skin feels dull. [holds up the jar]',
        '(smiles)',
        '0:03-0:08 This serum has vitamin C (about 15 percent) and it absorbs fast.',
        '[0-3s]',
        'CTA: Link in bio!',
      ].join('\n'),
    );
    expect(parsed.speech).toBe(
      'Stop scrolling if your skin feels dull. This serum has vitamin C (about 15 percent) and it absorbs fast. Link in bio!',
    );
    expect(parsed.directions).toEqual(['holds up the jar', 'smiles']);
  });

  it('keeps inline parentheses that are part of the dialogue', () => {
    expect(parseScript('Eat more fiber (e.g. oats and beans) every day.').speech).toBe(
      'Eat more fiber (e.g. oats and beans) every day.',
    );
  });

  it('treats inline cues in parentheses as directions and strips outer quotes', () => {
    const parsed = parseScript('"I was shocked (laughs) when I saw the results."');
    expect(parsed.directions).toEqual(['laughs']);
    expect(parsed.speech).toBe('I was shocked when I saw the results.');
  });
});

describe('chooseSplit / fallbackPlan', () => {
  it('splits at the sentence boundary that best balances speaking time', () => {
    const script =
      'Okay so I finally tried the viral protein coffee everyone keeps posting. ' +
      'It tastes like a caramel latte and has twenty grams of protein. ' +
      'I drink it after my morning workout instead of a shake. ' +
      'Honestly it keeps me full until lunch, try it.';
    const plan = fallbackPlan(script, settings());
    expect(plan.source).toBe('fallback');
    const [a, b] = plan.segments;
    expect(`${a.dialogue} ${b.dialogue}`).toBe(script);
    expect(a.dialogue.endsWith('protein.')).toBe(true);
    expect(Math.abs(estimateSpokenSeconds(a.dialogue) - estimateSpokenSeconds(b.dialogue))).toBeLessThan(2);
    expect(a).toMatchObject({ index: 1, startSec: 0, endSec: 10 });
    expect(b).toMatchObject({ index: 2, startSec: 10, endSec: 20 });
    expect(plan.estimatedSpokenSeconds).toBe(estimateSpokenSeconds(script));
  });

  it('splits one long sentence at a clause boundary', () => {
    const script =
      'The mitochondria convert the food you eat into usable chemical energy called ATP, which powers almost every process in your cells from muscle movement to thinking';
    const [a, b] = fallbackPlan(script, settings({ style: 'scientific' })).segments;
    expect(a.dialogue).toBe('The mitochondria convert the food you eat into usable chemical energy called ATP,');
    expect(b.dialogue).toBe('which powers almost every process in your cells from muscle movement to thinking');
  });

  it('falls back to a word boundary near the middle when there is no punctuation', () => {
    const script = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const [a, b] = fallbackPlan(script, settings()).segments;
    expect(`${a.dialogue} ${b.dialogue}`).toBe(script);
    expect(Math.abs(words(a.dialogue).length - words(b.dialogue).length)).toBeLessThanOrEqual(1);
  });

  it('keeps a single short line whole in part 1', () => {
    const plan = fallbackPlan('This changed my morning routine forever.', settings());
    expect(plan.segments[0].dialogue).toBe('This changed my morning routine forever.');
    expect(plan.segments[1].dialogue).toBe('');
    expect(plan.segments[1].prompt).toContain('No dialogue.');
  });

  it('puts stage directions into the action and on-screen text of the part where they occur', () => {
    const plan = fallbackPlan(
      [
        'Hook: I stopped buying expensive serums. [holds up a tiny glass jar]',
        'This one costs eight dollars and my skin has never looked better.',
        '[Text on screen: "Under $10"]',
        '(taps the label) It has niacinamide and zinc, so it calms redness and shine.',
        'Try it for two weeks and thank me later.',
      ].join('\n'),
      settings(),
    );
    const [a, b] = plan.segments;
    expect(a.action).toBe('holds up a tiny glass jar');
    expect(`${a.dialogue} ${b.dialogue}`).not.toMatch(/holds up|taps the label|Text on screen|Hook/);
    expect(a.onScreenText + b.onScreenText).toBe('Under $10');
    expect(b.action).toContain('taps the label');
    const withText = plan.segments.find((s) => s.onScreenText)!;
    expect(withText.prompt).toContain('On-screen text:');
  });

  it('splits CJK scripts without inserting spaces and warns about the language', () => {
    const script =
      '今天我想和大家分享一个小秘密。每天早上喝一杯温水，可以帮助身体醒来。坚持两个星期，你会发现皮肤变得更好了！快来试试吧。';
    const plan = fallbackPlan(script, settings({ language: 'zh' }));
    const [a, b] = plan.segments;
    expect(a.dialogue + b.dialogue).toBe(script);
    expect(a.dialogue.endsWith('。')).toBe(true);
    expect(countWords(a.dialogue)).toBeGreaterThan(0);
    expect(countWords(b.dialogue)).toBeGreaterThan(0);
    expect(plan.warnings.some((w) => w.includes('Chinese'))).toBe(true);
    expect(a.prompt).toContain('The person speaks Chinese.');
  });

  it('warns when the script is too long overall and per part', () => {
    const sentence = 'This is a sentence with exactly ten words in it.';
    const plan = fallbackPlan(Array.from({ length: 8 }, () => sentence).join(' '), settings());
    expect(plan.estimatedSpokenSeconds).toBeGreaterThan(20);
    expect(plan.warnings[0]).toMatch(
      /^Script needs about 30\.8s to speak; it may be rushed or cut\. Aim for about 52 words\.$/,
    );
    expect(plan.warnings.filter((w) => /^Part [12] dialogue needs about/.test(w))).toHaveLength(2);
  });

  it('warns about very short scripts and scripts without dialogue', () => {
    expect(fallbackPlan('Hi there, friends.', settings()).warnings.join(' ')).toMatch(/Script is short/);
    const silent = fallbackPlan('[walks into the kitchen]\n[pours a glass of water]', settings());
    expect(silent.segments[0].dialogue).toBe('');
    expect(silent.warnings.join(' ')).toMatch(/No dialogue found/);
    expect(silent.segments[0].action).toBe('walks into the kitchen');
    expect(silent.segments[1].action).toBe('pours a glass of water');
  });

  it('uses the voice hint, replaces em dashes, and never emits U+2014', () => {
    const plan = fallbackPlan(
      `I tried it${EM_DASH}and wow. It really works for me every single day.`,
      settings({
        voiceHint: 'deep, calm male voice with a British accent',
        extraDirections: `Kitchen counter with a coffee mug${EM_DASH}morning light`,
      }),
    );
    expect(plan.voice).toBe('deep, calm male voice with a British accent');
    expect(plan.segments[0].dialogue).toContain('I tried it, and wow.');
    expect(JSON.stringify(plan)).not.toContain(EM_DASH);
    for (const s of plan.segments)
      expect(s.prompt).toContain('Additional directions: Kitchen counter with a coffee mug, morning light.');
  });

  it('chooseSplit prefers a sentence boundary over a slightly better balanced clause', () => {
    const parsed = parseScript('One two three four five six. Seven eight nine ten eleven, twelve thirteen fourteen.');
    const split = chooseSplit(parsed.units);
    expect(split.level).toBe('sentence');
    expect(split.part1.dialogue).toBe('One two three four five six.');
  });
});
