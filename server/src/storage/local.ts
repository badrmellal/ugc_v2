import { randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ReadRange, StorageDriver, StoredObjectInfo } from '../core/ports.js';
import { StorageError, assertValidKey, assertValidPrefix, assertValidRange, contentTypeForKey } from './keys.js';

/**
 * Filesystem storage for single-node deployments and development.
 *
 * Writes are atomic (temp file in the same directory, fsync, rename), so readers never see a
 * partially written video. Content types are inferred from the key extension (no sidecar files).
 */
export class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;
  readonly baseDir: string;

  constructor(baseDir: string) {
    if (!baseDir) throw new Error('LocalStorage: baseDir is required');
    this.baseDir = path.resolve(baseDir);
  }

  /** Absolute path of a key. Throws `StorageError('invalid_key')` for anything outside `baseDir`. */
  resolvePath(key: string): string {
    assertValidKey(key);
    const full = path.resolve(this.baseDir, ...key.split('/'));
    const rel = path.relative(this.baseDir, full);
    if (rel === '' || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') {
      throw new StorageError('invalid_key', `Storage key "${key}" resolves outside the storage directory`);
    }
    return full;
  }

  async putFile(key: string, localPath: string, _contentType: string): Promise<StoredObjectInfo> {
    const dest = this.resolvePath(key);
    const size = await this.writeAtomic(dest, async (tmp) => {
      await copyFile(localPath, tmp);
      return syncFile(tmp);
    });
    return { key, size, contentType: contentTypeForKey(key) };
  }

  async putBuffer(key: string, data: Buffer, _contentType: string): Promise<StoredObjectInfo> {
    const dest = this.resolvePath(key);
    const size = await this.writeAtomic(dest, async (tmp) => {
      const fh = await open(tmp, 'wx', 0o644);
      try {
        await fh.writeFile(data);
        await fh.sync();
        return (await fh.stat()).size;
      } finally {
        await fh.close();
      }
    });
    return { key, size, contentType: contentTypeForKey(key) };
  }

  async downloadToFile(key: string, localPath: string): Promise<void> {
    const src = this.resolvePath(key);
    const dest = path.resolve(localPath);
    await mkdir(path.dirname(dest), { recursive: true });
    // Copy next to the destination and rename, so a failed copy never leaves a truncated file behind.
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.part`;
    try {
      await copyFile(src, tmp);
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw mapNotFound(err, key);
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const src = this.resolvePath(key);
    try {
      return await readFile(src);
    } catch (err) {
      throw mapNotFound(err, key);
    }
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    const src = this.resolvePath(key);
    try {
      const st = await stat(src);
      if (!st.isFile()) return null;
      return { key, size: st.size, contentType: contentTypeForKey(key) };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async createReadStream(key: string, range?: ReadRange): Promise<Readable> {
    const src = this.resolvePath(key);
    if (range) assertValidRange(range);
    let fh: FileHandle | undefined;
    try {
      fh = await open(src, 'r');
      const st = await fh.stat();
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
    } catch (err) {
      await fh?.close().catch(() => undefined);
      throw mapNotFound(err, key);
    }
    // The stream owns the handle from here on and closes it on end, error or destroy.
    return fh.createReadStream(range ? { start: range.start, end: range.end } : {});
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const src = this.resolvePath(srcKey);
    const dest = this.resolvePath(destKey);
    if (src === dest) return;
    try {
      await this.writeAtomic(dest, async (tmp) => {
        await copyFile(src, tmp);
        return syncFile(tmp);
      });
    } catch (err) {
      throw mapNotFound(err, srcKey);
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.resolvePath(key);
    try {
      await unlink(target);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
  }

  /**
   * Deletes every object whose key starts with `prefix` (same semantics as an S3 prefix).
   * `generations/<id>/` removes that directory; `generations/ab` also matches `generations/abc...`.
   */
  async deletePrefix(prefix: string): Promise<void> {
    assertValidPrefix(prefix);
    if (prefix.endsWith('/')) {
      // `a/b/` only matches objects inside the directory `a/b`, never an object stored at `a/b` itself.
      const dir = this.resolvePath(prefix.slice(0, -1));
      const st = await lstat(dir).catch((err: unknown) => {
        if (isMissing(err)) return null;
        throw err;
      });
      if (st?.isDirectory()) await rm(dir, { recursive: true, force: true });
      return;
    }
    const full = this.resolvePath(prefix);
    const dir = path.dirname(full);
    const namePrefix = path.basename(full);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.startsWith(namePrefix)) {
        await rm(path.join(dir, entry), { recursive: true, force: true });
      }
    }
  }

  async getSignedUrl(_key: string, _opts: { downloadFileName?: string; contentType?: string }): Promise<string | null> {
    return null;
  }

  async healthCheck(): Promise<void> {
    const probe = path.join(this.baseDir, `.healthcheck-${randomBytes(6).toString('hex')}`);
    try {
      await mkdir(this.baseDir, { recursive: true });
      const fh = await open(probe, 'wx', 0o600);
      try {
        await fh.writeFile('ok');
      } finally {
        await fh.close();
      }
      await unlink(probe);
    } catch (err) {
      await rm(probe, { force: true }).catch(() => undefined);
      throw new StorageError('unavailable', `Local storage directory ${this.baseDir} is not writable`, {
        cause: err,
      });
    }
  }

  /** Runs `write(tmp)` on a temp file next to `dest`, then renames it into place. Returns the size. */
  private async writeAtomic(dest: string, write: (tmp: string) => Promise<number>): Promise<number> {
    const dir = path.dirname(dest);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(dest)}.${randomBytes(6).toString('hex')}.tmp`);
    let size: number;
    try {
      size = await write(tmp);
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    await syncDir(dir);
    return size;
  }
}

async function syncFile(file: string): Promise<number> {
  const fh = await open(file, 'r+');
  try {
    await fh.sync();
    return (await fh.stat()).size;
  } finally {
    await fh.close();
  }
}

/** Persists the rename itself. Best effort: not every platform allows fsync on a directory. */
async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // ignore
  }
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function isMissing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function mapNotFound(err: unknown, key: string): unknown {
  const code = errnoCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
    return new StorageError('not_found', `Object not found: ${key}`, { cause: err });
  }
  return err;
}
