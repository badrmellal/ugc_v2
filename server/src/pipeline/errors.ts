import { VideoModelError } from '../core/ports.js';
import type { GenerationError } from '../shared/api.js';

/** The worker lost its lease (another worker took over, or the row was deleted). Stop silently. */
export class LeaseLostError extends Error {
  constructor(message = 'Job lease lost') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

/** The user canceled the generation. */
export class JobCanceledError extends Error {
  constructor(message = 'Generation canceled') {
    super(message);
    this.name = 'JobCanceledError';
  }
}

/** The worker is shutting down; the job should be released and resumed elsewhere. */
export class ShutdownError extends Error {
  constructor(message = 'Worker shutting down') {
    super(message);
    this.name = 'ShutdownError';
  }
}

/** A pipeline step failed with a known, user-presentable reason. */
export class StepError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = 'StepError';
    this.code = code;
    this.retryable = retryable;
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{30,}/g,
  /AQ\.[0-9A-Za-z_-]{20,}/g,
  /ya29\.[0-9A-Za-z_-]+/g,
  /Bearer\s+[A-Za-z0-9_.-]+/gi,
  /([?&](?:key|api_key|apiKey|access_token|signature|X-Amz-Signature|X-Goog-Signature)=)[^&\s"'<>()]+/g,
];

/** Removes credentials and query secrets from any message before it is logged or stored. */
export function redactSecrets(text: string, extraSecrets: (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 600 ? `${out.slice(0, 597)}...` : out;
}

/** Maps any thrown value to a stored, user-presentable error. */
export function toGenerationError(err: unknown, secrets: (string | null | undefined)[] = []): GenerationError {
  if (err instanceof StepError || err instanceof VideoModelError) {
    return { code: err.code, message: redactSecrets(err.message, secrets), retryable: err.retryable };
  }
  if (err instanceof JobCanceledError) {
    return { code: 'canceled', message: 'Generation canceled', retryable: false };
  }
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'internal_error';
  const message = err instanceof Error ? err.message : String(err);
  return { code, message: redactSecrets(message, secrets), retryable: true };
}
