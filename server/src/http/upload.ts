import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import { LIMITS } from '../shared/api.js';
import { HttpError, validationError } from './errors.js';

export const PAYLOAD_FIELD = 'payload';
export const IMAGE_FIELD = 'characterImage';

export interface ParsedUpload {
  /** Raw `payload` field: a JSON string, or an already parsed value when sent as application/json. */
  payload: unknown;
  image: { path: string; size: number } | null;
}

const imageLimitMb = Math.round(LIMITS.imageMaxBytes / (1024 * 1024));

export function imageTooLarge(): HttpError {
  return new HttpError(
    413,
    'payload_too_large',
    `The character image is larger than ${imageLimitMb} MB. Upload a smaller JPEG, PNG or WebP image.`,
  );
}

export function uploadInterrupted(): HttpError {
  return validationError(
    'The upload was interrupted or is not a valid multipart/form-data body. Send it again with a "payload" field and a "characterImage" file.',
  );
}

/**
 * Errors of the multipart parser (busboy) for truncated or malformed bodies carry no code, and a file
 * stream torn down mid-upload ends with ERR_STREAM_PREMATURE_CLOSE. Both are client errors. Coded
 * system errors (ENOSPC, EACCES...) while writing the temp file stay server errors.
 */
function isMalformedUploadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Programming errors are never the client's fault.
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) return false;
  const code = (err as { code?: unknown }).code;
  return code === undefined || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET';
}

/**
 * Reads the multipart create request: the `payload` field and the `characterImage` file, which is
 * streamed to `dir` (never buffered whole in memory). Parts may arrive in any order.
 */
export async function readGenerationUpload(req: FastifyRequest, dir: string): Promise<ParsedUpload> {
  let payload: unknown = undefined;
  let image: ParsedUpload['image'] = null;
  const unexpected: string[] = [];

  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== IMAGE_FIELD || image) {
          unexpected.push(part.fieldname);
          part.file.resume();
          continue;
        }
        // When a small body ends mid-file, the parser tears the file stream down before it is handed
        // over; piping an already destroyed stream would never settle.
        if (part.file.destroyed || part.file.errored) throw uploadInterrupted();
        const dest = join(dir, 'upload.bin');
        await pipeline(part.file, createWriteStream(dest, { mode: 0o600 }));
        if (part.file.truncated) throw imageTooLarge();
        image = { path: dest, size: (await stat(dest)).size };
      } else if (part.fieldname === PAYLOAD_FIELD) {
        if (part.valueTruncated) {
          throw new HttpError(413, 'payload_too_large', 'The "payload" field is too large.');
        }
        payload = part.value;
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isMalformedUploadError(err)) {
      req.log.info({ err }, 'malformed or interrupted upload');
      throw uploadInterrupted();
    }
    throw err;
  }

  if (unexpected.length) {
    throw validationError(`Unexpected file field "${unexpected[0]}". Send exactly one image as "${IMAGE_FIELD}".`);
  }
  return { payload, image };
}

/** Parses the `payload` field (JSON text or pre-parsed JSON). */
export function parsePayloadField(raw: unknown): unknown {
  if (raw === undefined) throw validationError(`The "${PAYLOAD_FIELD}" field is required.`);
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw validationError(`The "${PAYLOAD_FIELD}" field must be valid JSON.`);
  }
}

/**
 * Identifies the image by its magic bytes (the client-declared type is ignored) and returns its MIME
 * type. Throws 415 unless it is JPEG, PNG or WebP.
 */
export async function sniffImage(path: string, size: number): Promise<string> {
  if (size === 0) throw validationError('The character image is empty.');
  const handle = await open(path, 'r');
  let head: Buffer;
  try {
    head = Buffer.alloc(Math.min(size, 4100));
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  const type = await fileTypeFromBuffer(head);
  if (!type || !LIMITS.imageMimeTypes.includes(type.mime)) {
    const detected = type ? ` This file looks like ${type.ext.toUpperCase()}.` : '';
    throw new HttpError(
      415,
      'unsupported_media_type',
      `The character image must be a JPEG, PNG or WebP file.${detected}`,
    );
  }
  return type.mime;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
