import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MediaTools, ProbeResult } from '../core/ports.js';

export type MediaErrorCode =
  | 'binary_not_found'
  | 'spawn_failed'
  | 'timeout'
  | 'process_failed'
  | 'input_not_found'
  | 'invalid_media'
  | 'unsupported_format'
  | 'image_too_large'
  | 'invalid_argument'
  | 'no_output';

/** Error thrown by `FfmpegMediaTools`. `stderr` holds at most the last 2000 characters of tool output. */
export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(
    code: MediaErrorCode,
    message: string,
    opts: { stderr?: string; exitCode?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'MediaError';
    this.code = code;
    this.stderr = opts.stderr ?? '';
    this.exitCode = opts.exitCode ?? null;
  }
}

export interface FfmpegMediaToolsOptions {
  /** ffmpeg binary (name on PATH or absolute path). Default `ffmpeg`. */
  ffmpegPath?: string;
  /** ffprobe binary. Default `ffprobe`. */
  ffprobePath?: string;
  /** Kill a single ffmpeg/ffprobe process after this long. Default 180000 ms. */
  timeoutMs?: number;
  /**
   * Font for mock clip captions. `undefined`: first common system font found, else fontconfig default.
   * `null`: never draw text.
   */
  fontFile?: string | null;
  /** Images above this many pixels are rejected before decoding (decompression bomb guard). Default 100 MP. */
  maxImagePixels?: number;
  /** Parent directory for scratch files. Default `os.tmpdir()`. */
  tmpDir?: string;
}

export type ImageFormat = 'jpeg' | 'png' | 'webp';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_IMAGE_PIXELS = 100_000_000;
const STDERR_TAIL_CHARS = 2000;
const STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_FPS = '24';
const SYNTH_FPS = 24;

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

/** Paths that can be embedded in a filtergraph option without any escaping. */
const FILTER_SAFE_PATH = /^[A-Za-z0-9/_.-]+$/;
/** Pixel formats that carry an alpha channel (or a palette that may be transparent). */
const ALPHA_PIX_FMT = /^(yuva|gbrap|ya\d|rgba|bgra|argb|abgr|pal8)/;

/** ffprobe output subset we read. */
interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number | string }[];
  disposition?: { attached_pic?: number };
}
interface FfprobeFrame {
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number | string }[];
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  frames?: FfprobeFrame[];
  format?: { duration?: string };
}

interface DetailedProbe extends ProbeResult {
  /** Frame rate as an ffmpeg expression (`24`, `30000/1001`), or null. */
  fpsExpr: string | null;
  /** Duration of the video stream itself when reported. */
  videoDurationSec: number | null;
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** MediaTools implementation on top of the ffmpeg and ffprobe command line tools (never through a shell). */
export class FfmpegMediaTools implements MediaTools {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly timeoutMs: number;
  private readonly fontOption: string | null | undefined;
  private readonly maxImagePixels: number;
  private readonly tmpDir: string;
  private fontLookup: Promise<string | null> | null = null;

  constructor(opts: FfmpegMediaToolsOptions = {}) {
    this.ffmpegPath = opts.ffmpegPath || 'ffmpeg';
    this.ffprobePath = opts.ffprobePath || 'ffprobe';
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fontOption = opts.fontFile;
    this.maxImagePixels =
      opts.maxImagePixels && opts.maxImagePixels > 0 ? opts.maxImagePixels : DEFAULT_MAX_IMAGE_PIXELS;
    this.tmpDir = opts.tmpDir || os.tmpdir();
  }

  // -------------------------------------------------------------------------
  // MediaTools
  // -------------------------------------------------------------------------

  async probe(input: string): Promise<ProbeResult> {
    const p = await this.probeDetailed(input);
    return {
      durationSec: p.durationSec,
      width: p.width,
      height: p.height,
      fps: p.fps,
      hasAudio: p.hasAudio,
      videoCodec: p.videoCodec,
      audioCodec: p.audioCodec,
    };
  }

