import { LIMITS } from '@shared/api';
import { formatBytes } from './format';

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * MIME type of the file, falling back to its extension when the browser reports none or a generic
 * type. The server sniffs the real format from the file's bytes.
 */
export function resolveImageType(file: { name: string; type: string }): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_TYPES[extension] ?? '';
}

/** Client-side mirror of the server's image checks. Returns an error message, or null when valid. */
export function validateImageFile(file: { name: string; type: string; size: number }): string | null {
  if (!LIMITS.imageMimeTypes.includes(resolveImageType(file))) {
    return 'Use a JPEG, PNG or WebP image.';
  }
  if (file.size <= 0) return 'The file is empty.';
  if (file.size > LIMITS.imageMaxBytes) {
    return `The image is ${formatBytes(file.size)}. The maximum is ${formatBytes(LIMITS.imageMaxBytes)}.`;
  }
  return null;
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

export function readImageSize(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
