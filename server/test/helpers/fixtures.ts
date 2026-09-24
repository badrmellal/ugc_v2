import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { DEFAULT_SETTINGS, type GenerationSettings } from '../../src/shared/api.js';

export const SAMPLE_SCRIPT =
  'Okay, so I finally tried the new cold brew kit. It takes five minutes to set up and tastes amazing. ' +
  'Honestly, this is the smoothest coffee I have made at home, and cleanup takes seconds. Link is in my bio.';

export const SAMPLE_SETTINGS: GenerationSettings = { ...DEFAULT_SETTINGS, style: 'ugc', resolution: '720p' };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid RGB PNG with a simple gradient (decodable by ffmpeg and detected by file-type). */
export function makePng(width = 32, height = 48): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = y * row + 1 + x * 3;
      raw[i] = Math.round((x / width) * 255);
      raw[i + 1] = Math.round((y / height) * 255);
      raw[i + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export type MultipartPart =
  | { name: string; value: string; contentType?: string }
  | { name: string; filename: string; contentType: string; data: Buffer };

/** Builds a multipart/form-data body for app.inject(). */
export function multipart(parts: MultipartPart[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----omni-test-${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
        ),
        part.data,
      );
    } else {
      const type = part.contentType ? `Content-Type: ${part.contentType}\r\n` : '';
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n${type}\r\n${part.value}`));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** The standard create request: `payload` JSON + a PNG `characterImage`. */
export function createRequest(
  payload: unknown = { script: SAMPLE_SCRIPT, settings: SAMPLE_SETTINGS },
  image: { data: Buffer; contentType?: string; filename?: string } = { data: makePng() },
) {
  return multipart([
    { name: 'payload', value: JSON.stringify(payload) },
    {
      name: 'characterImage',
      filename: image.filename ?? 'character.png',
      contentType: image.contentType ?? 'image/png',
      data: image.data,
    },
  ]);
}
