/**
 * Maps errors thrown by `@google/genai` (Interactions bridge `APIError` subclasses, legacy `ApiError`
 * from the Files API, fetch/network errors, timeouts) to a `VideoModelError` whose `code` and
 * `retryable` flag drive the job retry policy. Upstream text is always passed through `redactSecrets`.
 */
import { VideoModelError } from '../core/ports.js';
import { redactSecrets } from '../pipeline/errors.js';

/** What the failing call was doing; only used to pick clearer messages. */
export type GeminiCallContext = 'create' | 'get' | 'cancel' | 'upload' | 'download' | 'text';

export interface UpstreamErrorDetails {
  /** HTTP status when known. */
  status: number | null;
  /** Canonical Google status such as `INVALID_ARGUMENT` or `RESOURCE_EXHAUSTED`, when present. */
  statusText: string | null;
  /** Best human-readable message found (not yet redacted). */
  message: string;
  name: string;
  /** Node/undici error code such as `ECONNRESET`, when present. */
  code: string | null;
}

const RETRYABLE_HTTP = new Set([408, 409, 425, 500, 502, 503, 504]);

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
]);

const SAFETY_PATTERN =
  /\bsafety\b|content polic|usage polic|prohibited|responsible ai|\brai\b|real people|likeness|recognizable (?:people|person|individual)|prominent (?:people|person|individual)|celebrit|\bminors?\b|(?:input|output|prompt|image|request|content) (?:was |is )?blocked|blocked (?:by|due to) (?:the )?(?:safety|content|polic)|image_safety|prohibited_content|blocklist/i;

const AUTH_PATTERN =
  /api key not valid|api_key_invalid|invalid api key|api key expired|api_key_service_blocked|permission_denied|unauthenticated|has not been used in project|is disabled|billing (?:is )?(?:not|disabled)|enable billing|billing account/i;

const REGION_PATTERN = /location is not supported|not available in your (?:country|region)|user location/i;

const TIMEOUT_PATTERN = /timed? ?out|timeout|deadline exceeded|deadline_exceeded/i;

const NETWORK_PATTERN =
  /fetch failed|network|socket hang up|connection (?:error|reset|refused|closed)|other side closed/i;

const GOOGLE_STATUS_PATTERN =
  /\b(INVALID_ARGUMENT|FAILED_PRECONDITION|OUT_OF_RANGE|UNAUTHENTICATED|PERMISSION_DENIED|NOT_FOUND|ABORTED|ALREADY_EXISTS|RESOURCE_EXHAUSTED|CANCELLED|DATA_LOSS|UNKNOWN|INTERNAL|NOT_IMPLEMENTED|UNAVAILABLE|DEADLINE_EXCEEDED)\b/;

const STATUS_TEXT_TO_HTTP: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  ABORTED: 409,
  ALREADY_EXISTS: 409,
  RESOURCE_EXHAUSTED: 429,
  CANCELLED: 499,
  INTERNAL: 500,
  UNKNOWN: 500,
  DATA_LOSS: 500,
  NOT_IMPLEMENTED: 501,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function httpStatus(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  if (typeof v === 'string' && /^[1-5]\d\d$/.test(v)) return Number(v);
  return null;
}

