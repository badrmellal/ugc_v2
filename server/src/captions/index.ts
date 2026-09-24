import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { ProbeResult } from '../core/ports.js';
import { SPEECH_WINDOWS } from '../shared/api.js';
import { buildAss, DEFAULT_CAPTION_STYLE, type CaptionWord } from './ass.js';

export type { CaptionWord } from './ass.js';

/** Where align.py and the caption font live (server/assets), from both src/ (tsx) and dist/ (node). */
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
export const ALIGN_SCRIPT = join(ASSETS_DIR, 'captions', 'align.py');
export const CAPTION_FONT = join(ASSETS_DIR, 'fonts', 'Poppins-ExtraBold.ttf');

export type CaptionEngine = 'pocketsphinx' | 'estimate';

/** The ffmpeg operations captions need (implemented by FfmpegMediaTools). */
export interface CaptionMedia {
  probe(path: string): Promise<ProbeResult>;
  extractPcm(input: string, output: string): Promise<void>;
  burnSubtitles(input: string, output: string, opts: { cwd: string; assFile: string; fontsDir: string }): Promise<void>;
}

export interface CaptionRequest {
  /** Video to caption (not modified). */
  input: string;
  /** Captioned MP4 to write. */
  output: string;
  /** Spoken dialogue, in order. Stage directions must already be removed. */
  parts: string[];
  /** Duration of part 1, used to place part 2's speech when timing has to be estimated. */
  part1DurationSec: number | null;
  /** Scratch directory (must exist). */
  workDir: string;
}

export interface CaptionResult {
  words: CaptionWord[];
  engine: CaptionEngine;
}

export interface CaptionRendererOptions {
  media: CaptionMedia;
  logger: Logger;
  /** Python interpreter with pocketsphinx installed; null disables exact alignment. */
  pythonPath: string | null;
  timeoutMs?: number;
}

/**
 * Burns TikTok-style captions into a video: the words come from the script (never mis-transcribed),
 * their timing from forced alignment against the audio (PocketSphinx), and the word being spoken is
 * highlighted. When alignment is unavailable the timing is estimated from the speech windows.
 */
export class CaptionRenderer {
  private readonly timeoutMs: number;

  constructor(private readonly opts: CaptionRendererOptions) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async render(req: CaptionRequest): Promise<CaptionResult> {
    const probe = await this.opts.media.probe(req.input);
    if (!probe.width || !probe.height) throw new Error('The video has no picture to caption.');
    const text = req.parts.map((p) => p.trim()).filter(Boolean);
    if (!text.length) throw new Error('There is no dialogue to caption.');

    let result: CaptionResult | null = null;
    if (this.opts.pythonPath && probe.hasAudio) {
      try {
        const pcm = join(req.workDir, 'captions-audio.raw');
        await this.opts.media.extractPcm(req.input, pcm);
        const words = await this.align(pcm, text.join('\n'));
        if (words.length) result = { words, engine: 'pocketsphinx' };
      } catch (err) {
        this.opts.logger.warn({ err: errorMessage(err) }, 'caption alignment failed, estimating word timing');
      }
    }
    result ??= { words: estimateTimings(text, probe.durationSec, req.part1DurationSec), engine: 'estimate' };

    const fontsDir = join(req.workDir, 'caption-fonts');
    await mkdir(fontsDir, { recursive: true });
    await copyFile(CAPTION_FONT, join(fontsDir, 'Poppins-ExtraBold.ttf'));
    const ass = buildAss(
      result.words,
      { width: probe.width, height: probe.height, durationSec: probe.durationSec },
      DEFAULT_CAPTION_STYLE,
    );
    await writeFile(join(req.workDir, 'captions.ass'), ass, 'utf8');
    await this.opts.media.burnSubtitles(req.input, req.output, {
      cwd: req.workDir,
      assFile: 'captions.ass',
      fontsDir: 'caption-fonts',
    });
    return result;
  }

  /** Runs align.py: PCM path as argument, transcript on stdin, JSON on stdout. */
  private align(pcmPath: string, transcript: string): Promise<CaptionWord[]> {
    const python = this.opts.pythonPath!;
    return new Promise((resolve, reject) => {
      const child = spawn(python, [ALIGN_SCRIPT, pcmPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-2000)));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`aligner exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { words?: CaptionWord[] };
          const words = (parsed.words ?? []).filter(
            (w) => typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end),
          );
          resolve(words);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(transcript);
    });
  }
}

/** Rough syllable count, used to weight word durations when timing is estimated. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!w) return 1;
  if (/^\d+$/.test(w)) return Math.max(1, w.length);
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g)?.length ?? 0;
  return Math.max(1, groups);
}

/**
 * Fallback timing without alignment: each part's words are spread over that part's speaking window
 * (see SPEECH_WINDOWS), weighted by syllables, with a small pause after punctuation.
 */
export function estimateTimings(parts: string[], durationSec: number, part1DurationSec: number | null): CaptionWord[] {
  const p1 = part1DurationSec && part1DurationSec > 1 ? part1DurationSec : Math.min(10, durationSec / 2);
  const windows: [number, number][] =
    parts.length >= 2
      ? [
          [SPEECH_WINDOWS.part1.start, Math.min(SPEECH_WINDOWS.part1.end, p1 - 0.3)],
          [p1 + SPEECH_WINDOWS.part2.start, Math.min(p1 + SPEECH_WINDOWS.part2.end, durationSec - 0.3)],
        ]
      : [[0.3, Math.max(0.8, durationSec - 0.5)]];
  const out: CaptionWord[] = [];
  parts.slice(0, windows.length).forEach((text, i) => {
    const [from, to] = windows[i]!;
    const tokens = text.split(/\s+/).filter(Boolean);
    if (!tokens.length || !(to > from)) return;
    const weights = tokens.map((t) => syllables(t) + (/[.,!?;:]$/.test(t) ? 0.8 : 0) + 0.3);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = from;
    tokens.forEach((token, j) => {
      const span = ((to - from) * weights[j]!) / total;
      out.push({ text: token, start: t, end: t + span * 0.92 });
      t += span;
    });
  });
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
