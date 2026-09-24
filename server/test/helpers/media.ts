/** Fixture helpers for media tests. They call the real ffmpeg/ffprobe binaries synchronously. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export function ffmpegSync(args: string[]): Buffer {
  return execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Decodes the first frame of `file` to packed RGB24 and returns a pixel reader. */
export function readRgb(file: string): { width: number; height: number; at: (x: number, y: number) => number[] } {
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file]).toString(),
  ) as { streams: { width: number; height: number }[] };
  const { width, height } = probe.streams[0]!;
  const raw = ffmpegSync(['-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return {
    width,
    height,
    at: (x, y) => {
      const i = (y * width + x) * 3;
      return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
    },
  };
}

/** Classifies a pixel as one of the pure test colors (R, G, B, Y, W, K) or `?`. */
export function colorName([r, g, b]: number[]): string {
  const hi = (v: number | undefined) => (v ?? 0) > 180;
  const lo = (v: number | undefined) => (v ?? 0) < 80;
  if (hi(r) && lo(g) && lo(b)) return 'R';
  if (lo(r) && hi(g) && lo(b)) return 'G';
  if (lo(r) && lo(g) && hi(b)) return 'B';
  if (hi(r) && hi(g) && lo(b)) return 'Y';
  if (hi(r) && hi(g) && hi(b)) return 'W';
  if (lo(r) && lo(g) && lo(b)) return 'K';
  return '?';
}

/** Colors at the centers of the four quadrants: top-left, top-right, bottom-left, bottom-right. */
export function quadrants(file: string): string {
  const img = readRgb(file);
  const xs = [Math.floor(img.width / 4), Math.floor((3 * img.width) / 4)];
  const ys = [Math.floor(img.height / 4), Math.floor((3 * img.height) / 4)];
  return [img.at(xs[0]!, ys[0]!), img.at(xs[1]!, ys[0]!), img.at(xs[0]!, ys[1]!), img.at(xs[1]!, ys[1]!)]
    .map(colorName)
    .join('');
}

/** Inserts a minimal EXIF APP1 segment (big-endian TIFF, IFD0 with only Orientation) after SOI. */
export function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  // prettier-ignore
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // header: "MM", 42, IFD0 at offset 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation SHORT
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const length = payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

export function writeExifJpeg(source: string, dest: string, orientation: number): void {
  writeFileSync(dest, withExifOrientation(readFileSync(source), orientation));
}

/** JPEG marker bytes (the byte after 0xFF) of every segment before the image data. */
export function jpegMarkers(jpeg: Buffer): number[] {
  const markers: number[] = [];
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1]!;
    markers.push(marker);
    if (marker === 0xda) break; // start of scan
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return markers;
}

/** Top-level ISO BMFF box types in file order (`ftyp`, `moov`, `mdat`, ...). */
export function mp4TopLevelBoxes(file: string): string[] {
  const buf = readFileSync(file);
  const boxes: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(i + 8));
    else if (size === 0) size = buf.length - i;
    boxes.push(type);
    if (size < 8) break;
    i += size;
  }
  return boxes;
}
