import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadRange, StorageDriver, StoredObjectInfo } from '../../src/core/ports.js';

class NotFoundError extends Error {
  readonly code = 'not_found';
  constructor(key: string) {
    super(`Object not found: ${key}`);
  }
}

/** In-memory StorageDriver for HTTP tests. */
export class MemoryStorage implements StorageDriver {
  readonly kind = 'local' as const;
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();
  /** When set, getSignedUrl returns `${signedUrlBase}/${key}` (simulates S3 presigned URLs). */
  signedUrlBase: string | null = null;
  healthy = true;
  readonly signedRequests: { key: string; downloadFileName?: string; contentType?: string }[] = [];
  readonly openedStreams: Readable[] = [];

  has(key: string): boolean {
    return this.objects.has(key);
  }

  private info(key: string): StoredObjectInfo {
    const obj = this.objects.get(key);
    if (!obj) throw new NotFoundError(key);
    return { key, size: obj.data.length, contentType: obj.contentType };
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<StoredObjectInfo> {
    return this.putBuffer(key, await readFile(localPath), contentType);
  }

  async putBuffer(key: string, data: Buffer, contentType: string): Promise<StoredObjectInfo> {
    this.objects.set(key, { data: Buffer.from(data), contentType });
    return this.info(key);
  }

  async downloadToFile(key: string, localPath: string): Promise<void> {
    await writeFile(localPath, await this.getBuffer(key));
  }

  async getBuffer(key: string): Promise<Buffer> {
    const obj = this.objects.get(key);
    if (!obj) throw new NotFoundError(key);
    return Buffer.from(obj.data);
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    return this.objects.has(key) ? this.info(key) : null;
  }

  async createReadStream(key: string, range?: ReadRange): Promise<Readable> {
    const obj = this.objects.get(key);
    if (!obj) throw new NotFoundError(key);
    const data = range ? obj.data.subarray(range.start, range.end + 1) : obj.data;
    const stream = Readable.from([data]);
    this.openedStreams.push(stream);
    return stream;
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const obj = this.objects.get(srcKey);
    if (!obj) throw new NotFoundError(srcKey);
    this.objects.set(destKey, { data: Buffer.from(obj.data), contentType: obj.contentType });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key);
  }

  async getSignedUrl(key: string, opts: { downloadFileName?: string; contentType?: string }): Promise<string | null> {
    if (!this.signedUrlBase) return null;
    this.signedRequests.push({ key, ...opts });
    return `${this.signedUrlBase}/${key}`;
  }

  async healthCheck(): Promise<void> {
    if (!this.healthy) throw new Error('storage unavailable');
  }
}
