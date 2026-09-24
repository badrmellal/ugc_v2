import { createHash } from 'node:crypto';

export type RangeResult = { kind: 'none' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a single-range `Range` header (RFC 9110 section 14): `bytes=start-end`, `bytes=start-`,
 * `bytes=-suffix`. Malformed headers, other units and multi-range requests are ignored (the full
 * representation is served), as the RFC allows.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const match = SINGLE_RANGE.exec(header.replace(/\s+/g, ''));
  if (!match) return { kind: 'none' };
  const [, startStr = '', endStr = ''] = match;
  if (startStr === '' && endStr === '') return { kind: 'none' };

  if (startStr === '') {
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix)) return { kind: 'none' };
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start)) return { kind: 'none' };
  if (endStr !== '') {
    const lastByte = Number(endStr);
    // A last-byte-pos below the first-byte-pos makes the range-spec invalid: ignore the header.
    if (!Number.isSafeInteger(lastByte) || lastByte < start) return { kind: 'none' };
  }
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  return { kind: 'range', start, end };
}

/** Weak validator derived from the storage key and size (objects are written once per key). */
export function weakEtag(key: string, size: number): string {
  const digest = createHash('sha1').update(`${key}:${size}`).digest('base64url').slice(0, 22);
  return `W/"${digest}"`;
}

function opaque(tag: string): string {
  const t = tag.trim();
  return t.startsWith('W/') ? t.slice(2) : t;
}

/** Weak comparison for If-None-Match (RFC 9110 section 13.1.2). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const want = opaque(etag);
  return ifNoneMatch.split(',').some((candidate) => opaque(candidate) === want);
}

/**
 * If-Range: the Range header only applies when the validator still matches. Weak validators and
 * dates cannot be used for If-Range, but because our tags change whenever the object changes we
 * accept a weak match of our own tag.
 */
export function ifRangeAllows(ifRange: string | undefined, etag: string): boolean {
  if (!ifRange) return true;
  const value = ifRange.trim();
  if (!value.startsWith('"') && !value.startsWith('W/')) return false;
  return opaque(value) === opaque(etag);
}

/** ASCII-only, filesystem-safe slug for download file names. */
export function slugify(title: string, maxLength = 50): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'omni-video';
}

export function downloadFileName(title: string, id: string): string {
  return `${slugify(title)}-${id.slice(0, 8)}.mp4`;
}
