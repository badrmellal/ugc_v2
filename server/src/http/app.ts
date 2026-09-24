import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet, { type FastifyHelmetOptions } from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { AppContext } from '../app-context.js';
import type { AppConfig } from '../config.js';
import { createSecretScrubber } from '../logger.js';
import { LIMITS } from '../shared/api.js';
import { createAuthHook, isApiPath, isAuthEnabled } from './auth.js';
import { REAL_TURN_SECONDS } from './dto.js';
import { createErrorHandler, errorBody, HttpError } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerGenerationRoutes } from './routes/generations.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerPlanRoutes } from './routes/plan.js';
import type { LimitHook, RouteDeps } from './routes/types.js';

/** JSON bodies are small (scripts are capped at 4,000 chars); uploads go through multipart. */
export const JSON_BODY_LIMIT = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Reuses a well-formed upstream request id (load balancer / client), otherwise generates one. */
function requestIdFrom(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

const PROBE_PATHS = new Set(['/healthz', '/readyz']);

/**
 * One access-log line per request (Cloud Logging `httpRequest` format), none for health probes.
 * The "incoming request" line is demoted to debug to halve log volume.
 */
class AccessLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: (req: FastifyRequest) => PROBE_PATHS.has(pathOf(req.url)) });
  }

  override incomingRequest(request: FastifyRequest): void {
    if (this.isLogDisabled(request)) return;
    request.log.debug({ method: request.method, url: request.url }, 'incoming request');
  }

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    const status = reply.statusCode;
    const httpRequest = {
      requestMethod: request.method,
      requestUrl: request.url,
      status,
      latency: `${(reply.elapsedTime / 1000).toFixed(3)}s`,
      remoteIp: request.ip,
      userAgent: request.headers['user-agent'],
    };
    if (error) reply.log.error({ httpRequest, err: error }, 'request errored');
    else if (status >= 500) reply.log.error({ httpRequest }, 'request completed');
    else reply.log.info({ httpRequest }, 'request completed');
  }
}

/** Origins that serve presigned object URLs, so the SPA may load images/videos from them. */
export function storageOrigins(config: AppConfig): string[] {
  const s3 = config.storage.s3;
  if (config.storage.driver !== 's3' || !s3.presignedUrls || !s3.bucket) return [];
  const origins = new Set<string>();
  if (s3.endpoint) {
    try {
      const url = new URL(s3.endpoint);
      origins.add(url.origin);
      if (!s3.forcePathStyle) origins.add(`${url.protocol}//${s3.bucket}.${url.host}`);
    } catch {
      // Invalid endpoints are reported by the storage driver.
    }
  } else {
    const region = s3.region && s3.region !== 'auto' ? s3.region : 'us-east-1';
    origins.add(`https://${s3.bucket}.s3.${region}.amazonaws.com`);
    origins.add(`https://${s3.bucket}.s3.amazonaws.com`);
    origins.add(`https://s3.${region}.amazonaws.com`);
  }
  return [...origins];
}

export function helmetOptions(config: AppConfig): FastifyHelmetOptions {
  const storage = storageOrigins(config);
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...storage],
        mediaSrc: ["'self'", 'blob:', ...storage],
        connectSrc: ["'self'", ...storage],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    // Presigned media is served cross-origin; COEP would block it.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  };
}

/** The built SPA: WEB_DIST_DIR, else web/dist next to the server package, else ./web/dist or ./public. */
export function resolveWebDist(config: AppConfig): string | null {
  const candidates = config.webDistDir
    ? [resolve(config.webDistDir)]
    : [
        // src/http/app.ts and dist/http/app.js both sit three levels below the repository root.
        fileURLToPath(new URL('../../../web/dist/', import.meta.url)),
        resolve('web/dist'),
        fileURLToPath(new URL('../../public/', import.meta.url)),
        resolve('public'),
      ];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
}

function cacheControlFor(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/assets/')) return 'public, max-age=31536000, immutable';
  if (normalized.endsWith('/index.html')) return 'no-cache';
  return 'public, max-age=3600';
}

function acceptsHtml(req: FastifyRequest): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

/**
 * Rate-limit key. With TRUST_PROXY the left-most X-Forwarded-For entry is client controlled, so use
 * the address the nearest proxy saw (on Cloud Run: the address Google's front end appended).
 */
function rateLimitKey(config: AppConfig) {
  return (req: FastifyRequest): string => {
    const ips = req.ips;
    if (config.trustProxy && ips && ips.length > 1) return ips[1] ?? req.ip;
    return req.ip;
  };
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(seconds, 1)} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

type Limiter = (
  req: FastifyRequest,
) => Promise<{ isAllowed: true } | { isAllowed: false; isExceeded: boolean; ttlInSeconds: number }>;

