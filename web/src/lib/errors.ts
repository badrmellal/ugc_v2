/** Turns API and network errors into short, specific copy for the UI. */
import { isApiError } from './api';

export interface ErrorDescription {
  title: string;
  message: string;
  details: string[];
}

const TITLES: Record<string, string> = {
  unauthorized: 'Signed out',
  forbidden_origin: 'Request blocked',
  not_found: 'Not found',
  validation_error: 'Some inputs are not valid',
  unsupported_media_type: 'Unsupported image type',
  payload_too_large: 'Image too large',
  budget_exceeded: 'Daily budget reached',
  queue_full: 'Queue is full',
  rate_limited: 'Too many requests',
  conflict: 'Action not available',
  splitter_failed: 'Script split failed',
  internal_error: 'Server error',
  network_error: 'Connection problem',
};

const HINTS: Record<string, string> = {
  budget_exceeded: 'New videos are blocked until the daily budget resets (UTC midnight) or the limit is raised.',
  queue_full: 'Wait for some running videos to finish, then try again.',
  rate_limited: 'Wait a minute, then try again.',
  splitter_failed: 'You can still generate: the server falls back to its rule-based split.',
};

function formatPath(path: unknown): string {
  if (!Array.isArray(path)) return '';
  return path.map((part) => String(part)).join('.');
}

/** Extracts readable lines from `details` (zod issues or a `{ issues }` / `{ fieldErrors }` object). */
export function describeDetails(details: unknown): string[] {
  if (details === null || details === undefined) return [];
  const issues: unknown = Array.isArray(details)
    ? details
    : typeof details === 'object' && 'issues' in details
      ? (details as { issues: unknown }).issues
      : null;
  if (Array.isArray(issues)) {
    return issues
      .map((issue: unknown) => {
        if (typeof issue === 'string') return issue;
        if (typeof issue !== 'object' || issue === null) return '';
        const { path, message } = issue as { path?: unknown; message?: unknown };
        const where = formatPath(path);
        const text = typeof message === 'string' ? message : '';
        return where && text ? `${where}: ${text}` : text || where;
      })
      .filter((line) => line.length > 0)
      .slice(0, 10);
  }
  if (typeof details === 'object' && 'fieldErrors' in details) {
    const fieldErrors = (details as { fieldErrors: unknown }).fieldErrors;
    if (typeof fieldErrors === 'object' && fieldErrors !== null) {
      return Object.entries(fieldErrors as Record<string, unknown>).flatMap(([field, messages]) =>
        Array.isArray(messages) ? messages.map((m) => `${field}: ${String(m)}`) : [],
      );
    }
  }
  return [];
}

export function describeError(error: unknown): ErrorDescription {
  if (isApiError(error)) {
    const hint = HINTS[error.code];
    return {
      title: TITLES[error.code] ?? 'Request failed',
      message: hint ? `${error.message} ${hint}` : error.message,
      details: describeDetails(error.details),
    };
  }
  if (error instanceof Error) {
    return { title: 'Something went wrong', message: error.message, details: [] };
  }
  return { title: 'Something went wrong', message: 'An unexpected error occurred.', details: [] };
}

export function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}
