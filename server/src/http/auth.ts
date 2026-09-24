import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'omni_session';
/** Subject of password sessions (single shared password, single user). */
export const SESSION_SUBJECT = 'admin';
/** `createdBy` / subject recorded for bearer-token requests. */
export const TOKEN_SUBJECT = 'api-token';

export interface AuthInfo {
  subject: string;
  method: 'session' | 'token' | 'none';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved credentials for /api requests (null when unauthenticated). */
    auth: AuthInfo | null;
  }
}

export interface SessionPayload {
  sub: string;
  /** Issued at, seconds since epoch. */
  iat: number;
  /** Expires at, seconds since epoch. */
  exp: number;
}

/** Auth is enforced unless explicitly disabled, or when nothing is configured outside production. */
export function isAuthEnabled(config: AppConfig): boolean {
  if (config.auth.disabled) return false;
  return Boolean(config.auth.password) || config.auth.apiTokens.length > 0 || config.isProduction;
}

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload part))`. */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(body, secret).toString('base64url')}`;
}

/** Returns the payload when the signature is valid and the session has not expired. */
export function verifySession(token: string | undefined, secret: string, nowMs = Date.now()): SessionPayload | null {
  if (!token || token.length > 1024) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = hmac(body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const { sub, iat, exp } = payload as Record<string, unknown>;
  if (typeof sub !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') return null;
  if (exp * 1000 <= nowMs) return null;
  return { sub, iat, exp };
}

/** Constant-time password check (comparing fixed-length digests hides the expected length). */
export function passwordMatches(input: string, expected: string | null): boolean {
  if (!expected) return false;
  return timingSafeEqual(sha256(input), sha256(expected));
}

/** Constant-time bearer token check against every configured token. */
export function tokenMatches(input: string, tokens: readonly string[]): boolean {
  const given = sha256(input);
  let ok = false;
  for (const token of tokens) {
    // No early exit: the time taken does not reveal which token matched.
    if (timingSafeEqual(given, sha256(token))) ok = true;
  }
  return ok;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** Resolves the caller from a bearer token or the session cookie. */
export function resolveAuth(req: FastifyRequest, config: AppConfig, nowMs = Date.now()): AuthInfo | null {
  const token = bearerToken(req);
  if (token !== null) {
    return config.auth.apiTokens.length > 0 && tokenMatches(token, config.auth.apiTokens)
      ? { subject: TOKEN_SUBJECT, method: 'token' }
      : null;
  }
  const session = verifySession(req.cookies?.[SESSION_COOKIE], config.auth.sessionSecret, nowMs);
  return session ? { subject: session.sub, method: 'session' } : null;
}

function isSecureRequest(req: FastifyRequest, config: AppConfig): boolean {
  return req.protocol === 'https' || config.isProduction;
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, config: AppConfig, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const ttlSec = Math.floor(config.auth.sessionTtlMs / 1000);
  const token = signSession({ sub: SESSION_SUBJECT, iat, exp: iat + ttlSec }, config.auth.sessionSecret);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req, config),
    maxAge: ttlSec,
  });
}

export function clearSessionCookie(req: FastifyRequest, reply: FastifyReply, config: AppConfig) {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req, config),
  });
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** The origin mutating requests must come from: PUBLIC_ORIGIN, else the request's own origin. */
export function expectedOrigin(req: FastifyRequest, config: AppConfig): string | null {
  if (config.publicOrigin) return normalizeOrigin(config.publicOrigin);
  return normalizeOrigin(`${req.protocol}://${req.host}`);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** Percent-decodes a path the way the router does before matching (raw path when malformed). */
function decodedPath(url: string): string {
  const path = pathOf(url);
  if (!path.includes('%')) return path;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function startsWithApi(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Whether a raw URL (path + optional query) points under /api, before or after percent-decoding. */
export function isApiPath(url: string): boolean {
  return startsWithApi(pathOf(url)) || startsWithApi(decodedPath(url));
}

/**
 * Whether a request targets the API. The router matches percent-decoded paths (`/%61pi/config` is
 * routed to `/api/config`), so the matched route decides first and the decoded URL covers requests
 * that match no route (404s).
 */
export function isApiRequest(req: FastifyRequest): boolean {
  const route = req.routeOptions?.url;
  if (route && startsWithApi(route)) return true;
  return isApiPath(req.url);
}

/** `/api/auth/*` routes (session, login, logout) are reachable without credentials. */
function isPublicAuthRoute(req: FastifyRequest): boolean {
  return req.routeOptions?.url?.startsWith('/api/auth/') ?? false;
}

/** Rate limiter shape of `fastify.createRateLimit()`. */
export type AttemptLimiter = (
  req: FastifyRequest,
  opts?: { increment?: boolean },
) => Promise<{ isAllowed: true } | { isAllowed: false; isExceeded: boolean; remaining: number; ttlInSeconds: number }>;

export interface AuthHookOptions {
  /**
   * Counts failed bearer-token attempts per client. Once exhausted, every token attempt from that
   * client (valid or not) gets 429 until the window resets, so tokens cannot be brute-forced.
   */
  tokenAttempts?: AttemptLimiter;
}

function tooManyAttempts(ttlInSeconds: number): HttpError {
  const wait = Math.max(ttlInSeconds, 1);
  return new HttpError(
    429,
    'rate_limited',
    `Too many requests with an invalid API token. Try again in ${wait} seconds.`,
  );
}

/**
 * onRequest hook for everything under /api:
 * 1. resolves the caller (bearer token or session cookie) into `req.auth`;
 * 2. rejects cross-origin mutating requests (403 forbidden_origin), except bearer-token calls;
 * 3. requires authentication except for the /api/auth/* routes (401 unauthorized), unless auth is disabled.
 */
export function createAuthHook(config: AppConfig, opts: AuthHookOptions = {}) {
  const enabled = isAuthEnabled(config);
  return async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isApiRequest(req)) return;

    const presentedToken = bearerToken(req) !== null;
    const limiter = enabled && presentedToken ? opts.tokenAttempts : undefined;
    if (limiter) {
      const state = await limiter(req, { increment: false });
      if (!state.isAllowed && state.remaining <= 0) {
        reply.header('retry-after', String(Math.max(state.ttlInSeconds, 1)));
        throw tooManyAttempts(state.ttlInSeconds);
      }
    }

    req.auth = resolveAuth(req, config);
    if (limiter && !req.auth) await limiter(req);
    if (!enabled && !req.auth) req.auth = { subject: 'anonymous', method: 'none' };

    if (MUTATING_METHODS.has(req.method) && req.auth?.method !== 'token') {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const given = normalizeOrigin(origin);
        const expected = expectedOrigin(req, config);
        if (!given || !expected || given !== expected) {
          // Operators need both values to fix PUBLIC_ORIGIN or the proxy's forwarded headers.
          req.log.warn({ origin: given ?? 'invalid', expectedOrigin: expected }, 'cross-origin request blocked');
          throw new HttpError(
            403,
            'forbidden_origin',
            'This request came from another website and was blocked. Open the app from its own address and try again.',
          );
        }
      }
    }

    if (!enabled) return;
    if (isPublicAuthRoute(req)) return;
    if (!req.auth) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
  };
}
