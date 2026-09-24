/**
 * Typed client for the Omni UGC Studio HTTP API (see docs/API.md).
 *
 * Every call uses same-origin cookies. Non-2xx responses are turned into `ApiError`
 * built from the server's `ApiErrorBody`. A 401 on any authenticated call notifies the
 * listeners registered with `onUnauthorized` so the app can show the login screen.
 */
import type {
  ApiErrorBody,
  AppConfigResponse,
  CostBreakdown,
  CreateGenerationPayload,
  EstimateRequest,
  GenerationDTO,
  GenerationListResponse,
  GenerationStatus,
  PlanRequest,
  RegenerateRequest,
  ScriptPlan,
  SessionResponse,
} from '@shared/api';

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// ---------------------------------------------------------------------------
// 401 handling
// ---------------------------------------------------------------------------

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Registers a callback fired whenever an authenticated call returns 401. Returns an unsubscribe function. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

const FALLBACK_MESSAGES: Record<number, [string, string]> = {
  400: ['validation_error', 'The request was not valid.'],
  401: ['unauthorized', 'Your session has expired. Sign in again.'],
  403: ['forbidden', 'This action is not allowed.'],
  404: ['not_found', 'Not found.'],
  409: ['conflict', 'This action is not allowed in the current state.'],
  413: ['payload_too_large', 'The upload is too large.'],
  415: ['unsupported_media_type', 'This file type is not supported.'],
  429: ['rate_limited', 'Too many requests. Wait a moment and try again.'],
  502: ['bad_gateway', 'The server could not reach an upstream service. Try again.'],
  503: ['unavailable', 'The service is temporarily unavailable. Try again shortly.'],
  504: ['timeout', 'The server took too long to respond. Try again.'],
};

/** Builds an `ApiError` from an HTTP status and a parsed (or unparseable) response body. */
export function buildApiError(status: number, body: unknown): ApiError {
  if (isApiErrorBody(body)) {
    return new ApiError(status, body.error.code, body.error.message, body.error.details);
  }
  const fallback = FALLBACK_MESSAGES[status];
  if (fallback) return new ApiError(status, fallback[0], fallback[1]);
  if (status >= 500) return new ApiError(status, 'internal_error', `The server returned an error (HTTP ${status}).`);
  return new ApiError(status, 'http_error', `Request failed (HTTP ${status}).`);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** JSON body. Omit for bodyless requests (no Content-Type is sent then). */
  json?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  /** Do not broadcast a 401 (used by login, where 401 means a wrong password). */
  skipUnauthorizedHandler?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form; // The browser sets the multipart boundary.
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
  }

  let text = '';
  if (response.status !== 204) {
    try {
      text = await response.text();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // The connection dropped while the body was streaming.
      throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
    }
  }
  if (!response.ok) {
    const error = buildApiError(response.status, parseJson(text));
    if (response.status === 401 && !options.skipUnauthorizedHandler) notifyUnauthorized();
    throw error;
  }
  if (!text) return undefined as T;
  const data = parseJson(text);
  if (data === null) {
    throw new ApiError(response.status, 'invalid_response', 'The server returned an unexpected response.');
  }
  return data as T;
}

const generationPath = (id: string) => `/api/generations/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function getSession(signal?: AbortSignal): Promise<SessionResponse> {
  return request<SessionResponse>('/api/auth/session', { signal });
}

export function login(password: string): Promise<SessionResponse> {
  return request<SessionResponse>('/api/auth/login', {
    method: 'POST',
    json: { password },
    skipUnauthorizedHandler: true,
  });
}

export function logout(): Promise<void> {
  return request<void>('/api/auth/logout', { method: 'POST', skipUnauthorizedHandler: true });
}

// ---------------------------------------------------------------------------
// Config, planning, estimates
// ---------------------------------------------------------------------------

export function getConfig(signal?: AbortSignal): Promise<AppConfigResponse> {
  return request<AppConfigResponse>('/api/config', { signal });
}

export function previewPlan(body: PlanRequest, signal?: AbortSignal): Promise<ScriptPlan> {
  return request<ScriptPlan>('/api/plan', { method: 'POST', json: body, signal });
}

/**
 * `EstimateRequest` plus the optional `reinforceCharacterOnExtend` flag that POST /api/estimate also
 * accepts, so the estimate includes the second image input when that option is on.
 */
export type EstimateInput = EstimateRequest & {
  settings: EstimateRequest['settings'] & { reinforceCharacterOnExtend?: boolean };
};

export function estimateCost(body: EstimateInput, signal?: AbortSignal): Promise<CostBreakdown> {
  return request<CostBreakdown>('/api/estimate', { method: 'POST', json: body, signal });
}

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

/** Multipart upload: `payload` (JSON string) first, then the `characterImage` file. */
export function createGeneration(payload: CreateGenerationPayload, characterImage: File): Promise<GenerationDTO> {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  form.append('characterImage', characterImage, characterImage.name);
  return request<GenerationDTO>('/api/generations', { method: 'POST', form });
}

export interface ListGenerationsParams {
  limit?: number;
  cursor?: string | null;
  status?: GenerationStatus;
}

export function buildListQuery(params: ListGenerationsParams): string {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.status) search.set('status', params.status);
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function listGenerations(params: ListGenerationsParams, signal?: AbortSignal): Promise<GenerationListResponse> {
  return request<GenerationListResponse>(`/api/generations${buildListQuery(params)}`, { signal });
}

export function getGeneration(id: string, signal?: AbortSignal): Promise<GenerationDTO> {
  return request<GenerationDTO>(generationPath(id), { signal });
}

export function regenerateGeneration(id: string, body: RegenerateRequest): Promise<GenerationDTO> {
  return request<GenerationDTO>(`${generationPath(id)}/regenerate`, { method: 'POST', json: body });
}

export function cancelGeneration(id: string): Promise<GenerationDTO> {
  return request<GenerationDTO>(`${generationPath(id)}/cancel`, { method: 'POST' });
}

export function deleteGeneration(id: string): Promise<void> {
  return request<void>(generationPath(id), { method: 'DELETE' });
}
