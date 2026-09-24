import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NoSuchKey, NotFound, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  S3Storage,
  StorageError,
  buildS3ClientConfig,
  copySource,
  generationKeys,
  isStorageNotFound,
  type S3StorageConfig,
} from '../src/storage/index.js';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const keys = generationKeys(ID);

interface SendOptions {
  abortSignal?: AbortSignal;
}
type Handler = (input: Record<string, unknown>, call: number, options: SendOptions) => unknown;

/** Minimal stand-in for S3Client: records commands by constructor name and returns canned outputs. */
class FakeS3 {
  readonly calls: { name: string; input: Record<string, unknown> }[] = [];
  readonly handlers: Record<string, Handler> = {};

  async send(
    command: { constructor: { name: string }; input: Record<string, unknown> },
    options: SendOptions = {},
  ): Promise<unknown> {
    const name = command.constructor.name;
    this.calls.push({ name, input: command.input });
    const handler = this.handlers[name];
    const count = this.calls.filter((c) => c.name === name).length;
    return handler ? handler(command.input, count, options) : {};
  }

  named(name: string) {
    return this.calls.filter((c) => c.name === name).map((c) => c.input);
  }
}

function config(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
  return {
    bucket: 'media-bucket',
    region: 'auto',
    endpoint: 'https://storage.example.com',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    forcePathStyle: true,
    prefix: 'prod/omni',
    presignedUrls: true,
    presignTtlSec: 600,
    ...overrides,
  };
}

function storageWith(fake: FakeS3, overrides: Partial<S3StorageConfig> = {}): S3Storage {
  return new S3Storage(config(overrides), fake as unknown as S3Client);
}

const notFound = () => new NotFound({ message: 'Not Found', $metadata: { httpStatusCode: 404 } });
const noSuchKey = () =>
  new NoSuchKey({ message: 'The specified key does not exist.', $metadata: { httpStatusCode: 404 } });
