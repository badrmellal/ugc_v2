import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '../config.js';
import type { ReadRange, StorageDriver, StoredObjectInfo } from '../core/ports.js';
import { StorageError, assertValidKey, assertValidPrefix, assertValidRange, contentTypeForKey } from './keys.js';

export type S3StorageConfig = AppConfig['storage']['s3'];

/** SigV4 presigned URLs are valid for at most 7 days. */
const MAX_PRESIGN_TTL_SEC = 7 * 24 * 3600;
/** The SDK does not retry streaming uploads, so `putFile` retries itself with a fresh stream. */
const PUT_FILE_ATTEMPTS = 3;
const DELETE_CONCURRENCY = 8;

/**
 * Client settings that work with AWS S3, Google Cloud Storage (XML API + HMAC keys),
 * Cloudflare R2 and MinIO.
 */
export function buildS3ClientConfig(cfg: S3StorageConfig): S3ClientConfig {
  // `auto` is what R2 and GCS expect; AWS itself needs a real region when no endpoint is set.
  const region = cfg.region === 'auto' && !cfg.endpoint ? 'us-east-1' : cfg.region;
  const config: S3ClientConfig = {
    region,
    forcePathStyle: cfg.forcePathStyle,
    // Since SDK 3.729 checksums are added to every request by default, which GCS, R2 (partially)
    // and older MinIO reject. Only send them when an operation requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 10_000, socketTimeout: 120_000 },
  };
  if (cfg.endpoint) config.endpoint = cfg.endpoint;
  if (cfg.accessKeyId && cfg.secretAccessKey) {
    config.credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  }
  // Otherwise the default provider chain applies (env vars, shared config, IAM role, workload identity).
  return config;
}

/** S3-compatible object storage. Every key is stored under the configured prefix. */
export class S3Storage implements StorageDriver {
  readonly kind = 's3' as const;
  readonly bucket: string;
  readonly prefix: string;
  private readonly client: S3Client;
  private readonly presignedUrls: boolean;
  private readonly presignTtlSec: number;

  /** `client` can be injected (tests, custom middleware); otherwise one is built from `cfg`. */
  constructor(cfg: S3StorageConfig, client?: S3Client) {
    if (!cfg.bucket) throw new Error('S3Storage: bucket is required');
    this.bucket = cfg.bucket;
    this.prefix = cfg.prefix.replace(/^\/+|\/+$/g, '');
    if (this.prefix) assertValidKey(this.prefix, 'prefix (S3_PREFIX)');
    this.presignedUrls = cfg.presignedUrls;
    this.presignTtlSec = Math.min(MAX_PRESIGN_TTL_SEC, Math.max(1, Math.floor(cfg.presignTtlSec)));
    this.client = client ?? new S3Client(buildS3ClientConfig(cfg));
  }

