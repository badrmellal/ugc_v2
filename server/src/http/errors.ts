import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiErrorBody } from '../shared/api.js';

/** An error with a stable API code, rendered as `ApiErrorBody` by the error handler. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (message = 'Generation not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);
export const validationError = (message: string, details?: unknown) =>
  new HttpError(400, 'validation_error', message, details);

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}

/** Zod issues trimmed to what a client needs to show field errors. */
export function formatZodIssues(error: z.ZodError): { path: (string | number)[]; code: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => (typeof p === 'number' ? p : String(p))),
    code: issue.code,
    message: issue.message,
  }));
}

function zodSummary(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid request.';
  const where = first.path.length ? `${first.path.map(String).join('.')}: ` : '';
  const more = error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : '';
  return `Invalid request. ${where}${first.message}${more}`;
}

/** Fastify / plugin error codes with a known client-facing mapping. */
const FASTIFY_CODES: Record<string, { status: number; code: string; message?: string }> = {
  FST_REQ_FILE_TOO_LARGE: { status: 413, code: 'payload_too_large', message: 'The character image is too large.' },
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', message: 'The request body is too large.' },
  FST_PARTS_LIMIT: { status: 413, code: 'payload_too_large', message: 'Too many parts in the upload.' },
  FST_FILES_LIMIT: { status: 413, code: 'payload_too_large', message: 'Upload exactly one character image.' },
  FST_FIELDS_LIMIT: { status: 413, code: 'payload_too_large', message: 'Too many form fields in the upload.' },
  FST_INVALID_MULTIPART_CONTENT_TYPE: {
    status: 415,
    code: 'unsupported_media_type',
    message: 'Expected a multipart/form-data upload.',
  },
  FST_INVALID_JSON_FIELD_ERROR: { status: 400, code: 'validation_error', message: 'A form field is not valid JSON.' },
  FST_PROTO_VIOLATION: { status: 400, code: 'validation_error', message: 'Invalid form field name.' },
  FST_MP_PREMATURE_CLOSE: { status: 400, code: 'validation_error', message: 'The upload was interrupted.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type', message: 'Unsupported content type.' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'validation_error', message: 'The JSON body is empty.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'validation_error', message: 'The JSON body is invalid.' },
};

/** Default API code for a bare HTTP status (errors from plugins that carry only `statusCode`). */
function codeForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return 'validation_error';
  }
}

export interface ErrorHandlerOptions {
  /** Removes secrets from messages before they are logged. */
  scrub: (text: string) => string;
}

/**
 * Renders every error as `ApiErrorBody`. 4xx messages are client-facing; 5xx responses never expose
 * internals (the request id is included so operators can find the log line).
 */
export function createErrorHandler(opts: ErrorHandlerOptions) {
  return function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
    let status: number;
    let body: ApiErrorBody;

    if (error instanceof HttpError) {
      status = error.statusCode;
      body = errorBody(error.code, error.message, error.details);
    } else if (error instanceof z.ZodError) {
      status = 400;
      body = errorBody('validation_error', zodSummary(error), formatZodIssues(error));
    } else {
      const code = (error as FastifyError).code;
      const mapped = typeof code === 'string' ? FASTIFY_CODES[code] : undefined;
      const statusCode = (error as FastifyError).statusCode;
      if (mapped) {
        status = mapped.status;
        body = errorBody(mapped.code, mapped.message ?? error.message);
      } else if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
        status = statusCode;
        body = errorBody(codeForStatus(statusCode), error.message || 'Invalid request.');
      } else {
        status = 500;
        body = errorBody(
          'internal_error',
          'Something went wrong on the server. Try again; if it keeps failing, check the server logs for this request id.',
          { requestId: request.id },
        );
      }
    }

    if (status >= 500) {
      request.log.error(
        { err: { type: error.name, message: opts.scrub(error.message), stack: opts.scrub(error.stack ?? '') } },
        'request failed',
      );
    } else if (status !== 401 && status !== 404) {
      request.log.info({ status, code: body.error.code }, body.error.message);
    }

    if (status === 429 && !reply.hasHeader('retry-after')) reply.header('retry-after', '60');
    return reply.code(status).type('application/json; charset=utf-8').send(body);
  };
}
