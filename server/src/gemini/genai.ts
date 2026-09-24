/**
 * Minimal structural view of the `@google/genai` client used by the Gemini adapters. Tests inject a
 * fake object with the same shape; production wraps a real `GoogleGenAI` instance.
 */
import { GoogleGenAI } from '@google/genai';

export interface GenAiCallOptions {
  /** Per-request timeout in milliseconds. */
  timeout?: number;
  /** SDK-level retries. Must be 0 for paid, non-idempotent calls such as video `create`. */
  maxRetries?: number;
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

/** Wraps a real SDK client. The API key stays inside the SDK instance and is never exposed. */
export function createGenAi(apiKey: string, requestTimeoutMs: number): GenAiLike {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: requestTimeoutMs } });
  return {
    interactions: {
      create: (params, options) => ai.interactions.create(params as unknown as CreateParams, options),
      get: (id, options) => ai.interactions.get(id, undefined, options),
      cancel: (id, options) => ai.interactions.cancel(id, undefined, options),
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
