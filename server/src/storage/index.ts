import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { StorageDriver } from '../core/ports.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export { LocalStorage } from './local.js';
export { S3Storage, buildS3ClientConfig, copySource, type S3StorageConfig } from './s3.js';
export {
  MAX_KEY_LENGTH,
  StorageError,
  assertValidKey,
  assertValidPrefix,
  contentTypeForKey,
  generationKeys,
  isStorageNotFound,
  isUuid,
  type GenerationKeys,
  type StorageErrorCode,
} from './keys.js';

/** Builds the storage driver selected by `STORAGE_DRIVER`. */
export function createStorage(config: AppConfig): StorageDriver {
  const { storage } = config;
  if (storage.driver === 's3') {
    return new S3Storage(storage.s3);
  }
  return new LocalStorage(path.resolve(storage.localDir));
}
