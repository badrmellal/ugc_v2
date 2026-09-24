import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { GenerationRecord } from '../src/core/ports.js';
import { helmetOptions, storageOrigins } from '../src/http/app.js';
import {
  isApiPath,
  isAuthEnabled,
  passwordMatches,
  signSession,
  tokenMatches,
  verifySession,
} from '../src/http/auth.js';
import { startOfUtcDay } from '../src/http/budget.js';
import { canRegeneratePart2, PART1_REUSE_MAX_AGE_MS, toGenerationDTO, toListItem } from '../src/http/dto.js';
import { downloadFileName, etagMatches, ifRangeAllows, parseRange, slugify, weakEtag } from '../src/http/range.js';
import { deriveTitle } from '../src/http/routes/generations.js';
import { regenerateRequestSchema, settingsSchema, stripControlChars } from '../src/http/schemas.js';
import { createErrorSerializer } from '../src/logger.js';
import { DEFAULT_SETTINGS } from '../src/shared/api.js';

const SECRET = 'unit-test-secret-unit-test-secret-0123456789';

function config(env: Record<string, string | undefined> = {}) {
  return loadConfig({ NODE_ENV: 'test', GEMINI_MOCK: 'true', LOG_LEVEL: 'silent', ...env });
}

describe('parseRange', () => {
  const size = 1000;
  it.each([
    [undefined, { kind: 'none' }],
    ['', { kind: 'none' }],
    ['bytes=0-99', { kind: 'range', start: 0, end: 99 }],
    ['bytes=0-0', { kind: 'range', start: 0, end: 0 }],
    ['bytes=500-', { kind: 'range', start: 500, end: 999 }],
    ['bytes=-100', { kind: 'range', start: 900, end: 999 }],
    ['bytes=-5000', { kind: 'range', start: 0, end: 999 }],
    ['bytes=900-5000', { kind: 'range', start: 900, end: 999 }],
    [' bytes = 10 - 20 ', { kind: 'range', start: 10, end: 20 }],
    ['bytes=1000-', { kind: 'unsatisfiable' }],
    ['bytes=1000-1001', { kind: 'unsatisfiable' }],
    ['bytes=-0', { kind: 'unsatisfiable' }],
    ['bytes=20-10', { kind: 'none' }],
    ['bytes=-', { kind: 'none' }],
    ['bytes=0-1,5-6', { kind: 'none' }],
    ['items=0-1', { kind: 'none' }],
    ['bytes=abc-def', { kind: 'none' }],
    ['bytes=99999999999999999999-', { kind: 'none' }],
  ])('%s', (header, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it('treats any range of an empty file as unsatisfiable', () => {
    expect(parseRange('bytes=0-10', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('ETags', () => {
  const etag = weakEtag('generations/x/final.mp4', 1234);

  it('are weak, stable and change with the size', () => {
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(weakEtag('generations/x/final.mp4', 1234)).toBe(etag);
    expect(weakEtag('generations/x/final.mp4', 1235)).not.toBe(etag);
  });

  it('match If-None-Match with weak comparison', () => {
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(etag.slice(2), etag)).toBe(true);
    expect(etagMatches(`W/"other", ${etag}`, etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('W/"other"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
  });

  it('gate ranges with If-Range', () => {
    expect(ifRangeAllows(undefined, etag)).toBe(true);
    expect(ifRangeAllows(etag, etag)).toBe(true);
    expect(ifRangeAllows('W/"stale"', etag)).toBe(false);
    expect(ifRangeAllows('Wed, 21 Oct 2015 07:28:00 GMT', etag)).toBe(false);
  });
});

describe('download names and titles', () => {
  it('slugifies to safe ASCII', () => {
    expect(slugify('Crème Brûlée: the SCIENCE!')).toBe('creme-brulee-the-science');
    expect(slugify('日本語のタイトル')).toBe('omni-video');
    expect(slugify('a'.repeat(80))).toHaveLength(50);
    expect(slugify('"quotes"; and\\slashes/')).toBe('quotes-and-slashes');
    expect(downloadFileName('Hello world', '12345678-aaaa-bbbb-cccc-dddddddddddd')).toBe('hello-world-12345678.mp4');
  });

  it('derives the title from the first sentence', () => {
    expect(deriveTitle('Hi there. More text here.')).toBe('Hi there.');
    expect(deriveTitle('  First line without stop\nsecond line')).toBe('First line without stop');
    expect(deriveTitle('Is 3.5 bigger than 3? Yes it is.')).toBe('Is 3.5 bigger than 3?');
    const long = deriveTitle(`${'word '.repeat(40)}end.`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('...')).toBe(true);
    expect(deriveTitle('')).toBe('Untitled video');
    expect(deriveTitle('这是第一句。这是第二句。')).toBe('这是第一句。');
  });
});

describe('session tokens and credentials', () => {
  const now = 1_700_000_000_000;
  const payload = { sub: 'admin', iat: now / 1000, exp: now / 1000 + 3600 };

  it('round-trips a signed session', () => {
    const token = signSession(payload, SECRET);
    expect(token.split('.')).toHaveLength(2);
    expect(verifySession(token, SECRET, now)).toEqual(payload);
  });

  it('rejects tampering, other secrets, expiry and junk', () => {
    const token = signSession(payload, SECRET);
    const [body, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: 'root' })).toString('base64url');
    expect(verifySession(`${forged}.${sig}`, SECRET, now)).toBeNull();
    expect(verifySession(`${body}.${sig.slice(1)}`, SECRET, now)).toBeNull();
    expect(verifySession(token, `${SECRET}x`, now)).toBeNull();
    expect(verifySession(token, SECRET, now + 3600 * 1000)).toBeNull();
    for (const junk of [undefined, '', '.', 'abc', 'abc.', '.abc', 'a.b.c', 'x'.repeat(2000)]) {
      expect(verifySession(junk, SECRET, now)).toBeNull();
    }
    const notJson = `${Buffer.from('not json').toString('base64url')}`;
    const signed = signSession(payload, SECRET).split('.')[1];
    expect(verifySession(`${notJson}.${signed}`, SECRET, now)).toBeNull();
  });

  it('compares passwords and tokens in constant time', () => {
    expect(passwordMatches('secret', 'secret')).toBe(true);
    expect(passwordMatches('secret', 'secret ')).toBe(false);
    expect(passwordMatches('', 'secret')).toBe(false);
    expect(passwordMatches('anything', null)).toBe(false);
    expect(tokenMatches('b', ['a', 'b', 'c'])).toBe(true);
    expect(tokenMatches('d', ['a', 'b', 'c'])).toBe(false);
    expect(tokenMatches('a', [])).toBe(false);
  });

  it('recognizes API paths before and after percent-decoding', () => {
    for (const url of [
      '/api',
      '/api/',
      '/api/generations?x=1',
      '/%61pi/generations',
      '/ap%69/config',
      '/api%2Fconfig',
    ]) {
      expect(isApiPath(url), url).toBe(true);
    }
    for (const url of ['/', '/apix', '/assets/api.js', '/%2561pi/generations', '/%E0%A4%A', '/history#/api/x']) {
      expect(isApiPath(url), url).toBe(false);
    }
  });

  it('decides whether auth is enabled', () => {
    expect(isAuthEnabled(config({ APP_PASSWORD: 'pw' }))).toBe(true);
    expect(isAuthEnabled(config({ API_TOKENS: 'tok' }))).toBe(true);
    expect(isAuthEnabled(config({}))).toBe(false);
    expect(isAuthEnabled(config({ APP_PASSWORD: 'pw', AUTH_DISABLED: 'true' }))).toBe(false);
    expect(
      isAuthEnabled(
        config({
          NODE_ENV: 'production',
          API_TOKENS: 'tok',
          SESSION_SECRET: SECRET,
          GEMINI_MOCK: 'false',
          GEMINI_API_KEY: 'k',
        }),
      ),
    ).toBe(true);
  });
});

describe('content security policy', () => {
  it('allows presigned storage origins for media only when presigned URLs are used', () => {
    expect(storageOrigins(config())).toEqual([]);
    const r2 = config({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'videos',
      S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    });
    expect(storageOrigins(r2)).toEqual([
      'https://acct.r2.cloudflarestorage.com',
      'https://videos.acct.r2.cloudflarestorage.com',
    ]);
    const aws = config({ STORAGE_DRIVER: 's3', S3_BUCKET: 'videos', S3_REGION: 'eu-west-1' });
    expect(storageOrigins(aws)).toContain('https://videos.s3.eu-west-1.amazonaws.com');
    const proxied = config({ STORAGE_DRIVER: 's3', S3_BUCKET: 'videos', S3_PRESIGNED_URLS: 'false' });
    expect(storageOrigins(proxied)).toEqual([]);

    const csp = helmetOptions(r2).contentSecurityPolicy;
    const directives = (csp as { directives: Record<string, string[]> }).directives;
    expect(directives.mediaSrc).toContain('https://videos.acct.r2.cloudflarestorage.com');
    expect(directives.scriptSrc).toEqual(["'self'"]);
    expect(directives.frameAncestors).toEqual(["'none'"]);
  });
});

describe('error serializer', () => {
  it('scrubs secrets and tolerates non-error rejection reasons', () => {
    const serialize = createErrorSerializer(
      config({ API_TOKENS: 'super-secret-token-123', GEMINI_API_KEY: 'AIzaSyA1234567890abcdefghijklmnopqrstu' }),
    );
    expect(serialize(null)).toBeNull();
    expect(serialize(undefined)).toBeUndefined();
    expect(serialize(42)).toBe(42);
    expect(serialize('failed with super-secret-token-123')).toBe('failed with [REDACTED]');
    const out = serialize(new Error('key=AIzaSyA1234567890abcdefghijklmnopqrstu rejected')) as Record<string, string>;
    expect(out.message).toBe('key=[REDACTED] rejected');
    expect(out.stack).not.toContain('AIza');
  });
});

describe('request schemas', () => {
  it('fills settings defaults and strips control characters', () => {
    expect(settingsSchema.parse(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(settingsSchema.parse({ resolution: '1080p', voiceHint: ' deep\u0000 voice ' })).toEqual({
      ...DEFAULT_SETTINGS,
      resolution: '1080p',
      voiceHint: 'deep voice',
    });
    expect(stripControlChars('a\u0000b\u001fc\td\ne\u007f')).toBe('abc\td\ne');
    // Lone surrogates are dropped (Postgres jsonb rejects them); valid pairs such as emoji are kept.
    expect(stripControlChars('a\ud800b\ud83d\ude00c\udc00')).toBe('ab\ud83d\ude00c');
    expect(settingsSchema.safeParse({ language: 'english please' }).success).toBe(false);
    expect(settingsSchema.safeParse({ language: 'pt-BR' }).success).toBe(true);
  });

  it('keeps regeneration setting edits partial', () => {
    const parsed = regenerateRequestSchema.parse({ mode: 'full', settings: { resolution: '4k' } });
    expect(parsed.settings).toEqual({ resolution: '4k' });
  });

  it('computes the UTC day start', () => {
    expect(startOfUtcDay(new Date('2026-03-04T23:59:59.999-05:00')).toISOString()).toBe('2026-03-05T00:00:00.000Z');
  });
});

describe('DTO mapping', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const base: GenerationRecord = {
    id: '0b0e8f36-4a55-4c1c-9a57-5a4c1f1c0d11',
    createdAt: new Date(now - 60_000),
    updatedAt: new Date(now - 1000),
    createdBy: 'admin',
    status: 'running',
    stage: 'generating_part1',
    progress: 12,
    stageStartedAt: new Date(now - 30_000),
    startedAt: new Date(now - 40_000),
    completedAt: null,
    title: 'Title',
    script: 'Script text here.',
    settings: DEFAULT_SETTINGS,
    plan: null,
    characterImageKey: 'generations/0b0e8f36-4a55-4c1c-9a57-5a4c1f1c0d11/character.jpg',
    characterImageMime: 'image/jpeg',
    characterImageSha256: 'a'.repeat(64),
    geminiFileUri: null,
    geminiFileMime: null,
    geminiFileExpiresAt: null,
    part1InteractionId: null,
    part1Status: null,
    part1VideoKey: null,
    part1Usage: null,
    part1Attempts: 1,
    part2InteractionId: null,
    part2Status: null,
    part2VideoKey: null,
    part2Usage: null,
    part2Attempts: 0,
    finalVideoKey: null,
    finalCleanKey: null,
    captionEngine: null,
    thumbnailKey: null,
    durationSec: null,
    assembly: null,
    estimatedCost: { currency: 'USD', items: [], totalUsd: 3.2, basis: 'estimate', notes: [] },
    estimatedCostUsd: 3.2,
    actualCost: null,
    actualCostUsd: null,
    error: null,
    parentId: null,
    regenerationMode: null,
    attempts: 1,
    maxAttempts: 3,
    runAfter: new Date(now - 60_000),
    lockedBy: 'w1',
    lockedUntil: new Date(now + 60_000),
    cancelRequested: false,
  };

  it('interpolates progress and estimates the remaining time while running', () => {
    const dto = toGenerationDTO(base, [], now, { turnSeconds: 120 });
    expect(dto.progress).toBeGreaterThan(12);
    expect(dto.progress).toBeLessThan(50);
    // 90s left of part 1, 120s part 2, 10s finalizing.
    expect(dto.etaSeconds).toBe(220);
    expect(dto.canCancel).toBe(true);
    expect(dto.videoUrl).toBeNull();
    expect(dto.characterImageUrl).toBe(`/api/generations/${base.id}/character`);
  });

  it('adds the retry wait to the ETA of a requeued job', () => {
    const queued = { ...base, status: 'queued' as const, stage: 'queued' as const, runAfter: new Date(now + 30_000) };
    const dto = toGenerationDTO(queued, [], now, { turnSeconds: 120 });
    expect(dto.etaSeconds).toBeGreaterThanOrEqual(30 + 240);
  });

  it('allows part-2 regeneration only for finished records with a recent part 1', () => {
    const done: GenerationRecord = {
      ...base,
      status: 'succeeded',
      stage: 'completed',
      part1InteractionId: 'int-1',
      part1VideoKey: 'k',
      plan: { segments: [] } as unknown as GenerationRecord['plan'],
      finalVideoKey: 'f',
    };
    expect(canRegeneratePart2(done, now)).toBe(true);
    expect(canRegeneratePart2({ ...done, status: 'running' }, now)).toBe(false);
    expect(canRegeneratePart2({ ...done, part1InteractionId: null }, now)).toBe(false);
    expect(canRegeneratePart2(done, now, new Date(now - PART1_REUSE_MAX_AGE_MS - 1))).toBe(false);
    const dto = toGenerationDTO(done, [], now);
    expect(dto).toMatchObject({
      progress: 100,
      etaSeconds: null,
      canCancel: false,
      videoUrl: `/api/generations/${base.id}/video?v=${done.updatedAt.getTime()}`,
      downloadUrl: `/api/generations/${base.id}/video?v=${done.updatedAt.getTime()}&download=1`,
    });
    expect(toListItem(done)).toMatchObject({ id: base.id, estimatedCostUsd: 3.2, thumbnailUrl: null });
  });
});