function limiterHook(limiter: Limiter, what: string): LimitHook {
  return async (req, reply) => {
    const result = await limiter(req);
    if (result.isAllowed || !result.isExceeded) return;
    reply.header('retry-after', String(result.ttlInSeconds));
    throw new HttpError(429, 'rate_limited', `Too many ${what}. Try again in ${formatWait(result.ttlInSeconds)}.`);
  };
}

function baseFastify(ctx: AppContext): FastifyInstance {
  const app = Fastify({
    loggerInstance: ctx.logger,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: JSON_BODY_LIMIT,
    requestIdHeader: false,
    genReqId: requestIdFrom,
    logController: new AccessLogController(),
    return503OnClosing: true,
    keepAliveTimeout: 65_000,
  }) as unknown as FastifyInstance;

  app.setErrorHandler(createErrorHandler({ scrub: createSecretScrubber(ctx.config) }));
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  return app;
}

/** The full API + SPA server (`ROLE=web` and `ROLE=all`). */
export function buildApp(ctx: AppContext): FastifyInstance {
  const { config } = ctx;
  const app = baseFastify(ctx);
  const authEnabled = isAuthEnabled(config);

  // Accept an empty body with a JSON content type (e.g. POST /cancel from fetch with default headers).
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJson(req, text, done);
  });

  app.decorateRequest('auth', null);

  // Security headers and cookie parsing first: their onRequest hooks must run before the auth hook
  // (so rejected requests still carry security headers and the session cookie is parsed).
  app.register(helmet, helmetOptions(config));
  app.register(cookie);
  app.after(() => {
    app.addHook('onRequest', createAuthHook(config));
    app.addHook('onSend', async (req, reply, payload) => {
      // API responses are per-user and live: never cache them unless a route opted in.
      if (isApiPath(req.url) && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
      return payload;
    });
  });
  app.register(rateLimit, {
    global: true,
    max: config.rateLimit.perMinute,
    timeWindow: 60_000,
    // Only the API is rate limited; static assets and health probes are not.
    allowList: (req) => !isApiPath(req.url),
    keyGenerator: rateLimitKey(config),
    errorResponseBuilder: (_req, context) =>
      new HttpError(429, 'rate_limited', `Too many requests. Try again in ${context.after}.`),
  });
  app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: LIMITS.imageMaxBytes,
      files: 1,
      fields: 5,
      fieldSize: 64 * 1024,
      parts: 6,
      fieldNameSize: 100,
    },
  });

  const webDist = resolveWebDist(config);
  if (webDist) {
    app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      cacheControl: false,
      etag: true,
      lastModified: true,
      allowedPath: (pathName) => !isApiPath(pathName),
      setHeaders: (reply, filePath) => {
        reply.header('cache-control', cacheControlFor(filePath));
      },
    });
  } else if (config.role !== 'worker') {
    ctx.logger.warn('web build not found (set WEB_DIST_DIR or run the web build); serving the API only');
  }

  app.register(async (api) => {
    const deps: RouteDeps = {
      ctx,
      authEnabled,
      turnSeconds: config.gemini.mock ? Math.max(config.gemini.mockTurnSeconds, 1) : REAL_TURN_SECONDS,
      createLimit: limiterHook(
        api.createRateLimit({ max: config.rateLimit.createPerHour, timeWindow: HOUR_MS }),
        'video generations in the last hour',
      ),
      planLimit: limiterHook(
        api.createRateLimit({ max: config.rateLimit.createPerHour, timeWindow: HOUR_MS }),
        'script splits in the last hour',
      ),
    };
    registerHealthRoutes(api, ctx);
    registerAuthRoutes(api, deps);
    registerConfigRoutes(api, deps);
    registerPlanRoutes(api, deps);
    registerGenerationRoutes(api, deps);
    registerMediaRoutes(api, deps);
  });

  app.setNotFoundHandler((req, reply) => {
    const path = pathOf(req.url);
    const spaRoute = webDist && (req.method === 'GET' || req.method === 'HEAD') && !isApiPath(path) && acceptsHtml(req);
    if (spaRoute) {
      // Client-side routes (/g/123, /history...) are resolved by the SPA.
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply
      .code(404)
      .type('application/json; charset=utf-8')
      .send(errorBody('not_found', `No route for ${req.method} ${path}.`));
  });

  return app;
}

/**
 * `ROLE=worker`: Cloud Run and most orchestrators need a listening port, so the worker serves only
 * the liveness and readiness probes.
 */
export function buildHealthApp(ctx: AppContext): FastifyInstance {
  const app = baseFastify(ctx);
  registerHealthRoutes(app, ctx);
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(errorBody('not_found', 'This instance runs the job worker and serves no API.')),
  );
  return app;
}
