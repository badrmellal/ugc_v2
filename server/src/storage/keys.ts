/**
 * Storage key rules shared by every driver, plus the key layout of a generation.
 *
 * Keys are always generated server-side, but they are still validated strictly so a bug
 * elsewhere can never turn into a path traversal on disk or a write outside the bucket prefix.
 */

export const MAX_KEY_LENGTH = 512;

const KEY_CHARS = /^[A-Za-z0-9/_.-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StorageErrorCode = 'invalid_key' | 'invalid_range' | 'not_found' | 'unavailable';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode, message: string, opts: { cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'StorageError';
    this.code = code;
  }
}

/** True when `err` means the object does not exist (for mapping to HTTP 404). */
export function isStorageNotFound(err: unknown): boolean {
  return err instanceof StorageError && err.code === 'not_found';
}

/**
 * Validates an object key and returns it unchanged.
 * Allowed: `[A-Za-z0-9/_.-]`, max 512 chars, no leading slash, no empty, `.` or `..` segments.
 */
export function assertValidKey(key: string, what = 'key'): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StorageError('invalid_key', `Invalid storage ${what}: must be a non-empty string`);
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new StorageError('invalid_key', `Invalid storage ${what}: longer than ${MAX_KEY_LENGTH} characters`);
  }
  if (!KEY_CHARS.test(key)) {
    throw new StorageError(
      'invalid_key',
      `Invalid storage ${what} "${printable(key)}": only A-Z a-z 0-9 / _ . - allowed`,
    );
  }
  if (key.startsWith('/')) {
    throw new StorageError('invalid_key', `Invalid storage ${what} "${key}": must be relative`);
  }
  for (const segment of key.split('/')) {
    if (segment === '') {
      throw new StorageError('invalid_key', `Invalid storage ${what} "${key}": empty path segment`);
    }
    if (segment === '.' || segment === '..') {
      throw new StorageError('invalid_key', `Invalid storage ${what} "${key}": relative path segment`);
    }
  }
  return key;
}

/** Like `assertValidKey`, but a single trailing slash is allowed (`generations/<id>/`). */
export function assertValidPrefix(prefix: string): string {
  if (typeof prefix !== 'string' || prefix.length === 0 || prefix === '/') {
    throw new StorageError('invalid_key', 'Invalid storage prefix: must be a non-empty relative path');
  }
  assertValidKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix, 'prefix');
  return prefix;
}

export function assertValidRange(range: { start: number; end: number }): void {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new StorageError('invalid_range', `Invalid byte range ${String(start)}-${String(end)}`);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  json: 'application/json',
};

/** Content type inferred from the key extension (`application/octet-stream` when unknown). */
export function contentTypeForKey(key: string): string {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return CONTENT_TYPES[base.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

export function isUuid(value: string): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface GenerationKeys {
  characterImage: string;
  part1: string;
  part2: string;
  final: string;
  thumbnail: string;
  /** Prefix holding every object of the generation (for `deletePrefix`). */
  prefix: string;
}

/** Object keys of one generation. `id` must be a UUID (normalized to lowercase). */
export function generationKeys(id: string): GenerationKeys {
  if (!isUuid(id)) {
    throw new StorageError('invalid_key', `Invalid generation id "${printable(id)}": expected a UUID`);
  }
  const base = `generations/${id.toLowerCase()}`;
  return {
    characterImage: `${base}/character.jpg`,
    part1: `${base}/part1.mp4`,
    part2: `${base}/part2.mp4`,
    final: `${base}/final.mp4`,
    thumbnail: `${base}/thumbnail.jpg`,
    prefix: `${base}/`,
  };
}

/** Safe, bounded rendering of untrusted input inside error messages. */
function printable(value: unknown): string {
  return String(value)
    .slice(0, 80)
    .replace(/[^\x20-\x7e]/g, '?');
}
