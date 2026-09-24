import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  LocalStorage,
  S3Storage,
  StorageError,
  contentTypeForKey,
  createStorage,
  generationKeys,
  isStorageNotFound,
} from '../src/storage/index.js';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

let root: string;
let storage: LocalStorage;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
}

/** Every file under `dir`, relative, sorted. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'omni-storage-test-'));
  storage = new LocalStorage(path.join(root, 'store'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalStorage', () => {
  it('stores and reads buffers', async () => {
    const data = Buffer.from('0123456789abcdef');
    const info = await storage.putBuffer('generations/x/final.mp4', data, 'video/mp4');
    expect(info).toEqual({ key: 'generations/x/final.mp4', size: 16, contentType: 'video/mp4' });
    expect(await storage.getBuffer('generations/x/final.mp4')).toEqual(data);
    expect(await storage.stat('generations/x/final.mp4')).toEqual(info);
    expect(storage.kind).toBe('local');
  });

  it('infers the content type from the key extension', async () => {
    await storage.putBuffer('a/data.json', Buffer.from('{}'), 'text/plain');
    await storage.putBuffer('a/blob.bin', Buffer.from('x'), 'text/plain');
    expect((await storage.stat('a/data.json'))?.contentType).toBe('application/json');
    expect((await storage.stat('a/blob.bin'))?.contentType).toBe('application/octet-stream');
  });

  it('stores local files atomically and overwrites existing objects', async () => {
    const src = path.join(root, 'upload.jpg');
    await writeFile(src, 'first version');
    const info = await storage.putFile('generations/x/character.jpg', src, 'image/jpeg');
    expect(info).toEqual({ key: 'generations/x/character.jpg', size: 13, contentType: 'image/jpeg' });

    await writeFile(src, 'v2');
    await storage.putFile('generations/x/character.jpg', src, 'image/jpeg');
    expect((await storage.getBuffer('generations/x/character.jpg')).toString()).toBe('v2');
    // No temp files left next to the object.
    expect(await listFiles(storage.baseDir)).toEqual(['generations/x/character.jpg']);
  });

  it('returns null from stat for missing objects and directories', async () => {
    expect(await storage.stat('missing/file.mp4')).toBeNull();
    await storage.putBuffer('dir/file.mp4', Buffer.from('x'), 'video/mp4');
    expect(await storage.stat('dir')).toBeNull();
    expect(await storage.stat('dir/file.mp4/deeper')).toBeNull();
  });

  it('reads inclusive byte ranges', async () => {
    await storage.putBuffer('v.mp4', Buffer.from('0123456789'), 'video/mp4');
    expect((await readAll(await storage.createReadStream('v.mp4', { start: 2, end: 5 }))).toString()).toBe('2345');
    expect((await readAll(await storage.createReadStream('v.mp4', { start: 9, end: 9 }))).toString()).toBe('9');
    expect((await readAll(await storage.createReadStream('v.mp4'))).toString()).toBe('0123456789');
    // A range past the end is truncated at the end of the file.
    expect((await readAll(await storage.createReadStream('v.mp4', { start: 8, end: 100 }))).toString()).toBe('89');
  });

  it('rejects invalid ranges and missing objects when opening a stream', async () => {
    await storage.putBuffer('v.mp4', Buffer.from('0123456789'), 'video/mp4');
    const bad = await rejection(storage.createReadStream('v.mp4', { start: 5, end: 2 }));
    expect(bad).toBeInstanceOf(StorageError);
    expect((bad as StorageError).code).toBe('invalid_range');

    const missing = await rejection(storage.createReadStream('nope.mp4'));
    expect(isStorageNotFound(missing)).toBe(true);
    expect(isStorageNotFound(await rejection(storage.getBuffer('nope.mp4')))).toBe(true);
  });

  it('copies objects', async () => {
    await storage.putBuffer('a/part1.mp4', Buffer.from('part one'), 'video/mp4');
    await storage.copy('a/part1.mp4', 'b/part1.mp4');
    expect((await storage.getBuffer('b/part1.mp4')).toString()).toBe('part one');
    expect((await storage.getBuffer('a/part1.mp4')).toString()).toBe('part one');
    await storage.copy('a/part1.mp4', 'a/part1.mp4'); // no-op
    expect(isStorageNotFound(await rejection(storage.copy('a/missing.mp4', 'b/x.mp4')))).toBe(true);
  });

  it('deletes objects and ignores missing ones', async () => {
    await storage.putBuffer('a/x.mp4', Buffer.from('x'), 'video/mp4');
    await storage.delete('a/x.mp4');
    expect(await storage.stat('a/x.mp4')).toBeNull();
    await expect(storage.delete('a/x.mp4')).resolves.toBeUndefined();
    await expect(storage.delete('never/existed.mp4')).resolves.toBeUndefined();
  });

  it('deletes by prefix', async () => {
    const keys = generationKeys(ID);
    const other = generationKeys('00000000-0000-4000-8000-000000000000');
    for (const key of [keys.part1, keys.part2, keys.final, keys.thumbnail, other.final]) {
      await storage.putBuffer(key, Buffer.from(key), 'application/octet-stream');
    }
    await storage.putBuffer(`${keys.prefix}nested/deep.json`, Buffer.from('{}'), 'application/json');

    await storage.deletePrefix(keys.prefix);
    expect(await listFiles(storage.baseDir)).toEqual([other.final]);

    // Missing prefixes are fine.
    await expect(storage.deletePrefix(keys.prefix)).resolves.toBeUndefined();
    await expect(storage.deletePrefix('nothing/here/')).resolves.toBeUndefined();
  });

  it('matches partial names like an S3 prefix', async () => {
    await storage.putBuffer('logs/abc-1.json', Buffer.from('1'), 'application/json');
    await storage.putBuffer('logs/abc-2/x.json', Buffer.from('2'), 'application/json');
    await storage.putBuffer('logs/abd.json', Buffer.from('3'), 'application/json');
    await storage.deletePrefix('logs/abc');
    expect(await listFiles(storage.baseDir)).toEqual(['logs/abd.json']);
  });

  it('never deletes an object stored exactly at a directory prefix', async () => {
    await storage.putBuffer('media/clip', Buffer.from('keep'), 'application/octet-stream');
    await storage.deletePrefix('media/clip/');
    expect(await listFiles(storage.baseDir)).toEqual(['media/clip']);
  });

  it('refuses empty or root prefixes', async () => {
    for (const prefix of ['', '/', '//', '../', 'a//']) {
      const err = await rejection(storage.deletePrefix(prefix));
      expect(err, prefix).toBeInstanceOf(StorageError);
    }
  });

  it('downloads objects to local files', async () => {
    await storage.putBuffer('a/final.mp4', Buffer.from('video bytes'), 'video/mp4');
    const dest = path.join(root, 'work', 'nested', 'final.mp4');
    await storage.downloadToFile('a/final.mp4', dest);
    expect((await readFile(dest)).toString()).toBe('video bytes');
    expect(isStorageNotFound(await rejection(storage.downloadToFile('a/none.mp4', dest)))).toBe(true);
    // A failed download keeps the previous file and leaves no temp file behind.
    expect((await readFile(dest)).toString()).toBe('video bytes');
    expect(await readdir(path.dirname(dest))).toEqual(['final.mp4']);

    await storage.putBuffer('a/final.mp4', Buffer.from('new bytes'), 'video/mp4');
    await storage.downloadToFile('a/final.mp4', dest);
    expect((await readFile(dest)).toString()).toBe('new bytes');
  });

  it('rejects invalid keys everywhere', async () => {
    const invalid = [
      '../x',
      'a/../../x',
      '/abs',
      'a//b',
      'a\\b',
      'a/./b',
      '.',
      '',
      'trailing/',
      'with space.mp4',
      'ümlaut.mp4',
      'a'.repeat(513),
    ];
    for (const key of invalid) {
      for (const op of [
        () => storage.putBuffer(key, Buffer.from('x'), 'video/mp4'),
        () => storage.getBuffer(key),
        () => storage.stat(key),
        () => storage.createReadStream(key),
        () => storage.delete(key),
        () => storage.copy('ok.mp4', key),
      ]) {
        const err = await rejection(op());
        expect(err, JSON.stringify(key)).toBeInstanceOf(StorageError);
        expect((err as StorageError).code).toBe('invalid_key');
      }
    }
    // Nothing escaped the storage directory.
    expect(await readdir(root)).toEqual([]);
  });

  it('accepts keys at the length limit', async () => {
    const key = `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(106)}.mp4`;
    expect(key.length).toBe(512);
    await storage.putBuffer(key, Buffer.from('x'), 'video/mp4');
    expect((await storage.stat(key))?.size).toBe(1);
  });

  it('passes the health check and creates the base directory', async () => {
    await storage.healthCheck();
    expect(await readdir(storage.baseDir)).toEqual([]);
  });

  it('fails the health check when the directory is not usable', async () => {
    const file = path.join(root, 'not-a-dir');
    await writeFile(file, 'x');
    const broken = new LocalStorage(file);
    const err = await rejection(broken.healthCheck());
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe('unavailable');
  });

  it('never returns signed URLs', async () => {
    expect(await storage.getSignedUrl('a/final.mp4', { downloadFileName: 'x.mp4' })).toBeNull();
  });
});

describe('storage keys', () => {
  it('builds generation keys from a UUID', () => {
    expect(generationKeys(ID)).toEqual({
      characterImage: `generations/${ID}/character.jpg`,
      part1: `generations/${ID}/part1.mp4`,
      part2: `generations/${ID}/part2.mp4`,
      final: `generations/${ID}/final.mp4`,
      thumbnail: `generations/${ID}/thumbnail.jpg`,
      prefix: `generations/${ID}/`,
    });
    expect(generationKeys(ID.toUpperCase()).final).toBe(`generations/${ID}/final.mp4`);
  });

  it('rejects ids that are not UUIDs', () => {
    for (const id of ['', 'abc', '../etc', `${ID}/x`, `${ID} `]) {
      expect(() => generationKeys(id), id).toThrow(StorageError);
    }
  });

  it('maps extensions to content types', () => {
    expect(contentTypeForKey('a/b.mp4')).toBe('video/mp4');
    expect(contentTypeForKey('a/b.JPG')).toBe('image/jpeg');
    expect(contentTypeForKey('a/b.jpeg')).toBe('image/jpeg');
    expect(contentTypeForKey('a/b.png')).toBe('image/png');
    expect(contentTypeForKey('a/b.webp')).toBe('image/webp');
    expect(contentTypeForKey('a/b.json')).toBe('application/json');
    expect(contentTypeForKey('a/.mp4')).toBe('application/octet-stream');
    expect(contentTypeForKey('a.dir/file')).toBe('application/octet-stream');
  });
});

describe('createStorage', () => {
  it('creates the local driver', () => {
    const config = loadConfig({ GEMINI_MOCK: 'true', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: root });
    const driver = createStorage(config);
    expect(driver).toBeInstanceOf(LocalStorage);
    expect((driver as LocalStorage).baseDir).toBe(path.resolve(root));
  });

  it('creates the S3 driver', () => {
    const config = loadConfig({
      GEMINI_MOCK: 'true',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'media',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_PREFIX: '/prod/',
    });
    const driver = createStorage(config);
    expect(driver).toBeInstanceOf(S3Storage);
    expect(driver.kind).toBe('s3');
    expect((driver as S3Storage).objectKey('a.mp4')).toBe('prod/a.mp4');
  });
});