  async faststart(input: string, output: string): Promise<void> {
    await assertInputFile(input);
    const src = path.resolve(input);
    await this.writeOutput(output, async (tmp) => {
      try {
        await this.ffmpeg(['-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', ...mp4Out(tmp)]);
      } catch (err) {
        if (!isRecoverable(err)) throw err;
        // Stream copy fails for codecs the MP4 muxer rejects or broken timestamps: re-encode instead.
        await rm(tmp, { force: true });
        await this.ffmpeg(['-i', src, '-map', '0:v:0', '-map', '0:a:0?', ...h264Aac(), ...mp4Out(tmp)]);
      }
    });
  }

  async concat(inputs: string[], output: string): Promise<void> {
    if (inputs.length === 0) throw new MediaError('invalid_argument', 'concat needs at least one input');
    if (inputs.length === 1) return this.faststart(inputs[0] as string, output);

    const sources = inputs.map((i) => path.resolve(i));
    const probes = await Promise.all(sources.map((s) => this.probeDetailed(s)));
    const first = probes[0] as DetailedProbe;
    if (!first.width || !first.height) {
      throw new MediaError('invalid_media', `concat: ${path.basename(sources[0] as string)} has no video stream`);
    }
    const width = evenFloor(first.width);
    const height = evenFloor(first.height);
    const fps = first.fpsExpr ?? DEFAULT_FPS;

    const parts: string[] = [];
    const pads: string[] = [];
    probes.forEach((p, i) => {
      const name = path.basename(sources[i] as string);
      if (!p.width || !p.height) throw new MediaError('invalid_media', `concat: ${name} has no video stream`);
      const dur = p.videoDurationSec ?? p.durationSec;
      if (!(dur > 0)) throw new MediaError('invalid_media', `concat: ${name} has an unknown duration`);
      const d = dur.toFixed(3);
      parts.push(
        `[${i}:v:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
      );
      const audioFormat = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
      parts.push(
        p.hasAudio
          ? `[${i}:a:0]asetpts=PTS-STARTPTS,aresample=48000,${audioFormat},apad=whole_dur=${d},atrim=duration=${d}[a${i}]`
          : `anullsrc=channel_layout=stereo:sample_rate=48000,${audioFormat},atrim=duration=${d}[a${i}]`,
      );
      pads.push(`[v${i}][a${i}]`);
    });
    parts.push(`${pads.join('')}concat=n=${sources.length}:v=1:a=1[vout][aout]`);

    await this.writeOutput(output, (tmp) =>
      this.ffmpeg([
        ...sources.flatMap((s) => ['-i', s]),
        '-filter_complex',
        parts.join(';'),
        '-map',
        '[vout]',
        '-map',
        '[aout]',
        ...h264Aac(),
        '-ar',
        '48000',
        '-ac',
        '2',
        ...mp4Out(tmp),
      ]),
    );
  }

  async thumbnail(input: string, output: string, atSec: number): Promise<void> {
    const src = path.resolve(input);
    const p = await this.probeDetailed(src);
    if (!p.width || !p.height) throw new MediaError('invalid_media', 'thumbnail: input has no video stream');
    const duration = p.videoDurationSec ?? p.durationSec;
    const at = clamp(Number.isFinite(atSec) ? atSec : 0, 0, Math.max(0, duration - 0.1));
    // Seeking close to the end can land after the last frame; fall back to earlier positions.
    const positions = [...new Set([at, Math.max(0, at - 1), 0].map((t) => Math.round(t * 1000) / 1000))];

    await this.writeOutput(output, async (tmp) => {
      for (const [index, t] of positions.entries()) {
        const last = index === positions.length - 1;
        try {
          await this.ffmpeg([
            '-ss',
            t.toFixed(3),
            '-i',
            src,
            '-map',
            '0:v:0',
            '-frames:v',
            '1',
            '-q:v',
            '3',
            '-map_metadata',
            '-1',
            '-f',
            'image2',
            '-update',
            '1',
            tmp,
          ]);
        } catch (err) {
          if (last || !isRecoverable(err)) throw err;
          continue;
        }
        if (await nonEmptyFile(tmp)) return;
      }
    });
  }

  async normalizeImage(input: string, output: string, maxSide: number): Promise<{ width: number; height: number }> {
    if (!Number.isFinite(maxSide) || maxSide < 1) {
      throw new MediaError('invalid_argument', `normalizeImage: invalid maxSide ${String(maxSide)}`);
    }
    await assertInputFile(input);
    const src = path.resolve(input);
    const format = await sniffImageFile(src);
    if (!format) throw new MediaError('unsupported_format', 'Image must be a JPEG, PNG or WebP file');
    // A fixed image demuxer: never let ffmpeg probe untrusted uploads as playlists or other containers.
    const demuxer = `${format}_pipe`;

    const json = await this.ffprobeJson([
      '-f',
      demuxer,
      '-max_pixels',
      String(this.maxImagePixels),
      '-select_streams',
      'v:0',
      '-show_streams',
      '-show_frames',
      '-read_intervals',
      '%+#1',
      src,
    ]);
    const stream = json.streams?.[0];
    const frame = json.frames?.[0];
    if (!stream?.width || !stream.height) throw new MediaError('invalid_media', 'Image could not be decoded');
    if (stream.width * stream.height > this.maxImagePixels) {
      throw new MediaError(
        'image_too_large',
        `Image is ${stream.width}x${stream.height}, above the ${this.maxImagePixels} pixel limit`,
      );
    }
    if (!frame) throw new MediaError('invalid_media', 'Image could not be decoded');

    const orientation = readOrientation(frame, stream);
    const swap = orientation >= 5 && orientation <= 8;
    const srcW = swap ? stream.height : stream.width;
    const srcH = swap ? stream.width : stream.height;
    const target = fitWithin(srcW, srcH, Math.floor(maxSide));

    const chain = exifOrientationFilters(orientation);
    if (target.width !== srcW || target.height !== srcH) {
      chain.push(`scale=${target.width}:${target.height}:flags=lanczos`);
    }
    let graph: string;
    if (ALPHA_PIX_FMT.test(stream.pix_fmt ?? '')) {
      // Flatten transparency on white (JPEG has no alpha; black would be the default otherwise).
      chain.push('format=rgba');
      graph =
        `[0:v]${chain.join(',')}[fg];color=c=white:s=${target.width}x${target.height},format=rgba[bg];` +
        `[bg][fg]overlay=format=auto:shortest=1,format=yuvj420p[out]`;
    } else {
      chain.push('format=yuvj420p');
      graph = `[0:v]${chain.join(',')}[out]`;
    }

    await this.writeOutput(output, (tmp) =>
      this.ffmpeg([
        // Orientation is applied explicitly above, identically on every ffmpeg version.
        '-noautorotate',
        '-f',
        demuxer,
        '-max_pixels',
        String(this.maxImagePixels),
        '-i',
        src,
        '-filter_complex',
        graph,
        '-map',
        '[out]',
        '-frames:v',
        '1',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-c:v',
        'mjpeg',
        '-q:v',
        '2',
        // No encoder comment or other identifying data in the output.
        '-fflags',
        '+bitexact',
        '-flags:v',
        '+bitexact',
        '-f',
        'image2',
        '-update',
        '1',
        tmp,
      ]),
    );

    const out = await this.probeDetailed(path.resolve(output));
    if (!out.width || !out.height) throw new MediaError('invalid_media', 'normalizeImage produced an invalid JPEG');
    return { width: out.width, height: out.height };
  }

  async synthesizeClip(opts: {
    output: string;
    durationSec: number;
    width: number;
    height: number;
    label: string;
    imagePath?: string | null;
  }): Promise<void> {
    const { durationSec } = opts;
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600) {
      throw new MediaError('invalid_argument', `synthesizeClip: invalid duration ${String(durationSec)}`);
    }
    if (!(opts.width >= 16 && opts.height >= 16 && opts.width <= 7680 && opts.height <= 7680)) {
      throw new MediaError('invalid_argument', `synthesizeClip: invalid size ${opts.width}x${opts.height}`);
    }
    const width = evenFloor(opts.width);
    const height = evenFloor(opts.height);
    const d = durationSec.toFixed(3);
    const image = opts.imagePath ? path.resolve(opts.imagePath) : null;
    if (image) await assertInputFile(image);

    const work = await mkdtemp(path.join(this.tmpDir, 'omni-synth-'));
    try {
      // Text goes through files so the label never needs filtergraph escaping.
      await writeFile(path.join(work, 'label.txt'), wrapLabel(opts.label));
      await writeFile(path.join(work, 'clock.txt'), '%{pts:hms}');
      const font = await this.resolveFont();

      const videoInput = image
        ? ['-loop', '1', '-framerate', String(SYNTH_FPS), '-t', d, '-i', image]
        : ['-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${SYNTH_FPS}:duration=${d}`];
      // Fill the frame with the image at 115% and pan diagonally across it, so the clip visibly moves.
      const base = image
        ? `[0:v]scale=${evenFloor(width * 1.15)}:${evenFloor(height * 1.15)}:force_original_aspect_ratio=increase,` +
          `crop=${evenFloor(width * 1.15)}:${evenFloor(height * 1.15)},` +
          `crop=${width}:${height}:x='(iw-ow)*t/${d}':y='(ih-oh)*t/${d}',setsar=1,format=yuv420p`
        : `[0:v]setsar=1,format=yuv420p`;
      const fontSize = Math.max(12, Math.round(width / 20));
      const fontArg = font ? `:fontfile=${font}` : '';
      const text =
        `,drawtext=textfile=label.txt:expansion=none${fontArg}:fontcolor=white:fontsize=${fontSize}` +
        `:line_spacing=${Math.round(fontSize / 4)}:box=1:boxcolor=black@0.55:boxborderw=${Math.round(fontSize / 2)}` +
        `:x=(w-text_w)/2:y=h*0.08` +
        `,drawtext=textfile=clock.txt:expansion=normal${fontArg}:fontcolor=white:fontsize=${Math.round(fontSize * 0.8)}` +
        `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(fontSize / 3)}:x=(w-text_w)/2:y=h-text_h-h*0.06`;

      const args = (withText: boolean, tmp: string) => [
        ...videoInput,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${d}`,
        '-filter_complex',
        `${base}${withText ? text : ''}[v]`,
        '-map',
        '[v]',
        '-map',
        '1:a',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(SYNTH_FPS),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-t',
        d,
        ...mp4Out(tmp),
      ];

      await this.writeOutput(opts.output, async (tmp) => {
        if (this.fontOption === null) {
          await this.ffmpeg(args(false, tmp), { cwd: work });
          return;
        }
        try {
          await this.ffmpeg(args(true, tmp), { cwd: work });
        } catch (err) {
          if (!isRecoverable(err)) throw err;
          // drawtext needs fonts/fontconfig, which slim containers often lack: render without text.
          await rm(tmp, { force: true });
          await this.ffmpeg(args(false, tmp), { cwd: work });
        }
      });
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async probeDetailed(input: string): Promise<DetailedProbe> {
    await assertInputFile(input);
    const json = await this.ffprobeJson(['-show_format', '-show_streams', path.resolve(input)]);
    const streams = json.streams ?? [];
    if (streams.length === 0) throw new MediaError('invalid_media', `${path.basename(input)} has no media streams`);

    const video =
      streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) ??
      streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    let width = video?.width ?? null;
    let height = video?.height ?? null;
    if (video && width && height && Math.abs(streamRotation(video)) % 180 === 90) {
      // ffmpeg auto-rotates on decode, so downstream filters see the display size.
      [width, height] = [height, width];
    }
    const fpsExpr = video ? pickFrameRate(video) : null;
    const videoDurationSec = positiveNumber(video?.duration);
    const durationSec =
      positiveNumber(json.format?.duration) ?? videoDurationSec ?? positiveNumber(audio?.duration) ?? 0;

    return {
      durationSec,
      width: width || null,
      height: height || null,
      fps: fpsExpr ? parseFrameRate(fpsExpr) : null,
      hasAudio: Boolean(audio),
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      fpsExpr,
      videoDurationSec,
    };
  }

  private async ffprobeJson(args: string[]): Promise<FfprobeOutput> {
    let result: RunResult;
    try {
      result = await this.run(this.ffprobePath, ['-v', 'error', '-print_format', 'json', ...args]);
    } catch (err) {
      if (err instanceof MediaError && err.code === 'process_failed') {
        throw new MediaError('invalid_media', `Not a readable media file: ${lastLine(err.stderr)}`, {
          stderr: err.stderr,
          exitCode: err.exitCode,
          cause: err,
        });
      }
      throw err;
    }
    try {
      return JSON.parse(result.stdout.toString('utf8')) as FfprobeOutput;
    } catch (err) {
      throw new MediaError('invalid_media', 'ffprobe returned invalid JSON', { stderr: result.stderr, cause: err });
    }
  }

  private ffmpeg(args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
    return this.run(
      this.ffmpegPath,
      ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-y', ...args],
      opts,
    );
  }

  /** Spawns a tool with an argument array (no shell), enforcing the timeout and capturing output. */
  private run(bin: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
    const tool = path.basename(bin);
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const finish = (err: MediaError | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ stdout: Buffer.concat(stdout), stderr: tail(stderr) });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes < STDOUT_MAX_BYTES) {
          stdout.push(chunk);
          stdoutBytes += chunk.length;
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > STDERR_TAIL_CHARS * 4) stderr = stderr.slice(-STDERR_TAIL_CHARS * 2);
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const code: MediaErrorCode = err.code === 'ENOENT' ? 'binary_not_found' : 'spawn_failed';
        finish(new MediaError(code, `${tool} could not be started (${bin}): ${err.message}`, { cause: err }));
      });
      child.on('close', (exitCode, signal) => {
        const errTail = tail(stderr);
        if (timedOut) {
          finish(
            new MediaError('timeout', `${tool} timed out after ${Math.round(this.timeoutMs / 1000)}s`, {
              stderr: errTail,
              exitCode,
            }),
          );
        } else if (exitCode !== 0) {
          const how = exitCode === null ? `was killed by ${signal ?? 'a signal'}` : `exited with code ${exitCode}`;
          finish(
            new MediaError('process_failed', `${tool} ${how}${errTail ? `: ${errTail}` : ''}`, {
              stderr: errTail,
              exitCode,
            }),
          );
        } else {
          finish(null);
        }
      });
    });
  }

  /** Runs `produce(tmp)` for a temp file next to `output`, then renames it into place. */
  private async writeOutput(output: string, produce: (tmp: string) => Promise<unknown>): Promise<void> {
    const dest = path.resolve(output);
    const dir = path.dirname(dest);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(dest)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await produce(tmp);
      if (!(await nonEmptyFile(tmp))) {
        throw new MediaError('no_output', `ffmpeg produced no output for ${path.basename(dest)}`);
      }
      await rename(tmp, dest);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private resolveFont(): Promise<string | null> {
    this.fontLookup ??= (async () => {
      if (this.fontOption === null) return null;
      const candidates = this.fontOption ? [this.fontOption] : FONT_CANDIDATES;
      for (const candidate of candidates) {
        if (!FILTER_SAFE_PATH.test(candidate)) continue;
        try {
          await access(candidate);
          return candidate;
        } catch {
          // try the next one
        }
      }
      return null; // drawtext falls back to the fontconfig default font
    })();
    return this.fontLookup;
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported ones are pure and unit tested)
// ---------------------------------------------------------------------------

/** Parses `24/1`, `30000/1001` or `25` into frames per second. Null for `0/0` and junk. */
export function parseFrameRate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(value.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!(num > 0) || !(den > 0)) return null;
  return Math.round((num / den) * 1000) / 1000;
}

/** ffmpeg filters that turn an image stored with EXIF `orientation` (1-8) into its upright form. */
export function exifOrientationFilters(orientation: number): string[] {
  switch (orientation) {
    case 2:
      return ['hflip'];
    case 3:
      return ['hflip', 'vflip'];
    case 4:
      return ['vflip'];
    case 5:
      return ['transpose=cclock_flip'];
    case 6:
      return ['transpose=clock'];
    case 7:
      return ['transpose=clock_flip'];
    case 8:
      return ['transpose=cclock'];
    default:
      return [];
  }
}

/** Largest size with the same aspect ratio whose longest side is <= `maxSide`. Never upscales. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.min(maxSide, Math.round(width * scale))),
    height: Math.max(1, Math.min(maxSide, Math.round(height * scale))),
  };
}

/** Detects JPEG, PNG or WebP from magic bytes. */
export function sniffImageFormat(head: Uint8Array): ImageFormat | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    head.length >= 12 &&
    String.fromCharCode(...head.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...head.subarray(8, 12)) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

async function sniffImageFile(file: string): Promise<ImageFormat | null> {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return sniffImageFormat(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** EXIF orientation from frame/stream tags, falling back to the display matrix rotation. */
function readOrientation(frame: FfprobeFrame, stream: FfprobeStream): number {
  for (const tags of [frame.tags, stream.tags]) {
    for (const [k, v] of Object.entries(tags ?? {})) {
      if (k.toLowerCase() === 'orientation') {
        const n = Number.parseInt(String(v).trim(), 10);
        if (n >= 1 && n <= 8) return n;
      }
    }
  }
  const rotation = rotationOf(frame.side_data_list) ?? rotationOf(stream.side_data_list) ?? 0;
  const normalized = ((Math.round(rotation) % 360) + 360) % 360;
  if (normalized === 270) return 6;
  if (normalized === 90) return 8;
  if (normalized === 180) return 3;
  return 1;
}

function rotationOf(list: { rotation?: number | string }[] | undefined): number | null {
  for (const sd of list ?? []) {
    const r = Number(sd.rotation);
    if (sd.rotation !== undefined && Number.isFinite(r)) return r;
  }
  return null;
}

function streamRotation(stream: FfprobeStream): number {
  const fromSideData = rotationOf(stream.side_data_list);
  if (fromSideData !== null) return Math.round(fromSideData);
  const tag = Number(stream.tags?.rotate);
  return Number.isFinite(tag) ? Math.round(tag) : 0;
}

function pickFrameRate(stream: FfprobeStream): string | null {
  for (const candidate of [stream.avg_frame_rate, stream.r_frame_rate]) {
    const fps = parseFrameRate(candidate);
    if (candidate && fps !== null && fps >= 1 && fps <= 240) return candidate.trim();
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function h264Aac(): string[] {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'];
}

function mp4Out(file: string): string[] {
  return ['-movflags', '+faststart', '-f', 'mp4', file];
}

/** Errors worth a second attempt with a different strategy (not timeouts or a missing binary). */
function isRecoverable(err: unknown): boolean {
  return err instanceof MediaError && err.code === 'process_failed';
}

async function assertInputFile(file: string): Promise<void> {
  try {
    const st = await stat(file);
    if (st.isFile()) return;
  } catch {
    // fall through
  }
  throw new MediaError('input_not_found', `Input file not found: ${path.basename(file)}`);
}

async function nonEmptyFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

function evenFloor(n: number): number {
  const i = Math.floor(n);
  return Math.max(2, i - (i % 2));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? trimmed.slice(-STDERR_TAIL_CHARS) : trimmed;
}

function lastLine(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  return (lines[lines.length - 1] ?? 'unknown error').trim().slice(0, 300);
}

/** Label for drawtext: printable characters only, wrapped to about 26 characters, at most 3 lines. */
function wrapLabel(label: string): string {
  const printable = Array.from(label, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('');
  const clean = printable.trim() || 'Preview';
  const lines: string[] = [];
  let line = '';
  for (const word of clean.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 26 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines
    .slice(0, 3)
    .map((l) => l.slice(0, 40))
    .join('\n');
}