/** Reads `{ error: { code, message, status } }` or `{ code, message, status }` payloads. */
function readPayload(payload: unknown): { status: number | null; statusText: string | null; message: string | null } {
  if (!isRecord(payload)) return { status: null, statusText: null, message: null };
  const inner = isRecord(payload.error) ? payload.error : payload;
  const statusField = str(inner.status);
  return {
    status: httpStatus(inner.code) ?? httpStatus(inner.status),
    statusText: statusField && GOOGLE_STATUS_PATTERN.test(statusField) ? statusField : null,
    message: str(inner.message),
  };
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Extracts status, canonical status text and message from any SDK / fetch error shape. */
export function extractUpstreamError(err: unknown): UpstreamErrorDetails {
  if (!isRecord(err) && !(err instanceof Error)) {
    return { status: null, statusText: null, message: String(err ?? 'Unknown error'), name: 'Error', code: null };
  }
  const e = err as Record<string, unknown>;
  const name = str(e.name) ?? 'Error';
  const rawMessage = str(e.message) ?? '';
  let status = httpStatus(e.status) ?? httpStatus(e.statusCode) ?? httpStatus(e.code);
  let statusText: string | null = null;
  let message: string | null = null;

  // Interactions bridge: APIError.error = parsed body ({ error: {...} } or {...}).
  for (const candidate of [e.error, e.data$, e.body, e.cause]) {
    const payload = typeof candidate === 'string' ? parseJsonObject(candidate) : candidate;
    const p = readPayload(payload);
    status = status ?? p.status;
    statusText = statusText ?? p.statusText;
    message = message ?? p.message;
    if (message) break;
  }
  // Legacy ApiError (Files API): the message itself is the JSON error body.
  if (!message && rawMessage.includes('{')) {
    const p = readPayload(parseJsonObject(rawMessage));
    status = status ?? p.status;
    statusText = statusText ?? p.statusText;
    message = p.message;
  }
  const finalMessage = message ?? rawMessage ?? '';
  statusText = statusText ?? GOOGLE_STATUS_PATTERN.exec(`${rawMessage} ${finalMessage}`)?.[1] ?? null;
  if (status === null && statusText) status = STATUS_TEXT_TO_HTTP[statusText] ?? null;

  let code = typeof e.code === 'string' ? e.code : null;
  if (!code && isRecord(e.cause) && typeof e.cause.code === 'string') code = e.cause.code;
  return { status, statusText, message: finalMessage || name, name, code };
}

function isTimeout(d: UpstreamErrorDetails): boolean {
  return (
    d.name === 'TimeoutError' ||
    d.name === 'APIConnectionTimeoutError' ||
    d.name === 'RequestTimeoutError' ||
    d.code === 'ETIMEDOUT' ||
    d.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    d.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    d.code === 'UND_ERR_BODY_TIMEOUT' ||
    d.statusText === 'DEADLINE_EXCEEDED' ||
    (d.status === null && TIMEOUT_PATTERN.test(d.message))
  );
}

function isNetwork(d: UpstreamErrorDetails): boolean {
  return (
    d.name === 'APIConnectionError' ||
    d.name === 'ConnectionError' ||
    (d.code !== null && NETWORK_CODES.has(d.code)) ||
    (d.status === null && (d.name === 'TypeError' || d.name === 'AbortError') && NETWORK_PATTERN.test(d.message)) ||
    (d.status === null && NETWORK_PATTERN.test(d.message))
  );
}

function label(d: UpstreamErrorDetails): string {
  const parts = [d.status !== null ? `HTTP ${d.status}` : null, d.statusText].filter(Boolean);
  return parts.length ? parts.join(' ') : 'no HTTP status';
}

export const SAFETY_HINT =
  'Check the script and the character image. Uploading images of certain recognizable people is not supported, and images of minors are not supported in the EEA, Switzerland and the UK.';

export const AUTH_HINT =
  'Check that GEMINI_API_KEY is valid, that the Gemini API is enabled for its Google Cloud project, and that billing is set up (Gemini Omni has no free tier).';

/** True when an upstream message looks like a content safety or policy block. */
export function looksLikeSafetyBlock(message: string): boolean {
  return SAFETY_PATTERN.test(message);
}

/**
 * Classifies any error from a Gemini call into a `VideoModelError`.
 * Never includes the API key: every upstream string is redacted with `apiKey` as an extra secret.
 */
export function classifyGeminiError(
  err: unknown,
  apiKey: string | null | undefined,
  context: GeminiCallContext = 'create',
): VideoModelError {
  if (err instanceof VideoModelError) {
    const message = redactSecrets(err.message, [apiKey]);
    if (message === err.message) return err;
    return new VideoModelError(err.code, message, { retryable: err.retryable, status: err.status, cause: err });
  }
  const d = extractUpstreamError(err);
  const upstream = redactSecrets(d.message, [apiKey]) || 'no details';
  const status = d.status;
  const make = (code: string, message: string, retryable: boolean) =>
    new VideoModelError(code, message, { retryable, status, cause: err });

  if (status === 401 || status === 403 || d.statusText === 'UNAUTHENTICATED' || d.statusText === 'PERMISSION_DENIED') {
    if (REGION_PATTERN.test(d.message)) {
      return make('region_unsupported', `Gemini is not available for this server's location (${upstream}).`, false);
    }
    return make('auth_error', `Gemini rejected the API key (${label(d)}: ${upstream}). ${AUTH_HINT}`, false);
  }
  if (status === 400 && AUTH_PATTERN.test(d.message)) {
    return make('auth_error', `Gemini rejected the API key (${label(d)}: ${upstream}). ${AUTH_HINT}`, false);
  }
  if (REGION_PATTERN.test(d.message) && (status === null || status < 500)) {
    return make(
      'region_unsupported',
      `Gemini is not available for this server's location (${upstream}). Deploy the worker in a supported region.`,
      false,
    );
  }
  if ((status === null || status < 500) && status !== 429 && SAFETY_PATTERN.test(d.message)) {
    return make(
      'safety_blocked',
      `Gemini blocked this request for safety or policy reasons (${upstream}). ${SAFETY_HINT}`,
      false,
    );
  }
  if (status === 429 || d.statusText === 'RESOURCE_EXHAUSTED') {
    return make(
      'rate_limited',
      `Gemini rate limit or spending limit reached (${label(d)}: ${upstream}). Limits apply per Google Cloud project and spend limits use a rolling 10 minute window.`,
      true,
    );
  }
  if (status === 404 || d.statusText === 'NOT_FOUND') {
    if (context === 'download') {
      // Retryable: on resume the pipeline polls the interaction again, which can return the video inline.
      return make(
        'output_not_found',
        `The generated video file was not found on Gemini (files expire after 48 hours): ${upstream}`,
        true,
      );
    }
    const what =
      context === 'get' || context === 'cancel'
        ? 'The Gemini interaction was not found (it may have expired or been deleted)'
        : 'Gemini could not find the requested model or resource';
    return make('not_found', `${what}: ${upstream}`, false);
  }
  if (status === 413) {
    return make('invalid_request', `Gemini rejected the request as too large (${upstream}).`, false);
  }
  if (status === 400 || d.statusText === 'INVALID_ARGUMENT' || d.statusText === 'FAILED_PRECONDITION') {
    return make('invalid_request', `Gemini rejected the request as invalid (${label(d)}): ${upstream}`, false);
  }
  if (status !== null && RETRYABLE_HTTP.has(status)) {
    return make('upstream_unavailable', `Gemini is temporarily unavailable (${label(d)}: ${upstream}).`, true);
  }
  if (status !== null && status >= 500) {
    return make('upstream_unavailable', `Gemini returned a server error (${label(d)}: ${upstream}).`, true);
  }
  if (isTimeout(d)) {
    return make('timeout', `The request to Gemini timed out (${upstream}).`, true);
  }
  if (d.name === 'APIUserAbortError') {
    return make('aborted', `The request to Gemini was aborted (${upstream}).`, true);
  }
  if (isNetwork(d)) {
    return make('network_error', `Could not reach Gemini (${upstream}).`, true);
  }
  if (status !== null && status >= 400) {
    return make('api_error', `Gemini returned an error (${label(d)}: ${upstream}).`, false);
  }
  return make('gemini_error', `Unexpected error while calling Gemini: ${upstream}`, true);
}
