import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  FfmpegMediaTools,
  MediaError,
  createMediaTools,
  exifOrientationFilters,
  fitWithin,
  parseFrameRate,
  sniffImageFormat,
} from '../src/media/ffmpeg.js';
import {
  colorName,
  ffmpegSync,
  jpegMarkers,
  mp4TopLevelBoxes,
  quadrants,
  readRgb,
  writeExifJpeg,
} from './helpers/media.js';

let dir: string;
const media = new FfmpegMediaTools({ timeoutMs: 60_000 });
const p = (name: string) => path.join(dir, name);

/** Expected upright quadrant colors for a stored `RG/BY` image with each EXIF orientation. */
const ORIENTED: Record<number, { quads: string; portrait: boolean }> = {
  1: { quads: 'RGBY', portrait: false },
  2: { quads: 'GRYB', portrait: false },
  3: { quads: 'YBGR', portrait: false },
  4: { quads: 'BYRG', portrait: false },
  5: { quads: 'RBGY', portrait: true },
  6: { quads: 'BRYG', portrait: true },
  7: { quads: 'YGBR', portrait: true },
  8: { quads: 'GYRB', portrait: true },
};

async function expectMediaError(promise: Promise<unknown>, code: string): Promise<MediaError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MediaError);
  expect((err as MediaError).code).toBe(code);
  return err as MediaError;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'omni-media-test-'));
  // Two-color PNG used as the character image of the mock clip.
  ffmpegSync([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=200x300[l];color=c=blue:s=200x300[r];[l][r]hstack',
    '-frames:v',
    '1',
    p('character.png'),
  ]);
  await media.synthesizeClip({ output: p('a.mp4'), durationSec: 2, width: 360, height: 640, label: 'Part 1 (0-10s)' });
  await media.synthesizeClip({
    output: p('b.mp4'),
    durationSec: 2,
    width: 360,
    height: 640,
    label: 'Part 2 (10-20s) with a longer label that has to wrap over lines',
    imagePath: p('character.png'),
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('synthesizeClip + probe', () => {
  it('synthesizes a test pattern clip with audio', async () => {
    const info = await media.probe(p('a.mp4'));
    expect(info.durationSec).toBeGreaterThan(1.9);
    expect(info.durationSec).toBeLessThan(2.1);
    expect(info).toMatchObject({
      width: 360,
      height: 640,
      fps: 24,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  it('synthesizes a moving clip from an image', async () => {
    const info = await media.probe(p('b.mp4'));
    expect(info.durationSec).toBeGreaterThan(1.9);
    expect(info.durationSec).toBeLessThan(2.1);
    expect(info).toMatchObject({ width: 360, height: 640, fps: 24, hasAudio: true, videoCodec: 'h264' });

    // The image fills the frame (red and blue halves) and the frame content changes over time.
    const early = ffmpegSync([
      '-ss',
      '0.1',
      '-i',
      p('b.mp4'),
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const late = ffmpegSync([
      '-ss',
      '1.8',
      '-i',
      p('b.mp4'),
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    expect(early.equals(late)).toBe(false);
    ffmpegSync(['-ss', '1', '-i', p('b.mp4'), '-frames:v', '1', '-update', '1', p('b-frame.png')]);
    const frame = readRgb(p('b-frame.png'));
    expect(colorName(frame.at(20, 320))).toBe('R');
    expect(colorName(frame.at(340, 320))).toBe('B');
  });

  it('falls back to a clip without text when drawtext cannot load the font', async () => {
    // A PNG is not a font: drawtext fails and the clip is rendered without captions.
    const tools = new FfmpegMediaTools({ fontFile: p('character.png') });
    await tools.synthesizeClip({ output: p('nofont.mp4'), durationSec: 1, width: 180, height: 320, label: 'x' });
    const info = await tools.probe(p('nofont.mp4'));
    expect(info).toMatchObject({ width: 180, height: 320, hasAudio: true });
  });

  it('can skip text entirely and rounds odd sizes down to even', async () => {
    const tools = new FfmpegMediaTools({ fontFile: null });
    await tools.synthesizeClip({ output: p('notext.mp4'), durationSec: 1, width: 181, height: 321, label: 'x' });
    expect(await tools.probe(p('notext.mp4'))).toMatchObject({ width: 180, height: 320 });
  });

  it('rejects invalid synthesis arguments', async () => {
    await expectMediaError(
      media.synthesizeClip({ output: p('x.mp4'), durationSec: 0, width: 360, height: 640, label: 'x' }),
      'invalid_argument',
    );
    await expectMediaError(
      media.synthesizeClip({ output: p('x.mp4'), durationSec: 1, width: 4, height: 640, label: 'x' }),
      'invalid_argument',
    );
  });
});

describe('concat', () => {
  it('joins two clips into one continuous file', async () => {
    await media.concat([p('a.mp4'), p('b.mp4')], p('ab.mp4'));
    const info = await media.probe(p('ab.mp4'));
    expect(info.durationSec).toBeGreaterThan(3.9);
    expect(info.durationSec).toBeLessThan(4.15);
    expect(info).toMatchObject({
      width: 360,
      height: 640,
      fps: 24,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    const boxes = mp4TopLevelBoxes(p('ab.mp4'));
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
  });

  it('synthesizes silence for inputs without audio', async () => {
    ffmpegSync(['-i', p('b.mp4'), '-an', '-c', 'copy', p('b-silent.mp4')]);
    expect((await media.probe(p('b-silent.mp4'))).hasAudio).toBe(false);

    await media.concat([p('a.mp4'), p('b-silent.mp4')], p('a-silent.mp4'));
    const info = await media.probe(p('a-silent.mp4'));
    expect(info.hasAudio).toBe(true);
    expect(info.audioCodec).toBe('aac');
    expect(info.durationSec).toBeGreaterThan(3.9);
    expect(info.durationSec).toBeLessThan(4.15);
  });

  it('scales later inputs to the first input size and frame rate', async () => {
    ffmpegSync([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=480x720:rate=30:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=44100:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '1',
      p('other.mp4'),
    ]);
    await media.concat([p('a.mp4'), p('other.mp4')], p('mixed.mp4'));
    const info = await media.probe(p('mixed.mp4'));
    expect(info).toMatchObject({ width: 360, height: 640, fps: 24, hasAudio: true });
    expect(info.durationSec).toBeGreaterThan(2.9);
    expect(info.durationSec).toBeLessThan(3.15);
  });

  it('accepts a single input (faststart copy)', async () => {
    await media.concat([p('a.mp4')], p('single.mp4'));
    const info = await media.probe(p('single.mp4'));
    expect(info.width).toBe(360);
    expect(info.durationSec).toBeCloseTo(2, 1);
  });

  it('rejects an empty input list', async () => {
    await expectMediaError(media.concat([], p('none.mp4')), 'invalid_argument');
  });
});

describe('faststart', () => {
  it('moves the moov atom to the front without re-encoding', async () => {
    ffmpegSync(['-i', p('a.mp4'), '-c', 'copy', p('slow.mp4')]);
    const before = mp4TopLevelBoxes(p('slow.mp4'));
    expect(before.indexOf('moov')).toBeGreaterThan(before.indexOf('mdat'));

    await media.faststart(p('slow.mp4'), p('fast.mp4'));
    const after = mp4TopLevelBoxes(p('fast.mp4'));
    expect(after.indexOf('moov')).toBeLessThan(after.indexOf('mdat'));
    expect(await media.probe(p('fast.mp4'))).toMatchObject({ width: 360, height: 640, videoCodec: 'h264' });
  });

  it('re-encodes when the streams cannot be copied into MP4', async () => {
    ffmpegSync([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=180x320:rate=24:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:v',
      'ffv1',
      '-c:a',
      'libvorbis',
      p('lossless.mkv'),
    ]);
    await media.faststart(p('lossless.mkv'), p('reencoded.mp4'));
    expect(await media.probe(p('reencoded.mp4'))).toMatchObject({
      width: 180,
      height: 320,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  it('can rewrite a file in place', async () => {
    ffmpegSync(['-i', p('a.mp4'), '-c', 'copy', p('inplace.mp4')]);
    await media.faststart(p('inplace.mp4'), p('inplace.mp4'));
    const boxes = mp4TopLevelBoxes(p('inplace.mp4'));
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
  });
});

describe('thumbnail', () => {
  it('extracts a JPEG frame', async () => {
    await media.thumbnail(p('ab.mp4'), p('thumbs/poster.jpg'), 1);
    const buf = await readFile(p('thumbs/poster.jpg'));
    expect(sniffImageFormat(buf)).toBe('jpeg');
    expect(await media.probe(p('thumbs/poster.jpg'))).toMatchObject({ width: 360, height: 640, videoCodec: 'mjpeg' });
  });

  it('clamps positions past the end and before the start', async () => {
    await media.thumbnail(p('a.mp4'), p('late.jpg'), 999);
    await media.thumbnail(p('a.mp4'), p('early.jpg'), -5);
    expect((await readFile(p('late.jpg'))).length).toBeGreaterThan(0);
    expect((await readFile(p('early.jpg'))).length).toBeGreaterThan(0);
  });

  it('leaves no temp files behind', async () => {
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('normalizeImage', () => {
  it('downscales a large PNG with alpha, flattening transparency on white', async () => {
    ffmpegSync(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=3000x2000,format=rgba', '-frames:v', '1', p('big.png')]);
    const out = await media.normalizeImage(p('big.png'), p('big.jpg'), 1024);
    expect(out).toEqual({ width: 1024, height: 683 });

    const buf = await readFile(p('big.jpg'));
    expect(sniffImageFormat(buf)).toBe('jpeg');
    const markers = jpegMarkers(buf);
    expect(markers).toContain(0xc0); // baseline
    expect(markers).not.toContain(0xc2); // not progressive
    expect(markers).not.toContain(0xe1); // no EXIF / XMP
    expect(markers).not.toContain(0xfe); // no comment
    expect(colorName(readRgb(p('big.jpg')).at(500, 300))).toBe('W');
  });

  it('never upscales small images', async () => {
    // RGB PNG so odd dimensions survive the fixture itself.
    ffmpegSync(['-f', 'lavfi', '-i', 'color=c=red:s=201x99,format=rgb24', '-frames:v', '1', p('small.png')]);
    expect(await media.normalizeImage(p('small.png'), p('small.jpg'), 1024)).toEqual({ width: 201, height: 99 });
    expect(colorName(readRgb(p('small.jpg')).at(100, 50))).toBe('R');
  });

  it('handles WebP with alpha', async () => {
    ffmpegSync([
      '-f',
      'lavfi',
      '-i',
      'color=c=black@0.0:s=800x400,format=rgba',
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-lossless',
      '1',
      p('alpha.webp'),
    ]);
    expect(await media.normalizeImage(p('alpha.webp'), p('alpha-out.jpg'), 400)).toEqual({ width: 400, height: 200 });
    expect(colorName(readRgb(p('alpha-out.jpg')).at(100, 100))).toBe('W');
  });

  it('applies all eight EXIF orientations and strips the EXIF block', async () => {
    ffmpegSync([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x32[a];color=c=lime:s=64x32[b];color=c=blue:s=64x32[c];color=c=yellow:s=64x32[d];' +
        '[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack',
      '-frames:v',
      '1',
      '-q:v',
      '2',
      p('quad.jpg'),
    ]);
    for (const [o, expected] of Object.entries(ORIENTED)) {
      const src = p(`exif-${o}.jpg`);
      const out = p(`exif-${o}-out.jpg`);
      writeExifJpeg(p('quad.jpg'), src, Number(o));
      expect(jpegMarkers(await readFile(src))).toContain(0xe1);

      const size = await media.normalizeImage(src, out, 2048);
      expect(size, `orientation ${o}`).toEqual(
        expected.portrait ? { width: 64, height: 128 } : { width: 128, height: 64 },
      );
      expect(quadrants(out), `orientation ${o}`).toBe(expected.quads);
      expect(jpegMarkers(await readFile(out))).not.toContain(0xe1);
    }
  });

  it('applies orientation before fitting the longest side', async () => {
    const out = await media.normalizeImage(p('exif-6.jpg'), p('exif-6-small.jpg'), 32);
    expect(out).toEqual({ width: 16, height: 32 });
  });

  it('rejects files that are not JPEG, PNG or WebP', async () => {
    await writeFile(p('notes.txt'), 'hello, this is not an image');
    await expectMediaError(media.normalizeImage(p('notes.txt'), p('notes.jpg'), 1024), 'unsupported_format');
    // An MP4 is rejected by the magic byte check too, even with an image extension.
    await writeFile(p('video.jpg'), await readFile(p('a.mp4')));
    await expectMediaError(media.normalizeImage(p('video.jpg'), p('video-out.jpg'), 1024), 'unsupported_format');
  });

  it('rejects images above the pixel limit before decoding', async () => {
    const tools = new FfmpegMediaTools({ maxImagePixels: 1_000_000 });
    await expectMediaError(tools.normalizeImage(p('big.png'), p('bomb.jpg'), 1024), 'image_too_large');
  });

  it('rejects a corrupt image', async () => {
    const png = await readFile(p('big.png'));
    await writeFile(p('corrupt.png'), png.subarray(0, 64));
    const err = await media.normalizeImage(p('corrupt.png'), p('corrupt.jpg'), 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
  });

  it('rejects an invalid maxSide', async () => {
    await expectMediaError(media.normalizeImage(p('small.png'), p('bad.jpg'), 0), 'invalid_argument');
  });
});

describe('errors', () => {
  it('throws MediaError when probing a non-video file', async () => {
    // ffmpeg would happily render a .txt file as "ANSI art" video; the demuxer whitelist refuses it.
    await writeFile(p('plain.txt'), 'definitely not a video\n'.repeat(20));
    const err = await expectMediaError(media.probe(p('plain.txt')), 'invalid_media');
    expect(err.stderr.length).toBeGreaterThan(0);
    expect(err.stderr.length).toBeLessThanOrEqual(2000);

    await writeFile(p('garbage.mp4'), Buffer.alloc(4096, 0x5a));
    await expectMediaError(media.probe(p('garbage.mp4')), 'invalid_media');
  });

  it('refuses playlist inputs that could reference other files', async () => {
    await writeFile(p('list.m3u8'), `#EXTM3U\n#EXTINF:2,\nfile://${p('a.mp4')}\n#EXT-X-ENDLIST\n`);
    await expectMediaError(media.probe(p('list.m3u8')), 'invalid_media');
    await expectMediaError(media.faststart(p('list.m3u8'), p('list.mp4')), 'process_failed');
  });

  it('reports missing input files', async () => {
    await expectMediaError(media.probe(p('missing.mp4')), 'input_not_found');
    await expectMediaError(media.faststart(p('missing.mp4'), p('out.mp4')), 'input_not_found');
  });

  it('reports a missing binary', async () => {
    const tools = new FfmpegMediaTools({ ffprobePath: path.join(dir, 'no-such-ffprobe') });
    await expectMediaError(tools.probe(p('a.mp4')), 'binary_not_found');
  });

  it('kills the process on timeout', async () => {
    const tools = new FfmpegMediaTools({ timeoutMs: 100, fontFile: null });
    await expectMediaError(
      tools.synthesizeClip({ output: p('slow-synth.mp4'), durationSec: 300, width: 1080, height: 1920, label: 'x' }),
      'timeout',
    );
    expect((await readdir(dir)).filter((f) => f.startsWith('.slow-synth'))).toEqual([]);
  });

  it('includes truncated stderr in process failures', async () => {
    const err = await expectMediaError(media.faststart(p('plain.txt'), p('plain.mp4')), 'process_failed');
    expect(err.message).toContain('ffmpeg exited with code');
    expect(err.stderr.length).toBeLessThanOrEqual(2000);
  });
});

describe('configuration', () => {
  it('builds the tools from the media settings', () => {
    const tools = createMediaTools(
      loadConfig({
        GEMINI_MOCK: 'true',
        FFMPEG_PATH: '/opt/ffmpeg/bin/ffmpeg',
        FFPROBE_PATH: '/opt/ffmpeg/bin/ffprobe',
        MEDIA_TIMEOUT_SEC: '900',
      }),
    );
    expect(tools).toMatchObject({
      ffmpegPath: '/opt/ffmpeg/bin/ffmpeg',
      ffprobePath: '/opt/ffmpeg/bin/ffprobe',
      timeoutMs: 900_000,
    });
  });

  it('defaults to the same timeout as MEDIA_TIMEOUT_SEC', () => {
    expect(new FfmpegMediaTools().timeoutMs).toBe(loadConfig({ GEMINI_MOCK: 'true' }).media.timeoutMs);
  });
});

describe('helpers', () => {
  it('parses frame rates', () => {
    expect(parseFrameRate('24/1')).toBe(24);
    expect(parseFrameRate('30000/1001')).toBe(29.97);
    expect(parseFrameRate('25')).toBe(25);
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate('abc')).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });

  it('fits sizes without upscaling', () => {
    expect(fitWithin(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(3000, 4000, 1024)).toEqual({ width: 768, height: 1024 });
    expect(fitWithin(500, 300, 1024)).toEqual({ width: 500, height: 300 });
    expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });

  it('maps EXIF orientations to filters', () => {
    expect(exifOrientationFilters(1)).toEqual([]);
    expect(exifOrientationFilters(6)).toEqual(['transpose=clock']);
    expect(exifOrientationFilters(8)).toEqual(['transpose=cclock']);
    expect(exifOrientationFilters(42)).toEqual([]);
  });

  it('sniffs image formats', () => {
    expect(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageFormat(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'))).toBe('png');
    expect(sniffImageFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('webp');
    expect(sniffImageFormat(Buffer.from('GIF89a'))).toBeNull();
  });
});
