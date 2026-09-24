import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assColor, buildAss, displayWord, groupWords, type CaptionWord } from '../src/captions/ass.js';
import { CaptionRenderer, estimateTimings, syllables } from '../src/captions/index.js';
import { FfmpegMediaTools } from '../src/media/ffmpeg.js';

const FIXTURE = new URL('./fixtures/speech.mp4', import.meta.url).pathname;
const SPOKEN = ['Cameras see the road.', 'The network builds a live map.'];
const logger = pino({ level: 'silent' });
const media = new FfmpegMediaTools();

/** Python with pocketsphinx, if this machine has one (CI and the Docker image do). */
const python = (() => {
  const candidate = process.env.CAPTIONS_PYTHON || 'python3';
  const probe = spawnSync(candidate, ['-c', 'import pocketsphinx'], { stdio: 'ignore' });
  return probe.status === 0 ? candidate : null;
})();

const w = (text: string, start: number, end: number): CaptionWord => ({ text, start, end });

describe('caption subtitle script', () => {
  it('converts colours to ASS order and shows words cleanly', () => {
    expect(assColor('#FFD400')).toBe('&H00D4FF&');
    expect(displayWord('lidar.', true)).toBe('LIDAR');
    expect(displayWord('world?', true)).toBe('WORLD?');
    expect(displayWord('"2D"', true)).toBe('2D');
  });

  it('groups up to three words and always breaks at the end of a sentence or clause', () => {
    const words = [
      w('Just', 0, 0.3),
      w('cameras.', 0.3, 0.8),
      w('So', 1.0, 1.1),
      w('how', 1.1, 1.3),
      w('do', 1.3, 1.4),
      w('flat', 1.4, 1.7),
    ];
    const groups = groupWords(words, 3, 20).map((g) => g.map((x) => x.text).join(' '));
    expect(groups).toEqual(['Just cameras.', 'So how do', 'flat']);
  });

  it('highlights exactly the word being spoken, in yellow, one event per word', () => {
    const words = [w('No', 16.6, 16.8), w('lidar', 16.8, 17.25), w('needed.', 17.25, 17.72)];
    const ass = buildAss(words, { width: 720, height: 1280, durationSec: 18.1 });
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(events).toHaveLength(3);
    expect(events[1]).toContain('Dialogue: 0,0:00:16.80,0:00:17.25');
    // "NO LIDAR NEEDED" is wider than the frame allows on one line, so it splits into two groups.
    expect(events[1]).toMatch(/,NO \{\\c&H00D4FF&\\fscx112\\fscy112\}LIDAR\{\\r\}$/);
    expect(events[2]).toContain('{\\c&H00D4FF&\\fscx112\\fscy112}NEEDED{\\r}');
    // The last word stays up briefly after it is spoken, but never past the end of the video.
    expect(events[2]).toContain(',0:00:17.25,0:00:18.07,');
    expect(ass).toContain('PlayResX: 720');
    expect(ass).toContain('Style: Caption,Poppins ExtraBold,');
  });

  it('neutralizes ASS override syntax in the script text', () => {
    const ass = buildAss([w('{\\b1}hack', 0, 1)], { width: 360, height: 640, durationSec: 2 });
    const event = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(event).not.toContain('{\\b1}');
  });
});

describe('estimated caption timing', () => {
  it('places each part inside its speaking window, in order', () => {
    const words = estimateTimings(['One two three.', 'Four five six.'], 20, 10);
    expect(words.map((x) => x.text)).toEqual(['One', 'two', 'three.', 'Four', 'five', 'six.']);
    for (let i = 1; i < words.length; i += 1) expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.end);
    expect(words[0]!.start).toBeGreaterThanOrEqual(0.5);
    expect(words[2]!.end).toBeLessThanOrEqual(8);
    expect(words[3]!.start).toBeGreaterThanOrEqual(10.8);
    expect(words[5]!.end).toBeLessThanOrEqual(18.5);
    expect(syllables('network')).toBe(2);
  });
});

describe('caption renderer', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'omni-captions-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('burns captions with estimated timing when no aligner is available', async () => {
    const renderer = new CaptionRenderer({ media, logger, pythonPath: null });
    const output = join(dir, 'estimated.mp4');
    const result = await renderer.render({
      input: FIXTURE,
      output,
      parts: SPOKEN,
      part1DurationSec: null,
      workDir: dir,
    });
    expect(result.engine).toBe('estimate');
    expect(result.words).toHaveLength(10);
    const probe = await media.probe(output);
    expect(probe.hasAudio).toBe(true);
    expect(Math.abs(probe.durationSec - 3.93)).toBeLessThan(0.3);
  });

  it.runIf(python)('times every word to the voice with forced alignment', async () => {
    const renderer = new CaptionRenderer({ media, logger, pythonPath: python });
    const output = join(dir, 'aligned.mp4');
    const result = await renderer.render({
      input: FIXTURE,
      output,
      parts: [SPOKEN.join(' ')],
      part1DurationSec: null,
      workDir: dir,
    });
    expect(result.engine).toBe('pocketsphinx');
    const words = result.words;
    expect(words.map((x) => x.text)).toEqual([
      'Cameras',
      'see',
      'the',
      'road.',
      'The',
      'network',
      'builds',
      'a',
      'live',
      'map.',
    ]);
    expect(words[0]!.start).toBeLessThan(0.3);
    // The pause between the two sentences is found in the audio.
    expect(words[4]!.start - words[3]!.end).toBeGreaterThan(0.2);
    expect(words[9]!.end).toBeLessThan(3.93);
    for (let i = 1; i < words.length; i += 1) expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.start);
  });

  it('falls back to estimated timing when the aligner cannot run', async () => {
    const renderer = new CaptionRenderer({ media, logger, pythonPath: '/nonexistent/python' });
    const result = await renderer.render({
      input: FIXTURE,
      output: join(dir, 'fallback.mp4'),
      parts: SPOKEN,
      part1DurationSec: null,
      workDir: dir,
    });
    expect(result.engine).toBe('estimate');
  });
});
