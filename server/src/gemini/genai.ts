/**
 * Minimal structural view of the `@google/genai` client used by the Gemini adapters. Tests inject a
 * fake object with the same shape; production wraps a real `GoogleGenAI` instance.
 */
import { GoogleGenAI } from '@google/genai';

export interface GenAiCallOptions {
  /** Per-request timeout in milliseconds (for a streamed call it covers the whole stream). */
  timeout?: number;
  /** SDK-level retries. Must be 0 for paid, non-idempotent calls such as video `create`. */
  maxRetries?: number;
  /** Aborts the request (and closes a stream). */
  signal?: AbortSignal;
}

/** Subset of the SDK `File` resource that the adapters read. */
export interface GenAiFile {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
  expirationTime?: string;
  error?: { message?: string; code?: number };
}

export interface GenAiLike {
  interactions: {
    /** Returns an Interaction, or an async iterable of SSE events when `params.stream` is true. */
    create(params: Record<string, unknown>, options?: GenAiCallOptions): Promise<unknown>;
    get(id: string, options?: GenAiCallOptions): Promise<unknown>;
    cancel(id: string, options?: GenAiCallOptions): Promise<unknown>;
  };
  files: {
    upload(params: { file: Blob; config: { mimeType: string; displayName: string } }): Promise<GenAiFile>;
    get(params: { name: string }): Promise<GenAiFile>;
  };
}

type CreateParams = Parameters<GoogleGenAI['interactions']['create']>[0];

/**
 * The SDK ignores `timeout` when a signal is given, so both are merged into one signal here.
 * Without a signal the SDK applies `timeout` itself.
 */
function requestOptions(options: GenAiCallOptions | undefined) {
  if (!options) return undefined;
  const { signal, timeout, maxRetries } = options;
  if (!signal) return { timeout, maxRetries };
  const merged = timeout && timeout > 0 ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : signal;
  return { maxRetries, signal: merged };
}

/**
 * Wraps a real SDK client. The API key stays inside the SDK instance and is never exposed.
 * `baseUrl` is only for pointing the SDK at a local test server.
 */
export function createGenAi(apiKey: string, requestTimeoutMs: number, baseUrl?: string): GenAiLike {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: requestTimeoutMs, ...(baseUrl ? { baseUrl } : {}) } });
  return {
    interactions: {
      create: (params, options) => ai.interactions.create(params as unknown as CreateParams, requestOptions(options)),
      get: (id, options) => ai.interactions.get(id, undefined, requestOptions(options)),
      cancel: (id, options) => ai.interactions.cancel(id, undefined, requestOptions(options)),
    },
    files: {
      upload: async (params) => (await ai.files.upload(params)) as GenAiFile,
      get: async (params) => (await ai.files.get(params)) as GenAiFile,
    },
  };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/** Steps of the current turn, newest first, stopping at the turn's `user_input` step (like the SDK). */
export function currentTurnSteps(raw: Record<string, unknown>): Record<string, unknown>[] {
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const out: Record<string, unknown>[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step: unknown = steps[i];
    if (!isRecord(step)) continue;
    if (step.type === 'user_input') break;
    out.push(step);
  }
  return out;
}

/** Concatenated text of the latest model output of the current turn. */
export function extractOutputText(raw: unknown): string {
  if (!isRecord(raw)) return '';
  if (typeof raw.output_text === 'string' && raw.output_text.trim()) return raw.output_text;
  for (const step of currentTurnSteps(raw)) {
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    const texts = step.content
      .filter((c): c is Record<string, unknown> => isRecord(c) && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string);
    if (texts.length) return texts.join('');
  }
  return '';
}
