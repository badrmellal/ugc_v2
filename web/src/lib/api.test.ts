import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, buildApiError, buildListQuery, getGeneration, login, onUnauthorized } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('buildApiError', () => {
  it('uses the ApiErrorBody when present', () => {
    const error = buildApiError(402, {
      error: { code: 'budget_exceeded', message: 'Budget reached', details: { x: 1 } },
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(402);
    expect(error.code).toBe('budget_exceeded');
    expect(error.message).toBe('Budget reached');
    expect(error.details).toEqual({ x: 1 });
  });

  it('falls back to a status-based error for other bodies', () => {
    expect(buildApiError(429, null).code).toBe('rate_limited');
    expect(buildApiError(500, '<html>').code).toBe('internal_error');
    expect(buildApiError(418, {}).code).toBe('http_error');
  });
});

describe('buildListQuery', () => {
  it('only includes set parameters', () => {
    expect(buildListQuery({})).toBe('');
    expect(buildListQuery({ limit: 20, cursor: null })).toBe('?limit=20');
    expect(buildListQuery({ limit: 20, cursor: 'abc', status: 'failed' })).toBe('?limit=20&cursor=abc&status=failed');
  });
});

describe('request handling', () => {
  it('notifies listeners on 401 for authenticated calls', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: 'unauthorized', message: 'Sign in' } }));
    vi.stubGlobal('fetch', fetchMock);
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);

    await expect(getGeneration('abc')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generations/abc',
      expect.objectContaining({ credentials: 'same-origin', method: 'GET' }),
    );

    // A wrong password on login is not a session problem.
    await expect(login('nope')).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('turns network failures into ApiError with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(getGeneration('abc')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('parses JSON bodies on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { id: 'abc', status: 'queued' })),
    );
    await expect(getGeneration('abc')).resolves.toMatchObject({ id: 'abc', status: 'queued' });
  });
});