const httpError = (name: string, status: number) =>
  new S3ServiceException({ name, $fault: status >= 500 ? 'server' : 'client', $metadata: { httpStatusCode: status } });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'omni-s3-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('S3Storage', () => {
  it('applies the prefix to every key', async () => {
    const fake = new FakeS3();
    const s3 = storageWith(fake);
    const info = await s3.putBuffer(keys.final, Buffer.from('abc'), 'video/mp4');
    expect(info).toEqual({ key: keys.final, size: 3, contentType: 'video/mp4' });
    expect(fake.named('PutObjectCommand')[0]).toMatchObject({
      Bucket: 'media-bucket',
      Key: `prod/omni/${keys.final}`,
      ContentType: 'video/mp4',
      ContentLength: 3,
    });
  });

  it('uses keys unchanged without a prefix and normalizes slashes around the prefix', async () => {
    const fake = new FakeS3();
    await storageWith(fake, { prefix: '' }).delete(keys.final);
    await storageWith(fake, { prefix: '/prod/' }).delete(keys.final);
    expect(fake.named('DeleteObjectCommand').map((i) => i.Key)).toEqual([keys.final, `prod/${keys.final}`]);
  });

  it('rejects invalid keys and prefixes before calling S3', async () => {
    const fake = new FakeS3();
    const s3 = storageWith(fake);
    for (const key of ['../x', '/abs', 'a//b', 'a\\b']) {
      const err = await rejection(s3.stat(key));
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe('invalid_key');
    }
    await expect(rejection(s3.deletePrefix(''))).resolves.toBeInstanceOf(StorageError);
    expect(fake.calls).toEqual([]);
    expect(() => storageWith(fake, { prefix: 'bad prefix' })).toThrow(StorageError);
    expect(() => storageWith(fake, { bucket: null })).toThrow(/bucket/);
  });

  it('streams local files with ContentLength and ContentType', async () => {
    const fake = new FakeS3();
    const file = path.join(dir, 'final.mp4');
    await writeFile(file, Buffer.alloc(1234, 1));
    const info = await storageWith(fake).putFile(keys.final, file, 'video/mp4');
    expect(info).toEqual({ key: keys.final, size: 1234, contentType: 'video/mp4' });
    const input = fake.named('PutObjectCommand')[0]!;
    expect(input).toMatchObject({ Key: `prod/omni/${keys.final}`, ContentLength: 1234, ContentType: 'video/mp4' });
    expect(input.Body).toBeInstanceOf(Readable);
  });

  it('retries streaming uploads on transient errors with a fresh stream', async () => {
    const fake = new FakeS3();
    const bodies: unknown[] = [];
    fake.handlers.PutObjectCommand = (input, call) => {
      bodies.push(input.Body);
      if (call === 1) throw httpError('ServiceUnavailable', 503);
      return {};
    };
    const file = path.join(dir, 'part1.mp4');
    await writeFile(file, 'video');
    await storageWith(fake).putFile(keys.part1, file, 'video/mp4');
    expect(fake.named('PutObjectCommand')).toHaveLength(2);
    expect(bodies[0]).not.toBe(bodies[1]);
  });

  it('aborts the upload and rejects with the read error when the local file cannot be read', async () => {
    const fake = new FakeS3();
    let aborted = false;
    // Like the real SDK: the body is piped into the request, and the request only ends through the signal.
    fake.handlers.PutObjectCommand = (input, _call, options) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
        });
        (input.Body as Readable).destroy(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }));
      });
    const file = path.join(dir, 'part1.mp4');
    await writeFile(file, 'video');
    await expect(storageWith(fake).putFile(keys.part1, file, 'video/mp4')).rejects.toThrow('EIO');
    expect(aborted).toBe(true);
    expect(fake.named('PutObjectCommand')).toHaveLength(1);
  });

  it('rejects uploads of missing local files without calling S3', async () => {
    const fake = new FakeS3();
    await expect(storageWith(fake).putFile(keys.part1, path.join(dir, 'missing.mp4'), 'video/mp4')).rejects.toThrow(
      /ENOENT/,
    );
    expect(fake.calls).toEqual([]);
  });

  it('does not retry uploads on 501 Not Implemented', async () => {
    const fake = new FakeS3();
    fake.handlers.PutObjectCommand = () => {
      throw httpError('NotImplemented', 501);
    };
    const file = path.join(dir, 'part1.mp4');
    await writeFile(file, 'video');
    await expect(storageWith(fake).putFile(keys.part1, file, 'video/mp4')).rejects.toThrow();
    expect(fake.named('PutObjectCommand')).toHaveLength(1);
  });

  it('does not retry uploads on client errors', async () => {
    const fake = new FakeS3();
    fake.handlers.PutObjectCommand = () => {
      throw httpError('AccessDenied', 403);
    };
    const file = path.join(dir, 'part1.mp4');
    await writeFile(file, 'video');
    await expect(storageWith(fake).putFile(keys.part1, file, 'video/mp4')).rejects.toThrow();
    expect(fake.named('PutObjectCommand')).toHaveLength(1);
  });

  it('stats objects and maps NotFound to null', async () => {
    const fake = new FakeS3();
    fake.handlers.HeadObjectCommand = (input) => {
      if (String(input.Key).endsWith('final.mp4')) return { ContentLength: 42, ContentType: 'video/mp4' };
      if (String(input.Key).endsWith('thumbnail.jpg')) return { ContentLength: 7 };
      throw notFound();
    };
    const s3 = storageWith(fake);
    expect(await s3.stat(keys.final)).toEqual({ key: keys.final, size: 42, contentType: 'video/mp4' });
    expect(await s3.stat(keys.thumbnail)).toEqual({ key: keys.thumbnail, size: 7, contentType: 'image/jpeg' });
    expect(await s3.stat(keys.part2)).toBeNull();
    expect(fake.named('HeadObjectCommand')[0]).toEqual({ Bucket: 'media-bucket', Key: `prod/omni/${keys.final}` });
  });

  it('propagates other stat errors', async () => {
    const fake = new FakeS3();
    fake.handlers.HeadObjectCommand = () => {
      throw httpError('InternalError', 500);
    };
    await expect(storageWith(fake).stat(keys.final)).rejects.toThrow();
  });

  it('reads byte ranges with a Range header', async () => {
    const fake = new FakeS3();
    fake.handlers.GetObjectCommand = () => ({ Body: Readable.from([Buffer.from('2345')]) });
    const stream = await storageWith(fake).createReadStream(keys.final, { start: 2, end: 5 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('2345');
    expect(fake.named('GetObjectCommand')[0]).toMatchObject({
      Bucket: 'media-bucket',
      Key: `prod/omni/${keys.final}`,
      Range: 'bytes=2-5',
    });

    await storageWith(fake).createReadStream(keys.final);
    expect(fake.named('GetObjectCommand')[1]?.Range).toBeUndefined();

    await expect(
      rejection(storageWith(fake).createReadStream(keys.final, { start: 3, end: 1 })),
    ).resolves.toMatchObject({ code: 'invalid_range' });
  });

  it('maps missing objects to StorageError not_found', async () => {
    const fake = new FakeS3();
    fake.handlers.GetObjectCommand = () => {
      throw noSuchKey();
    };
    const s3 = storageWith(fake);
    expect(isStorageNotFound(await rejection(s3.createReadStream(keys.final)))).toBe(true);
    expect(isStorageNotFound(await rejection(s3.getBuffer(keys.final)))).toBe(true);
    expect(isStorageNotFound(await rejection(s3.downloadToFile(keys.final, path.join(dir, 'x.mp4'))))).toBe(true);
  });

  it('does not report a missing bucket as a missing object', async () => {
    const fake = new FakeS3();
    const noSuchBucket = () => httpError('NoSuchBucket', 404);
    fake.handlers.GetObjectCommand = () => {
      throw noSuchBucket();
    };
    fake.handlers.DeleteObjectCommand = () => {
      throw noSuchBucket();
    };
    const s3 = storageWith(fake);
    const readErr = await rejection(s3.getBuffer(keys.final));
    expect(isStorageNotFound(readErr)).toBe(false);
    expect((readErr as Error).name).toBe('NoSuchBucket');
    await expect(s3.delete(keys.final)).rejects.toMatchObject({ name: 'NoSuchBucket' });
  });

  it('maps an unsatisfiable range to invalid_range', async () => {
    const fake = new FakeS3();
    fake.handlers.GetObjectCommand = () => {
      throw httpError('InvalidRange', 416);
    };
    const err = await rejection(storageWith(fake).createReadStream(keys.final, { start: 100, end: 200 }));
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe('invalid_range');
  });

  it('downloads to a file and reads buffers', async () => {
    const fake = new FakeS3();
    fake.handlers.GetObjectCommand = () => ({ Body: Readable.from([Buffer.from('hello '), Buffer.from('world')]) });
    const s3 = storageWith(fake);
    const dest = path.join(dir, 'nested', 'part1.mp4');
    await s3.downloadToFile(keys.part1, dest);
    expect((await readFile(dest)).toString()).toBe('hello world');
    expect(await readdir(path.dirname(dest))).toEqual(['part1.mp4']);
    expect((await s3.getBuffer(keys.part1)).toString()).toBe('hello world');
  });

  it('removes the partial file when a download fails midway', async () => {
    const fake = new FakeS3();
    fake.handlers.GetObjectCommand = () => ({
      Body: new Readable({
        read() {
          this.push(Buffer.from('partial'));
          this.destroy(new Error('connection reset'));
        },
      }),
    });
    const dest = path.join(dir, 'broken.mp4');
    await expect(storageWith(fake).downloadToFile(keys.part1, dest)).rejects.toThrow('connection reset');
    expect(await readdir(dir)).toEqual([]);
  });

  it('releases the response body when the destination cannot be created', async () => {
    const fake = new FakeS3();
    const body = Readable.from([Buffer.from('data')]);
    fake.handlers.GetObjectCommand = () => ({ Body: body });
    await writeFile(path.join(dir, 'blocker'), 'a file, not a directory');
    await expect(
      storageWith(fake).downloadToFile(keys.part1, path.join(dir, 'blocker', 'part1.mp4')),
    ).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });

  it('copies with an encoded CopySource', async () => {
    const fake = new FakeS3();
    const other = generationKeys('00000000-0000-4000-8000-000000000000');
    await storageWith(fake).copy(keys.characterImage, other.characterImage);
    expect(fake.named('CopyObjectCommand')[0]).toEqual({
      Bucket: 'media-bucket',
      Key: `prod/omni/${other.characterImage}`,
      CopySource: `media-bucket/prod/omni/${keys.characterImage}`,
    });
    expect(copySource('bucket', 'dir with space/a+b&c.mp4')).toBe('bucket/dir%20with%20space/a%2Bb%26c.mp4');
  });

  it('maps a missing copy source to not_found', async () => {
    const fake = new FakeS3();
    fake.handlers.CopyObjectCommand = () => {
      throw noSuchKey();
    };
    expect(isStorageNotFound(await rejection(storageWith(fake).copy(keys.part1, keys.part2)))).toBe(true);
  });

  it('ignores NotFound on delete but propagates other errors', async () => {
    const fake = new FakeS3();
    fake.handlers.DeleteObjectCommand = () => {
      throw notFound();
    };
    await expect(storageWith(fake).delete(keys.final)).resolves.toBeUndefined();
    fake.handlers.DeleteObjectCommand = () => {
      throw httpError('AccessDenied', 403);
    };
    await expect(storageWith(fake).delete(keys.final)).rejects.toThrow();
  });

  it('deletes a prefix page by page with single-object deletes', async () => {
    const fake = new FakeS3();
    const full = `prod/omni/${keys.prefix}`;
    fake.handlers.ListObjectsV2Command = (input) =>
      input.ContinuationToken === undefined
        ? {
            Contents: [{ Key: `${full}part1.mp4` }, { Key: `${full}part2.mp4` }, { Key: 'unrelated/key.mp4' }],
            IsTruncated: true,
            NextContinuationToken: 'page-2',
          }
        : { Contents: [{ Key: `${full}final.mp4` }], IsTruncated: false };

    await storageWith(fake).deletePrefix(keys.prefix);

    const lists = fake.named('ListObjectsV2Command');
    expect(lists).toHaveLength(2);
    expect(lists[0]).toMatchObject({ Bucket: 'media-bucket', Prefix: full, ContinuationToken: undefined });
    expect(lists[1]).toMatchObject({ Prefix: full, ContinuationToken: 'page-2' });
    expect(
      fake
        .named('DeleteObjectCommand')
        .map((i) => i.Key)
        .sort(),
    ).toEqual([`${full}final.mp4`, `${full}part1.mp4`, `${full}part2.mp4`]);
    expect(fake.named('DeleteObjectsCommand')).toEqual([]);
  });

  it('returns null from getSignedUrl when presigning is disabled', async () => {
    const fake = new FakeS3();
    expect(await storageWith(fake, { presignedUrls: false }).getSignedUrl(keys.final, {})).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it('presigns GET URLs with download headers', async () => {
    const client = new S3Client(buildS3ClientConfig(config()));
    const s3 = new S3Storage(config(), client);
    const url = new URL(
      (await s3.getSignedUrl(keys.final, { downloadFileName: 'my "video".mp4', contentType: 'video/mp4' }))!,
    );
    expect(url.origin).toBe('https://storage.example.com');
    expect(url.pathname).toBe(`/media-bucket/prod/omni/${keys.final}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="my_video_.mp4"');
    expect(url.searchParams.get('response-content-type')).toBe('video/mp4');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    const plain = new URL((await s3.getSignedUrl(keys.thumbnail, {}))!);
    expect(plain.searchParams.has('response-content-disposition')).toBe(false);
    client.destroy();
  });

  it('health checks with HeadBucket', async () => {
    const fake = new FakeS3();
    await storageWith(fake).healthCheck();
    expect(fake.calls.map((c) => c.name)).toEqual(['HeadBucketCommand']);
    expect(fake.calls[0]?.input).toEqual({ Bucket: 'media-bucket' });
  });

  it('falls back to a listing when HeadBucket is forbidden', async () => {
    const fake = new FakeS3();
    fake.handlers.HeadBucketCommand = () => {
      throw httpError('Forbidden', 403);
    };
    await storageWith(fake).healthCheck();
    expect(fake.calls.map((c) => c.name)).toEqual(['HeadBucketCommand', 'ListObjectsV2Command']);
    expect(fake.named('ListObjectsV2Command')[0]).toMatchObject({ Prefix: 'prod/omni/', MaxKeys: 1 });
  });

  it('fails the health check when the bucket is unreachable', async () => {
    const fake = new FakeS3();
    fake.handlers.HeadBucketCommand = () => {
      throw httpError('NotFound', 404);
    };
    const err = await rejection(storageWith(fake).healthCheck());
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe('unavailable');
  });
});

describe('buildS3ClientConfig', () => {
  it('disables default checksums for GCS, R2 and MinIO compatibility', () => {
    const cfg = buildS3ClientConfig(config());
    expect(cfg).toMatchObject({
      region: 'auto',
      endpoint: 'https://storage.example.com',
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
  });

  it('uses the default credential chain unless both keys are set', () => {
    expect(buildS3ClientConfig(config({ secretAccessKey: null })).credentials).toBeUndefined();
    expect(buildS3ClientConfig(config({ accessKeyId: null })).credentials).toBeUndefined();
  });

  it('uses a concrete region for AWS when no endpoint is set', () => {
    const cfg = buildS3ClientConfig(config({ endpoint: null }));
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.endpoint).toBeUndefined();
    expect(buildS3ClientConfig(config({ endpoint: null, region: 'eu-west-3' })).region).toBe('eu-west-3');
  });
});
