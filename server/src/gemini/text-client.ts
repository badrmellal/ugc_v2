/**
 * Gemini text model used by the script splitter: one `interactions.create` call with a system
 * instruction and structured JSON output (`response_format: { type: 'text', mime_type:
 * 'application/json', schema }`). The answer is parsed defensively (code fences, stray prose).
 */
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { VideoModelError, type TextModelClient, type UsageInfo } from '../core/ports.js';
import { normalizeUsage } from '../pricing/pricing.js';
import { classifyGeminiError } from './errors.js';
import { createGenAi, extractOutputText, isRecord, type GenAiLike } from './genai.js';

const DEFAULT_TIMEOUT_MS = 45_000;

/** The model answered (and billed the call) but the answer was unusable. Carries the usage. */
export class TextModelResponseError extends VideoModelError {
  readonly usage: UsageInfo | null;
  constructor(code: string, message: string, usage: UsageInfo | null) {
    super(code, message, { retryable: true });
    this.name = 'TextModelResponseError';
    this.usage = usage;
  }
}

/** Parses JSON from model text: plain JSON, fenced ```json blocks, or the outermost {...} span. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  throw new VideoModelError('invalid_response', 'The text model did not return valid JSON.', { retryable: true });
}

export interface GeminiTextClientOptions {
  config: AppConfig;
  logger: Logger;
  ai?: GenAiLike;
}

export class GeminiTextClient implements TextModelClient {
  readonly model: string;
  private readonly ai: GenAiLike;
  private readonly apiKey: string;
  private readonly log: Logger;
  /** Downgrades applied for the rest of the process when the API rejects a request field. */
  private schemaSupported = true;
  private temperatureSupported = true;

  constructor(opts: GeminiTextClientOptions) {
    this.model = opts.config.gemini.splitterModel;
    this.apiKey = opts.config.gemini.apiKey ?? '';
    if (!opts.ai && !this.apiKey) throw new Error('GEMINI_API_KEY is required for the Gemini text client.');
    this.ai = opts.ai ?? createGenAi(this.apiKey, opts.config.gemini.requestTimeoutMs);
    this.log = opts.logger.child({ component: 'gemini-text' });
  }

  private buildParams(input: Parameters<TextModelClient['generateJson']>[0]): Record<string, unknown> {
    const params: Record<string, unknown> = {
      model: this.model,
      system_instruction: input.systemInstruction,
      input: this.schemaSupported
        ? input.prompt
        : `${input.prompt}\n\nRespond with a single JSON object that matches this JSON schema:\n${JSON.stringify(input.jsonSchema)}`,
      response_format: this.schemaSupported
        ? { type: 'text', mime_type: 'application/json', schema: input.jsonSchema }
        : { type: 'text', mime_type: 'application/json' },
      // The split does not need server-side history.
      store: false,
    };
    if (input.temperature !== undefined && this.temperatureSupported) {
      params.generation_config = { temperature: input.temperature };
    }
    return params;
  }

  async generateJson(input: Parameters<TextModelClient['generateJson']>[0]): Promise<{
    data: unknown;
    usage: UsageInfo | null;
  }> {
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: unknown;
      try {
        raw = await this.ai.interactions.create(this.buildParams(input), { maxRetries: 1, timeout });
      } catch (err) {
        const e = classifyGeminiError(err, this.apiKey, 'text');
        if (e.status === 400 && this.temperatureSupported && /temperature|generation_config/i.test(e.message)) {
          this.temperatureSupported = false;
          this.log.warn({ model: this.model }, 'text model rejected temperature, omitting it');
          continue;
        }
        if (e.status === 400 && this.schemaSupported && /schema|response_format/i.test(e.message)) {
          this.schemaSupported = false;
          this.log.warn({ model: this.model }, 'text model rejected the JSON schema, asking for JSON in the prompt');
          continue;
        }
        throw e;
      }
      const status = isRecord(raw) ? raw.status : undefined;
      const usage = isRecord(raw) ? normalizeUsage(raw.usage) : null;
      if (status !== undefined && status !== 'completed') {
        throw new TextModelResponseError(
          'text_model_failed',
          `The text model finished with status "${String(status)}".`,
          usage,
        );
      }
      const text = extractOutputText(raw);
      if (!text.trim()) {
        throw new TextModelResponseError('invalid_response', 'The text model returned an empty answer.', usage);
      }
      try {
        return { data: parseJsonLoose(text), usage };
      } catch {
        throw new TextModelResponseError('invalid_response', 'The text model did not return valid JSON.', usage);
      }
    }
    throw new VideoModelError('invalid_request', 'The text model rejected the request.', { retryable: false });
  }
}