  /** Full object key in the bucket (prefix applied). */
  objectKey(key: string): string {
    assertValidKey(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<StoredObjectInfo> {
    const Key = this.objectKey(key);
    for (let attempt = 1; ; attempt++) {
      // A fresh stream per attempt (a consumed stream cannot be replayed); the stream owns its handle.
      const { body, size } = await openUploadBody(localPath);
      // The SDK pipes the body into the request without an error listener: a read error would be
      // an uncaught 'error' event (process crash) and leave the request hanging. Abort instead.
      const controller = new AbortController();
      let readError: unknown = null;
      body.on('error', (err) => {
        readError ??= err;
        controller.abort(err);
      });
      try {
        await this.client.send(
          new PutObjectCommand({ Bucket: this.bucket, Key, Body: body, ContentLength: size, ContentType: contentType }),
          { abortSignal: controller.signal },
        );
        return { key, size, contentType };
      } catch (err) {
        if (readError) throw readError;
        if (attempt >= PUT_FILE_ATTEMPTS || !isRetryable(err)) throw err;
        await sleep(300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200));
      } finally {
        body.destroy();
      }
    }
  }

  async putBuffer(key: string, data: Buffer, contentType: string): Promise<StoredObjectInfo> {
    const Key = this.objectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key,
        Body: data,
        ContentLength: data.length,
        ContentType: contentType,
      }),
    );
    return { key, size: data.length, contentType };
  }

  async downloadToFile(key: string, localPath: string): Promise<void> {
    const body = await this.getBody(key);
    const dest = path.resolve(localPath);
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.part`;
    try {
      // Inside the try: the response body must be released (destroyed) on every failure path.
      await mkdir(path.dirname(dest), { recursive: true });
      await pipeline(body, createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (err) {
      body.destroy();
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const body = await this.getBody(key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    const Key = this.objectKey(key);
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key }));
      return {
        key,
        size: Number(out.ContentLength ?? 0),
        contentType: out.ContentType || contentTypeForKey(key),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async createReadStream(key: string, range?: ReadRange): Promise<Readable> {
    if (range) assertValidRange(range);
    return this.getBody(key, range);
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const src = this.objectKey(srcKey);
    const dest = this.objectKey(destKey);
    if (src === dest) return;
    try {
      await this.client.send(
        new CopyObjectCommand({ Bucket: this.bucket, Key: dest, CopySource: copySource(this.bucket, src) }),
      );
    } catch (err) {
      if (isNotFound(err)) throw new StorageError('not_found', `Object not found: ${srcKey}`, { cause: err });
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.deleteObject(this.objectKey(key));
  }

  /**
   * Deletes every object under `prefix` with ListObjectsV2 + one DeleteObject per key
   * (GCS interoperability does not implement the multi-object DeleteObjects call).
   */
  async deletePrefix(prefix: string): Promise<void> {
    assertValidPrefix(prefix);
    const fullPrefix = this.prefix ? `${this.prefix}/${prefix}` : prefix;
    let token: string | undefined;
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: fullPrefix, ContinuationToken: token, MaxKeys: 1000 }),
      );
      const keys = (out.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string' && k.startsWith(fullPrefix));
      await forEachLimit(keys, DELETE_CONCURRENCY, (k) => this.deleteObject(k));
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  async getSignedUrl(key: string, opts: { downloadFileName?: string; contentType?: string }): Promise<string | null> {
    if (!this.presignedUrls) return null;
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
      ResponseContentDisposition: opts.downloadFileName
        ? `attachment; filename="${safeFileName(opts.downloadFileName)}"`
        : undefined,
      ResponseContentType: opts.contentType || undefined,
    });
    return presign(this.client, command, { expiresIn: this.presignTtlSec });
  }

  /**
   * HeadBucket, falling back to a one-key listing when the credentials may only access objects
   * (common with GCS HMAC keys bound to `roles/storage.objectAdmin`).
   */
  async healthCheck(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (err) {
      if (!isForbidden(err)) {
        throw new StorageError('unavailable', `Bucket ${this.bucket} is not reachable: ${errorMessage(err)}`, {
          cause: err,
        });
      }
    }
    try {
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix ? `${this.prefix}/` : undefined,
          MaxKeys: 1,
        }),
      );
    } catch (err) {
      throw new StorageError('unavailable', `Bucket ${this.bucket} is not accessible: ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }

  private async getBody(key: string, range?: ReadRange): Promise<Readable> {
    const Key = this.objectKey(key);
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      );
      const body: unknown = out.Body;
      if (body instanceof Readable) return body;
      throw new Error(`Unexpected GetObject body type for ${key}`);
    } catch (err) {
      if (isNotFound(err)) throw new StorageError('not_found', `Object not found: ${key}`, { cause: err });
      if (range && isInvalidRange(err)) {
        throw new StorageError('invalid_range', `Byte range ${range.start}-${range.end} is outside ${key}`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  private async deleteObject(fullKey: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fullKey }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/**
 * Opens a local file for upload. A missing file rejects here (instead of as a stream 'error' event),
 * and ContentLength is the size of the file actually opened.
 */
async function openUploadBody(localPath: string): Promise<{ body: Readable; size: number }> {
  const fh = await open(localPath, 'r');
  try {
    const { size } = await fh.stat();
    return { body: fh.createReadStream(), size };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}

/** `x-amz-copy-source` value: bucket plus the URL-encoded key, keeping `/` separators. */
export function copySource(bucket: string, fullKey: string): string {
  return `${bucket}/${fullKey.split('/').map(encodeURIComponent).join('/')}`;
}

/** ASCII-only file name safe inside a quoted Content-Disposition parameter. */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 150);
  return cleaned || 'download';
}

interface SdkErrorShape {
  name?: string;
  code?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
  $retryable?: unknown;
}

function asSdkError(err: unknown): SdkErrorShape {
  return typeof err === 'object' && err !== null ? (err as SdkErrorShape) : {};
}

/** A missing object. A missing bucket is a configuration error and must not look like a 404. */
function isNotFound(err: unknown): boolean {
  const e = asSdkError(err);
  const name = e.name ?? e.Code ?? e.code;
  if (name === 'NoSuchBucket') return false;
  return name === 'NotFound' || name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}

function isInvalidRange(err: unknown): boolean {
  const e = asSdkError(err);
  return (e.name ?? e.Code ?? e.code) === 'InvalidRange' || e.$metadata?.httpStatusCode === 416;
}

function isForbidden(err: unknown): boolean {
  const e = asSdkError(err);
  return e.name === 'AccessDenied' || e.name === 'Forbidden' || e.$metadata?.httpStatusCode === 403;
}

const RETRYABLE_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'InternalError',
  'ServiceUnavailable',
]);
const RETRYABLE_ERRNO = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND']);

function isRetryable(err: unknown): boolean {
  const e = asSdkError(err);
  const status = e.$metadata?.httpStatusCode;
  // 501 Not Implemented is permanent (e.g. an S3 feature the provider does not support).
  if (status !== undefined && (status === 429 || (status >= 500 && status !== 501))) return true;
  if (e.$retryable) return true;
  if (e.name && RETRYABLE_NAMES.has(e.name)) return true;
  return typeof e.code === 'string' && RETRYABLE_ERRNO.has(e.code);
}

function errorMessage(err: unknown): string {
  const e = asSdkError(err);
  const status = e.$metadata?.httpStatusCode;
  const base = err instanceof Error ? err.message || err.name : String(err);
  return status ? `${base} (HTTP ${status})` : base;
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
